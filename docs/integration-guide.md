# Merchant Integration Guide

For a developer wiring PayFlux into a shop's backend. Every response below is **real output**
captured from a running instance, not an illustration.

> **Base URL** `http://localhost:4000/api/v1` for the default local stack.
> Replace with your deployment's host. If you changed `API_PORT` in `.env`, use that port.

---

## The two rules

Before anything else, two things that will save you a production incident.

### 1. Money is an integer in the currency's minor unit

`249900` means **₹2,499.00**. Not `2499.00`, not `"2499.00"`.

```
₹2,499.00  →  249900     (paise)
$19.99     →  1999       (cents)
```

Sending `249900.50` is rejected with a validation error. This is deliberate: `0.1 + 0.2` is not
`0.3` in floating-point arithmetic, and a ledger that drifts by a paisa fails reconciliation. Every
response also returns a preformatted `amount` string so you never have to divide by 100 yourself.

### 2. Every payment and refund needs an `Idempotency-Key`

Generate one per **logical operation** — typically per order, or per refund action. Reuse it on every
retry of that same operation.

```
order 88421 → "order-88421-attempt-1"     (a UUID is equally fine)
```

If the network drops and you retry, the same key returns the *original* result instead of charging
again. Without the header the request is rejected outright.

---

## Step 1 — Authenticate

```bash
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"merchant@nimbusretail.example","password":"PayFlux#2024"}'
```

```jsonc
{
  "success": true,
  "data": {
    "accessToken":  "eyJhbGciOiJIUzI1NiIs...",   // expires in 15 minutes
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",   // expires in 7 days
    "tokenType": "Bearer",
    "user": { "role": "MERCHANT", "merchant": { "merchantId": "mrch_GnXjjTFsQ6ToAfa7", ... } }
  }
}
```

Send the access token as `Authorization: Bearer <accessToken>` on every subsequent call.

**When it expires** (401 `TOKEN_EXPIRED`), exchange the refresh token:

```bash
curl -X POST http://localhost:4000/api/v1/auth/refresh \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'
```

Refresh **rotates** the pair — store both new tokens and discard the old ones. If several of your
requests hit a 401 at once, refresh **once** and replay them all with the new token; refreshing
concurrently will invalidate all but one of the results.

---

## Step 2 — Take a payment

```bash
curl -X POST http://localhost:4000/api/v1/payments \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-88421-attempt-1' \
  -d '{
    "amountMinor": 249900,
    "currency": "INR",
    "method": "CARD",
    "customer": {
      "customerId": "cust_88421",
      "email": "buyer@example.com",
      "contact": "+919876543210",
      "last4": "4242",
      "country": "IN"
    },
    "description": "Order #88421 — 2x Wireless Headphones",
    "notes": { "orderId": "88421", "channel": "web" }
  }'
```

**Real response (`201 Created`):**

```jsonc
{
  "success": true,
  "data": {
    "paymentId": "pay_ByIYp1Zxhqw3TYmuIKsv",
    "status": "SUCCESS",
    "amountMinor": 249900,
    "amount": "2499.00",          // preformatted for display
    "currency": "INR",
    "feeMinor": 4998,
    "fee": "49.98",               // your 2% platform fee
    "refundableMinor": 249900,
    "method": "CARD",
    "customer": { "customerId": "cust_88421", "last4": "4242", "network": "VISA", ... },
    "risk": { "score": 10, "decision": "ALLOW", "triggeredRules": ["MISSING_DEVICE_FINGERPRINT"] },
    "acquirer": { "referenceId": "acq_8c9984d92b7befb6dacf", "authCode": "58EB66" },
    "failure": null,
    "allowedTransitions": ["REFUNDED", "PARTIALLY_REFUNDED"],
    "createdAt": "2026-09-01T03:33:34.560Z"
  },
  "meta": { "correlationId": "cor_mti45cll85f77e149c1e", ... }
}
```

### Fields worth knowing

| Field | Why you care |
|---|---|
| `paymentId` | Store it against your order. Every later operation needs it. |
| `status` | The outcome. See the table below. |
| `refundableMinor` | How much can still be refunded. Recomputed after every refund. |
| `allowedTransitions` | What you may legally do next. **Drive your UI from this** rather than hard-coding rules — the server owns the state machine and this cannot drift from it. |
| `risk` | Why it was allowed or blocked. |
| `meta.correlationId` | Log it. Quoting it in a support ticket finds the entire request across every service. |

### What `customer.last4` is (and is not)

Only the **last four digits**. PayFlux never accepts, stores, or transmits a full card number — that
is what keeps you out of the heavy PCI-DSS tiers. Collect the card with a hosted field or a PSP
token; send PayFlux only the fragment.

---

## Step 3 — Handle every outcome

```js
const res = await createPayment(order);

switch (res.data.status) {
  case 'SUCCESS':
    return fulfilOrder(order, res.data.paymentId);

  case 'FAILED':
    // res.data.failure.code — INSUFFICIENT_FUNDS, CARD_EXPIRED, DO_NOT_HONOR,
    // INVALID_CVV, LIMIT_EXCEEDED, SUSPECTED_FRAUD
    return showDeclineMessage(res.data.failure);

  case 'PROCESSING':
    // We could not get a definitive answer from the card network.
    // Do NOT fulfil, and do NOT retry the charge — poll instead (step 4).
    return markPendingAndPoll(res.data.paymentId);
}
```

### Errors you must handle

| HTTP | `error.code` | What to do |
|---|---|---|
| 402 | `FRAUD_BLOCKED` | Blocked by risk scoring. Show a generic decline — never reveal the rules. |
| 409 | `IDEMPOTENT_REQUEST_IN_FLIGHT` | Your earlier identical request is still running. **Back off and retry the same key.** |
| 422 | `IDEMPOTENCY_KEY_REUSE` | You reused a key with a *different* body. A bug in your key generation. |
| 429 | `RATE_LIMITED` | Honour the `Retry-After` header. |
| 502/503 | `UPSTREAM_UNAVAILABLE`, `CIRCUIT_OPEN` | Card network trouble. Retry with backoff, **same key**. |

Any response carrying `x-retryable: true` is safe to retry with the same idempotency key. Anything
else will fail identically however often you try.

---

## Step 4 — Retrying safely

This is the whole point of the idempotency key. Send the **exact same request** again:

```bash
curl -X POST http://localhost:4000/api/v1/payments \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-88421-attempt-1' \    # ← same key
  -d '{ ...identical body... }'
```

**Real response:**

```
HTTP/1.1 201 Created
x-idempotent-replay: true
```
```
same paymentId: pay_ByIYp1Zxhqw3TYmuIKsv   status: SUCCESS
```

The same payment, not a second one. The customer is charged once.

### Verifying an indeterminate payment

If a payment came back `PROCESSING`, poll:

```bash
curl -X POST http://localhost:4000/api/v1/payments/pay_ByIYp1Zxhqw3TYmuIKsv/verify \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
```

This is safe to call repeatedly. It re-checks with the card network and resolves the payment to a
final state. Poll it with backoff rather than re-submitting the charge.

---

## Step 5 — Refunds

### Partial

```bash
curl -X POST http://localhost:4000/api/v1/payments/pay_ByIYp1Zxhqw3TYmuIKsv/refunds \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: refund-88421-partial' \
  -d '{"amountMinor":50000,"reason":"REQUESTED_BY_CUSTOMER","notes":"One item returned"}'
```

**Real response (`201 Created`):**

```jsonc
{
  "refundId": "rfnd_YBIUOp24qAQN2ZK4vGH5",
  "paymentId": "pay_ByIYp1Zxhqw3TYmuIKsv",
  "status": "SUCCESS",
  "amountMinor": 50000,
  "amount": "500.00",
  "isFullRefund": false,
  "reason": "REQUESTED_BY_CUSTOMER",
  "acquirerReferenceId": "acq_5e0a4c407fcb70929b27"
}
```

The payment afterwards:

```
status: PARTIALLY_REFUNDED   refunded: ₹500.00   still refundable: ₹1999.00
```

### Full

**Omit `amountMinor`** and the entire remaining balance is refunded:

```bash
-d '{"reason":"REQUESTED_BY_CUSTOMER"}'
```

### If you ask for too much

```jsonc
// 422
{ "error": {
    "code": "REFUND_EXCEEDS_BALANCE",
    "message": "Refund of 250000 exceeds the refundable balance of 199900",
    "details": { "requestedMinor": 250000, "availableMinor": 199900,
                 "alreadyCommittedMinor": 50000 } } }
```

`alreadyCommittedMinor` includes refunds that are still *in flight*, not just settled ones — so two
support agents clicking refund simultaneously cannot both succeed.

### Valid reasons

`REQUESTED_BY_CUSTOMER` · `DUPLICATE` · `FRAUDULENT` · `CHARGEBACK` · `MERCHANT_ERROR` · `OTHER`

---

## Step 6 — Cancelling

Only for payments that have **not yet been captured** (`PENDING` or `AUTHORIZED`):

```bash
curl -X POST http://localhost:4000/api/v1/payments/{paymentId}/cancel \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"Customer abandoned checkout"}'
```

Cancelling a captured payment returns `409 INVALID_STATE_TRANSITION` with both ends of the attempted
move. Use **refund** for captured payments — check `allowedTransitions` and you will never hit this.

---

## Step 7 — Receiving webhooks

Polling is fine for a single order. Webhooks are how you learn about everything else — refunds
completing, settlements paying out, disputes.

### Register an endpoint

```bash
curl -X POST http://localhost:4000/api/v1/webhooks/endpoints \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://your-shop.com/hooks/payflux","description":"Production"}'
```

The response contains `secret` — **shown exactly once and never retrievable again.** Store it in your
secret manager immediately.

> Production deployments reject `http://` URLs. This is enforced, not advisory.

### What actually arrives

Captured from a live delivery:

```
POST /hooks/payflux
content-type: application/json
x-payflux-signature: t=1788233905,v1=b8af7667a6b4cca9e2f6fbfe774ae5d878b2a04ed814caead61ab7e1356c59c1
x-payflux-event-id: evt_oB2lS62hbNHA4mKkgV1R
x-payflux-event-type: payment.succeeded
x-payflux-delivery-id: whdl_H0uuK0nolGQETO1EF8nN
x-payflux-attempt: 1
x-payflux-timestamp: 1788233905
user-agent: PayFlux-Webhooks/1.0
```

```json
{
  "createdAt": "2026-09-01T03:38:25.428Z",
  "data": {
    "amountMinor": 129900,
    "createdAt": "2026-09-01T03:38:25.116Z",
    "currency": "INR",
    "method": "CARD",
    "paymentId": "pay_ZjYQQto7ht6LuXgWiR51",
    "status": "SUCCESS"
  },
  "id": "evt_oB2lS62hbNHA4mKkgV1R",
  "type": "payment.succeeded"
}
```

### Verifying the signature

```js
const crypto = require('crypto');

app.post('/hooks/payflux',
  express.raw({ type: 'application/json' }),      // ← RAW body. See the warning below.
  (req, res) => {
    const sig = req.get('x-payflux-signature');
    const [t, v1] = sig.split(',').map(part => part.split('=')[1]);

    // 1. Reject stale timestamps — this is your replay window.
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return res.sendStatus(401);

    // 2. Recompute the HMAC over "{timestamp}.{rawBody}".
    const expected = crypto
      .createHmac('sha256', process.env.PAYFLUX_WEBHOOK_SECRET)
      .update(`${t}.${req.body}`)
      .digest('hex');

    // 3. Constant-time compare — a plain === leaks timing information.
    const a = Buffer.from(expected), b = Buffer.from(v1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);

    const event = JSON.parse(req.body);

    // 4. Deduplicate. We guarantee at-least-once; you make it effectively-once.
    if (await alreadyProcessed(event.id)) return res.sendStatus(200);

    // 5. Acknowledge FAST, then process asynchronously.
    res.sendStatus(200);
    await queue.add('payflux-event', event);
  });
```

> ⚠️ **Verify the raw bytes.** If your framework parses JSON before you compute the HMAC, and you
> re-serialise the object to verify, the bytes will differ and the signature will never match. This
> is the single most common webhook integration failure. In Express use `express.raw()` on this route
> — note it must be mounted *before* any global `express.json()`.

### Retry behaviour

Return a `2xx` quickly. If you don't:

| Your response | What we do |
|---|---|
| `2xx` | Delivered. Done. |
| `5xx`, timeout, connection refused | Retry: **10s → 1m → 5m → 30m → 2h → 6h**, then dead-letter |
| `429` | Same retry ladder |
| `4xx` (other) | **Dead-lettered immediately** — retrying an unchanged body won't help |
| `410 Gone` | Dead-lettered immediately; we take it as "stop sending" |

After repeated consecutive failures your endpoint is **auto-disabled** so a dead URL stops consuming
delivery capacity. Re-enable it from the console once fixed; that clears the failure count.

### Event types

`payment.created` · `payment.authorized` · `payment.succeeded` · `payment.failed` ·
`payment.cancelled` · `refund.initiated` · `refund.succeeded` · `refund.failed` ·
`settlement.created` · `settlement.completed` · `fraud.blocked` · `invoice.generated`

Subscribe to specific types with `subscribedEvents`, or leave it empty to receive everything.

---

## Step 8 — Reconciling your own books

```bash
# Your money currently held by the platform
curl "http://localhost:4000/api/v1/ledger/balance?currency=INR" -H "authorization: Bearer $TOKEN"

# Chronological feed of payments, refunds, fees and settlements
curl "http://localhost:4000/api/v1/transactions?limit=50" -H "authorization: Bearer $TOKEN"

# Payout batches
curl "http://localhost:4000/api/v1/settlements" -H "authorization: Bearer $TOKEN"
```

A settlement shows exactly how the payout was derived:

```
gross ₹45,231.00  −  refunds ₹2,100.00  −  fees ₹904.62  =  net ₹42,226.38
```

---

## Reference implementation

```js
class PayFluxClient {
  constructor({ baseUrl, email, password }) {
    Object.assign(this, { baseUrl, email, password });
    this.token = null;
  }

  async #auth() {
    if (this.token) return this.token;
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    const body = await res.json();
    this.token = body.data.accessToken;
    this.refreshToken = body.data.refreshToken;
    return this.token;
  }

  async #request(method, path, body, idempotencyKey, retries = 3) {
    const token = await this.#auth();
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();

    // Expired token: re-authenticate once and replay.
    if (res.status === 401 && retries > 0) {
      this.token = null;
      return this.#request(method, path, body, idempotencyKey, retries - 1);
    }

    // Retryable: back off and replay with the SAME idempotency key, which is
    // what makes this safe.
    if (res.headers.get('x-retryable') === 'true' && retries > 0) {
      await new Promise(r => setTimeout(r, (4 - retries) * 1000 + Math.random() * 500));
      return this.#request(method, path, body, idempotencyKey, retries - 1);
    }

    if (!json.success) {
      const err = new Error(json.error.message);
      Object.assign(err, { code: json.error.code, details: json.error.details,
                           correlationId: json.meta?.correlationId });
      throw err;
    }
    return json.data;
  }

  createPayment(order) {
    return this.#request('POST', '/payments', {
      amountMinor: order.totalPaise,          // integer minor units
      currency: 'INR',
      method: order.method,
      customer: { customerId: order.customerId, email: order.email, country: 'IN' },
      description: `Order #${order.id}`,
      notes: { orderId: String(order.id) },
    }, `order-${order.id}`);                  // one key per order
  }

  getPayment(id)          { return this.#request('GET',  `/payments/${id}`); }
  verifyPayment(id)       { return this.#request('POST', `/payments/${id}/verify`, {}); }

  refund(paymentId, amountMinor, reason = 'REQUESTED_BY_CUSTOMER') {
    return this.#request('POST', `/payments/${paymentId}/refunds`,
      { amountMinor, reason },
      `refund-${paymentId}-${amountMinor ?? 'full'}`);
  }
}
```

---

## Testing your integration

The bundled acquirer simulator is **deterministic** — the outcome is derived from the payment id, so
the same id always produces the same result. Create a handful of payments and you will reliably see
successes, declines with varied reason codes, and occasional network failures, which is exactly the
mix you need to exercise every branch of your integration.

Checklist before you go live:

- [ ] Idempotency key generated **per order**, reused on every retry of that order
- [ ] All three of `SUCCESS`, `FAILED` and `PROCESSING` handled
- [ ] `PROCESSING` polls `/verify` — it never re-submits the charge
- [ ] Retries triggered by `x-retryable: true`, never by status code alone
- [ ] Webhook signature verified against the **raw** body
- [ ] Webhook handler deduplicates on `event.id`
- [ ] Webhook returns `2xx` **before** doing slow work
- [ ] `correlationId` logged on every failure
- [ ] Amounts are integer minor units everywhere — no floats touch money

---

## Interactive reference

Full machine-readable API documentation with a live "try it" console:
**http://localhost:4000/api/docs**
