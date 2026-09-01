# Resume Material

## The three bullets

Ordered so a recruiter reading only the first still gets the strongest signal.

> **• Architected idempotent payment APIs backed by Redis distributed locking and MongoDB
> compare-and-swap transitions, eliminating duplicate charges under high-concurrency retry —
> verified at 12 simultaneous requests on a single idempotency key resolving to exactly one charge.**

> **• Engineered an asynchronous settlement and webhook pipeline on BullMQ with exponential-backoff
> retries, jittered scheduling and a replayable dead-letter queue, making every consumer idempotent
> so at-least-once delivery could not double-post financial events.**

> **• Built a double-entry transaction ledger with immutable append-only entries, automated
> reconciliation and a rule-based fraud engine, proving financial correctness across 450+ ledger
> entries (debits = credits, assets = liabilities + revenue − expenses) and surfacing it through a
> real-time Angular analytics console.**

### Compact variant (single-line, for a dense résumé)

> • Architected idempotent payment APIs with Redis distributed locking and DB-level CAS, eliminating
> duplicate charges under concurrent retry (12 simultaneous requests → 1 charge).
>
> • Designed an async settlement pipeline on BullMQ with exponential-backoff retries and a
> dead-letter queue, with idempotent consumers guaranteeing safe at-least-once delivery.
>
> • Developed a double-entry ledger with automated reconciliation and a rule-based fraud engine,
> exposed through a real-time Angular dashboard for financial and operational visibility.

### Why these are phrased this way

Each bullet is **mechanism → outcome → evidence**. "Used Redis for locking" is a tool list;
"eliminating duplicate charges under high-concurrency retry, verified at 12 requests → 1 charge" is
an engineering claim with a measurement attached. The numbers are real measurements from this
codebase, not estimates — which matters, because an interviewer will ask.

---

## Project summary (ATS-friendly)

**PayFlux — Distributed Payment Gateway** · *Node.js, Express, MongoDB, Redis, BullMQ, Angular,
Docker*

> Designed and built a production-grade payment orchestration platform handling the payment
> lifecycle end to end: authorization, capture, partial and full refunds, cancellation, batched
> settlement and reconciliation. Implemented idempotent APIs using Redis distributed locks with
> Lua-scripted compare-and-delete release semantics, layered over MongoDB unique indexes and
> compare-and-swap state transitions, so duplicate charges are structurally impossible even when the
> lock is lost. Built a double-entry accounting ledger with immutable entries, deterministic journal
> idempotency keys and automated reconciliation reporting. Engineered an asynchronous event pipeline
> on BullMQ across seven queues with per-queue retry policies, exponential backoff with jitter and a
> replayable dead-letter queue. Added a rule-based fraud engine (12 weighted rules: velocity, IP and
> country mismatch, card-testing patterns, sanctioned jurisdictions) producing a 0–100 risk score
> with allow/review/block thresholds. Secured with JWT authentication, role-based access control
> across three roles, tenant isolation enforced at the data layer, NoSQL-injection sanitization,
> Redis-backed distributed rate limiting and HMAC-signed webhooks with replay protection. Delivered
> a real-time Angular 17 operations console with live analytics, hand-built SVG charts, search,
> filtering and pagination. Containerized with Docker Compose; 124 automated tests covering unit and
> integration paths against real MongoDB and Redis.

### Keyword coverage

`Node.js` `Express.js` `MongoDB` `Mongoose` `Redis` `BullMQ` `Angular` `TypeScript` `RxJS` `Docker`
`Docker Compose` `Nginx` `REST API` `Microservices` `Distributed Systems` `Idempotency`
`Distributed Locking` `Message Queues` `Event-Driven Architecture` `Double-Entry Accounting`
`Financial Reconciliation` `Fraud Detection` `Circuit Breaker` `Rate Limiting` `JWT` `RBAC`
`OAuth-style token refresh` `Webhooks` `HMAC` `Payment Gateway` `Fintech` `Jest` `Supertest`
`Prometheus` `Structured Logging` `CI/CD-ready` `Repository Pattern` `Dependency Injection`
`Clean Architecture` `Graceful Shutdown` `Horizontal Scaling` `High Availability`

---

## Interview preparation

Expect these. The answers are the actual design decisions, and every one has a "why" behind it.

### "Walk me through what happens when a client retries a payment."

Redis `SET NX` on `idem:{merchant}:{endpoint}:{key}` — atomic, so exactly one caller wins even
across replicas. The winner executes; everyone else gets `409 IDEMPOTENT_REQUEST_IN_FLIGHT` with
`x-retryable: true`. On completion the response is stored in both Redis and MongoDB, and subsequent
retries replay it verbatim with `x-idempotent-replay: true`.

The follow-up is always *"what if Redis is down?"* — and the answer is the point: Redis is a cache,
so there is a MongoDB unique index on `(merchant, endpoint, key)` behind it. Correctness survives a
`FLUSHALL`; only the latency benefit is lost.

### "Your Redis lock — is it actually safe?"

No, not on its own, and I would not claim otherwise. Under a primary failover with unreplicated
writes, or a GC pause longer than the TTL, two holders are possible. That is why every critical
section it guards is *also* protected by a database invariant: a CAS filter on the expected status,
or a unique index on the journal key. The lock prevents the race in the common case; the database
makes a lost lock non-catastrophic.

I would also point at the release script — a plain `DEL` is a real bug. If A's lock expires mid-work
and B acquires it, A's `DEL` deletes **B's** lock and mutual exclusion breaks silently. The Lua
compare-and-delete prevents that, and there is an integration test for exactly that sequence.

### "Why double-entry instead of a balance column?"

A single `balance` column cannot answer *why* it is what it is, and it cannot be audited.
Double-entry records every movement as a balanced pair, so `Σ debits = Σ credits` is an invariant
that is *checkable*. That is the difference between books that are provable and books that are
merely plausible. Reconciliation recomputes every balance from the immutable entry stream and
reports drift — it deliberately never repairs, because auto-correcting money turns a bug into a
cover-up.

### "How do you handle at-least-once delivery?"

You do not fight it — you make consumers idempotent. Exactly-once is not something a queue can give
you. The ledger uses a deterministic journal key (`payment.capture:<paymentId>`) behind a unique
index, so a redelivered job returns the original journal. Webhooks use a unique `(eventId,
endpoint)` index; a duplicate insert is a no-op, not an error. Settlements use a deterministic batch
key per `(merchant, currency, window)`.

Worth mentioning honestly: an early version used `:` inside BullMQ job ids, which BullMQ rejects —
and because `queue.add()` rejects *asynchronously*, the producer failed silently and the entire
async pipeline was dead with zero jobs processed. It was caught by checking queue depth against
expected throughput, which is exactly why the queue-depth gauge exists.

### "The acquirer goes down mid-authorization. What happens?"

The payment stays `PROCESSING`. It is **not** marked failed — the authorization may have succeeded
upstream, and declaring it failed would strand a real charge with no record. A reconciliation
scheduler re-drives stale `PROCESSING` payments every five minutes, under a lock, and resolves them.
If the acquirer is still unreachable it stays `PROCESSING`, because guessing at an outcome you
cannot observe is how money goes missing.

Meanwhile the circuit breaker opens after five consecutive transport failures, so we fail fast
instead of exhausting our own connection pool against a dead dependency. Card declines deliberately
do **not** count against the circuit — a decline is a valid answer from a healthy dependency, and
counting it would open the circuit because customers had no money.

### "How do you prevent over-refunding?"

Three layers. A distributed lock serialises refunds per payment. Eligibility counts *committed*
refunds including `PENDING` and `PROCESSING`, so an in-flight refund reserves its amount. And the
actual write is a conditional update with `$expr: { $lte: [{ $add: ['$amountRefundedMinor',
amount] }, '$amountMinor'] }` — the database itself refuses the write.

Layer three is the guarantee; one and two exist so the common case returns a clean, informative
error rather than a lost race. Tested with six concurrent refunds against a payment that can only
support three.

### "Why is money an integer?"

Because `0.1 + 0.2 !== 0.3` in IEEE-754, and a ledger that drifts by a cent fails reconciliation.
Everything is minor units — paise, cents. Parsing never touches floating point on the fractional
part. Fee splitting derives `net` by subtraction rather than rounding both halves independently, so
`fee + net === amount` is exact by construction, not by luck.

### "How would you scale this to 10× traffic?"

The API is stateless, so add replicas. Workers are separate containers and scale independently on
queue depth — which is why they are separate in the first place. Reads are served by compound
indexes matching the exact access patterns, `$facet` collapses six dashboard queries into one, and a
30-second analytics cache with single-flight collapses N concurrent viewers into one database read.

The bottleneck I would expect first is ledger write contention on the merchant payable account,
which is exactly why that worker's concurrency is capped at 4 — more parallelism there buys write
conflicts, not throughput. The fix at real scale is per-merchant sharding of the payable account, or
batching postings within a time window.

---

## Portfolio presentation

**One-line pitch:** *A payment gateway built around the failure modes that actually matter —
duplicate charges under retry, over-refunds under concurrency, and provable financial correctness.*

**What to show, in order:**

1. The dashboard, live, with real seeded data — 420 payments, charts, success rate, queue depth.
2. `docs/sequence-diagrams.md` §2 — the concurrent-retry diagram. Then run the burst live and show
   12 requests producing one charge.
3. The ledger page — trial balance, debits equal to credits, the accounting identity holding, a
   clean reconciliation report.
4. `docs/architecture.md` §10 "Deliberate limitations" — being able to articulate what your system
   *does not* do is a stronger signal than any feature list.
