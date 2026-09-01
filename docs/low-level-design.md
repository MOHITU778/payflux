# Low-Level Design

Implementation detail for the parts where the reasoning is not obvious from the code.

---

## 1. Money representation

**Every amount is an integer in the currency's minor unit.** Never a float, never a decimal string in the database.

```js
// 0.1 + 0.2 === 0.30000000000000004
// A ledger that drifts by a cent fails reconciliation.
money.fromMajor('0.10', 'USD') + money.fromMajor('0.20', 'USD')
  === money.fromMajor('0.30', 'USD');   // 10 + 20 === 30  ✓
```

Parsing never touches floating point on the fractional part — the string is split on the decimal point and the fraction is zero-padded to the currency exponent:

```js
const [whole, fraction = ''] = text.split('.');
const minor = Number(whole + fraction.padEnd(exponent, '0'));
```

### Fee splitting must not lose a unit

```js
function splitByBps(minor, bps) {
  const fee = Math.round((minor * bps) / 10000);
  return { fee, net: minor - fee };   // net is derived, never rounded separately
}
```

Rounding both halves independently would let `fee + net ≠ amount` for awkward inputs. Deriving `net` by subtraction makes the identity exact by construction. Unit-tested across `[10001, 3333, 99999, 1, 7, 123457]` at 235 bps.

---

## 2. Distributed lock

### Acquire

```js
SET payflux:lock:payment:pay_abc <random-token> PX 10000 NX
```

Atomic. Exactly one caller creates the key. The TTL guarantees deadlock freedom: a crashed holder's lock expires.

### Release — why a plain DEL is a bug

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

Consider: A acquires with a 10s TTL. A's critical section runs 12s. The lock expires at 10s. B acquires it. At 12s, A finishes and calls `DEL`. **Without the token comparison, A deletes B's lock** and two holders now run concurrently — mutual exclusion is silently broken, and nothing logs an error.

The token is `crypto.randomBytes(16)`, not a counter: a guessable token would let one caller release another's lock deliberately.

There is a dedicated integration test for exactly this sequence.

### Jittered retry

```js
await sleep(retryDelayMs + Math.floor(Math.random() * retryJitterMs));
```

Without jitter, several replicas waiting on the same payment wake at the same millisecond and collide again — converting contention into a retry storm.

### `withLock` is the only API callers should use

```js
try { return await fn(lock); }
finally { await this.release(lock); }
```

A manual acquire/release pair leaks the lock the first time someone adds an early `return` or an exception path to the body. Tested: a throwing critical section still releases.

---

## 3. Compare-and-swap state transitions

```js
updateOne(
  { paymentId, status: { $in: expectedStatuses } },   // ← the assertion
  { $set: { status: newStatus }, $push: { stateHistory: transition } },
)
```

The filter asserts the expected current status. Two workers racing to mark the same payment `SUCCESS` produce exactly one winner; the loser's filter no longer matches and it receives `null`.

This is the database-level complement to the Redis lock. The lock prevents the race in the common case; **the CAS makes a lost lock non-catastrophic.** Every caller checks for `null` and re-reads rather than assuming success.

### Conditional refund application

```js
updateOne(
  { paymentId,
    status: { $in: [SUCCESS, PARTIALLY_REFUNDED] },
    $expr: { $lte: [{ $add: ['$amountRefundedMinor', amount] }, '$amountMinor'] } },
  [{ $set: {
      amountRefundedMinor: { $add: ['$amountRefundedMinor', amount] },
      status: { $cond: [ /* full? */ REFUNDED : PARTIALLY_REFUNDED ] },
  } }],
)
```

An aggregation-pipeline update, so the new value is computed **server-side from the current document**. A read-modify-write in application code would have a window between the read and the write; this has none. The `$expr` guard means the database itself refuses to over-refund.

---

## 4. Idempotency: why two stores

| | Redis alone | Mongo alone | Both |
|---|---|---|---|
| Latency | Fast | A write on every request's hot path | Fast |
| Survives eviction | **No** | Yes | Yes |
| Survives `FLUSHALL` | **No** | Yes | Yes |

Redis is the fast path and holds the in-flight claim. MongoDB's unique index on `(merchant, endpoint, key)` is the guarantee. If Redis is unavailable the system still cannot double-charge; it just loses the latency benefit.

### Response capture

`res.json` is wrapped so the outgoing body is intercepted at the moment it is sent — the only place the *final* response is known, since a controller may transform it and the error middleware may replace it entirely.

```js
const originalJson = res.json.bind(res);
res.json = (body) => {
  const reproducible = res.statusCode < 500;
  (reproducible ? complete(scope, { status, body }) : release(scope))
    .catch(logFailure);          // never block the response
  return originalJson(body);
};
```

**What gets stored and why:**

- **2xx** — success. Replay it.
- **4xx from an `AppError`** — a deliberate business rejection (fraud block, invalid state). This is a *reproducible answer*, so it is stored. Releasing the key here would let a client retry a blocked payment indefinitely and eventually slip through on a scoring boundary.
- **5xx** — unexpected. The key is **released** so the client's retry can actually execute rather than being handed a stale failure for 24 hours.

An aborted connection (`res.on('close')` before `res.json`) also releases the claim, so a socket hang-up cannot wedge a key.

### Fingerprinting

```js
fingerprint = sha256(stableStringify(body))   // keys sorted recursively
```

Without key sorting, `{a:1,b:2}` and `{b:2,a:1}` — semantically identical retries from a client that iterates a hash map — would produce different fingerprints and be rejected as key reuse.

---

## 5. Double-entry posting

```js
// Guard 1: the accounting identity, checked BEFORE any write.
if (totalDebit !== totalCredit) throw new BusinessRuleError('Unbalanced journal');

// Guard 2: idempotent replay.
const existing = await findJournalByIdempotencyKey(key);
if (existing) return { journal: existing, replayed: true };

// Then, per leg:
const account = await ensureAccount(leg.account, session);      // upsert, race-safe
const updated = await applyToAccount(account._id, leg, session); // atomic $inc, post-image
entries.push({ ..., balanceAfterMinor: updated.balanceMinor,
                    sequence: updated.entrySequence });
```

Three details carry the design:

1. **The balance guard runs before any write**, so an unbalanced journal can never touch an account. Verified by a test that asserts the account balance is unchanged after a rejected posting.
2. **`ensureAccount` is an upsert with `$setOnInsert`.** Two requests racing to create the same merchant account produce one document; a find-then-create would leave a duplicate-key window.
3. **`applyToAccount` returns the post-image** (`new: true`), which is exactly the `balanceAfterMinor` and `sequence` the immutable entry records. Reading the balance in a separate query would be a race — this is why the running balance can be trusted as a statement line.

### Immutability enforcement

```js
ledgerEntrySchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('Ledger entries are immutable'));
  next();
});
for (const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne']) {
  ledgerEntrySchema.pre(op, (next) => next(new Error(`'${op}' is not permitted`)));
}
```

The document hook alone is insufficient — query-level updates bypass document middleware entirely. Both are needed. (This guard fired during development when the seed script tried to `deleteMany` the collection, which is exactly the behaviour intended.)

### Reconciliation reports, never repairs

```js
if (recomputed.balanceMinor !== account.balanceMinor) {
  discrepancies.push({ kind: 'BALANCE_DRIFT', deltaMinor, ... });
}
```

Auto-correcting money is how a bug becomes a cover-up. A human decides, and the correction is posted as a visible reversing journal. Tested: injected drift is detected, reported, and **left in place**.

---

## 6. Circuit breaker: the half-open subtlety

```js
const isProbe = this.state === HALF_OPEN;
if (isProbe) this.halfOpenCalls += 1;
try { ... } finally {
  if (isProbe) this.halfOpenCalls = Math.max(0, this.halfOpenCalls - 1);
}
```

`halfOpenCalls` counts probes **in flight**. An early implementation incremented it without ever decrementing, which pinned the breaker half-open forever whenever `successThreshold > halfOpenMaxCalls` — the circuit could open but never close again. There is now a regression test for exactly that configuration.

The other non-obvious rule: **a 4xx does not count against the circuit.**

```js
isFailure: (err) => !(err.status >= 400 && err.status < 500)
```

A card decline is a *valid answer* from a healthy dependency. Counting it would open the circuit because customers had no money.

---

## 7. Correlation context

`AsyncLocalStorage` rather than passing `ctx` through every signature:

```js
requestContext.run({ correlationId, requestId }, () => next());
```

The store survives `await` boundaries, so an id set in Express middleware is readable inside a Mongo callback three services down. A winston format injects it into every record, so a log line is traceable even when the author forgot to add it.

Queue producers copy the id into the job payload; the worker wrapper restores it. That is why a webhook retry six hours later logs the same correlation id as the original HTTP request.

---

## 8. Aggregation strategy

**`$facet`** runs independent sub-aggregations over one pass of the same matched set — six dashboard tiles for the cost of one query instead of six.

**`$dateTrunc`** buckets the time series server-side. Shipping a month of raw payments to Node just to group them would be slow and memory-unbounded.

**Bucket granularity follows the window** (`≤2 days → hourly`, otherwise daily). Hourly buckets over 90 days would return 2,160 points, which no chart can render usefully.

**Anchored regex only.** `TransactionRepository.search` uses `^term`; an unanchored `.*term.*` cannot use an index and degrades into a collection scan as the feed grows. User input is escaped before it becomes part of a `RegExp` (ReDoS protection).

---

## 9. Frontend details worth noting

**Token refresh under concurrency.** A dashboard fires six requests at once and the access token expires. Without coordination all six call `/auth/refresh`; because refresh *rotates* the token, five present an already-rotated token and fail — logging the user out mid-session. A module-level `refreshing` flag plus a `BehaviorSubject` means the first 401 performs the refresh while the others queue and replay.

**Charts are hand-built inline SVG.** No charting library, for three reasons in order: the marks reference the same CSS custom properties as the rest of the console (so a theme switch is free), a general-purpose library is 150–400 kB for three chart types, and axis "nice" rounding and accessible fallbacks are decisions worth owning. Each chart also renders a visually-hidden data table so the information is available to a screen reader.

**Actions are derived from `allowedTransitions`,** which the server computes from the state machine it enforces. The UI never hard-codes "you can refund a SUCCESS payment" — the rules cannot drift.

**Search is debounced 350 ms.** A query per keystroke issues a request for every prefix of what the user types, mostly for results nobody will see.
