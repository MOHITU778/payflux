# Sequence Diagrams

## 1. Create payment — the happy path

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as Express API
    participant R as Redis
    participant M as MongoDB
    participant F as Fraud engine
    participant A as Acquirer
    participant Q as BullMQ

    C->>API: POST /payments<br/>Idempotency-Key: idem-abc
    API->>API: correlationId → AsyncLocalStorage
    API->>R: SET idem:{m}:{ep}:{key} NX EX 86400
    R-->>API: OK (claim won)
    API->>M: insert idempotency_record (unique index)

    Note over API,F: Risk is scored BEFORE the acquirer sees anything
    API->>F: evaluate(merchant, attempt)
    F->>R: INCR velocity counters (O(1))
    F->>M: recent declines for this customer
    F-->>API: { score: 12, decision: ALLOW }

    Note over API,M: Persist BEFORE money moves.<br/>A crash after authorising but before persisting<br/>would strand a real charge.
    API->>M: insert payment (status PENDING)

    API->>M: CAS PENDING → PROCESSING
    M-->>API: updated (a concurrent duplicate loses here)

    API->>A: authorize(amount, currency, method)
    A-->>API: approved, authCode D1CF39

    API->>M: CAS PROCESSING → SUCCESS<br/>+ push stateHistory
    M-->>API: updated

    par Async pipeline — fire and forget
        API->>Q: ledger.payment.capture
        API->>Q: payment.succeeded
    end

    API->>R: store response for replay
    API->>M: idempotency_record → COMPLETED
    API-->>C: 201 { paymentId, status: SUCCESS, ... }

    Note over Q: Workers now post the ledger journal,<br/>project the transaction feed, fan out webhooks,<br/>generate the invoice and send notifications.
```

**Why persist before authorising:** if the process dies between step 12 and 14, the worst case is a payment stuck in `PROCESSING` that the reconciliation sweeper resolves. If we authorised first, the worst case would be a real charge with no record of it — unrecoverable.

---

## 2. Idempotent retry — 12 concurrent requests, one key

```mermaid
sequenceDiagram
    autonumber
    participant C1 as Request 1
    participant C2 as Requests 2–12
    participant API as API replicas
    participant R as Redis
    participant M as MongoDB

    par All 12 arrive simultaneously
        C1->>API: POST /payments (key K)
    and
        C2->>API: POST /payments (key K)
    end

    API->>R: SET idem:K NX  (×12)
    R-->>API: OK  → request 1 only
    R-->>API: nil → requests 2–12

    Note over R: SET NX is atomic.<br/>Exactly one caller can create the key,<br/>even across replicas.

    API-->>C2: 409 IDEMPOTENT_REQUEST_IN_FLIGHT<br/>x-retryable: true
    API->>M: … request 1 executes the charge …
    API->>R: store response, state COMPLETED
    API-->>C1: 201 { paymentId: pay_OMPF… }

    Note over C2: On backoff-and-retry, requests 2–12 now<br/>read state COMPLETED and receive the SAME<br/>stored response with x-idempotent-replay: true

    C2->>API: retry (key K)
    API->>R: GET idem:K → COMPLETED
    API-->>C2: 201 { paymentId: pay_OMPF… } (replayed)
```

**Measured:** 12 concurrent requests → 1 × `201`, 11 × `409`, exactly **one** row in the database.

If the retry carries a *different* body, the stored `requestFingerprint` (SHA-256 over a key-sorted canonical form) will not match and the API returns `422 IDEMPOTENCY_KEY_REUSE` — replaying a stored response for a different request would confirm a payment the caller never made.

---

## 3. Refund — three layers against over-refunding

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as API
    participant L as Redis lock
    participant M as MongoDB
    participant A as Acquirer

    C->>API: POST /payments/{id}/refunds { amountMinor: 70000 }

    rect rgb(28,34,46)
        Note over API,L: Layer 1 — serialise refunds for this payment
        API->>L: SET lock:payment:{id} token PX 10000 NX
        L-->>API: acquired
    end

    API->>M: load payment (status, amountMinor)

    rect rgb(28,34,46)
        Note over API,M: Layer 2 — committed refunds reserve their amount.<br/>PENDING and PROCESSING refunds count, because<br/>an in-flight refund has already claimed the funds.
        API->>M: SUM(amountMinor) WHERE status ≠ FAILED
        M-->>API: committed = 40000 → available = 60000
    end

    alt requested > available
        API-->>C: 422 REFUND_EXCEEDS_BALANCE<br/>{ requested: 70000, available: 60000 }
    else within balance
        API->>M: insert refund (PENDING)
        API->>A: refund(amount)
        A-->>API: accepted

        rect rgb(28,34,46)
            Note over API,M: Layer 3 — the database itself refuses to over-refund
            API->>M: updateOne({ paymentId,<br/>  status ∈ {SUCCESS, PARTIALLY_REFUNDED},<br/>  $expr: amountRefunded + amt ≤ amountMinor })
            alt matched
                M-->>API: PARTIALLY_REFUNDED / REFUNDED
                API->>M: refund → SUCCESS
            else no match — would breach the cap
                M-->>API: null
                API->>M: refund → FAILED (REFUND_LIMIT_BREACHED)
            end
        end
    end

    API->>L: releaseLock (Lua compare-and-delete)
```

Layer 3 is the guarantee. Layers 1 and 2 exist so the common case returns a clean, informative error instead of a lost race.

**Measured:** six concurrent ₹300 refunds against a ₹1,000 payment → at most three succeed; `amountRefundedMinor ≤ amountMinor` always holds.

---

## 4. Webhook delivery with retries and dead-lettering

```mermaid
sequenceDiagram
    autonumber
    participant W as payment-events worker
    participant M as MongoDB (outbox)
    participant Q as webhook-dispatch
    participant D as Dispatch worker
    participant E as Merchant endpoint
    participant DLQ as Dead-letter queue

    W->>M: find active endpoints subscribed to event
    loop per endpoint
        W->>M: insert delivery (unique on eventId+endpoint)
        alt duplicate — already queued
            M-->>W: E11000 → skip, not an error
        else new
            W->>Q: dispatchWebhook(deliveryId, attempt 1)
        end
    end

    Q->>D: job
    D->>M: load delivery + endpoint secret
    D->>D: body = canonical JSON<br/>sig = HMAC-SHA256(secret, "{ts}.{body}")
    D->>E: POST body<br/>x-payflux-signature: t=…,v1=…<br/>x-payflux-event-id, x-payflux-attempt

    alt 2xx
        E-->>D: 200
        D->>M: status DELIVERED, reset endpoint failure streak
    else 4xx (not 429) or 410 Gone
        E-->>D: 400
        Note over D: Permanent. Retrying an unchanged payload<br/>against a 400 forever wastes capacity and<br/>hides a real integration bug.
        D->>M: status DEAD_LETTERED
        D->>DLQ: preserve payload + error
    else 5xx, 429, timeout
        E-->>D: 503
        D->>M: status RETRYING, nextAttemptAt = now + delay
        D->>Q: re-enqueue with delay
        Note over Q: Ladder 10s → 1m → 5m → 30m → 2h → 6h<br/>(±10% jitter, so a recovering merchant is not<br/>hit by every queued delivery at once)
    end

    Note over D,M: After N consecutive failures the endpoint<br/>auto-disables, so a dead URL stops consuming<br/>dispatcher capacity.
```

The delivery row is written **before** any HTTP is attempted (transactional outbox). If the process dies mid-dispatch, the row is still there and the retry sweeper finds it — an event held only in memory would vanish with the pod.

---

## 5. Settlement — build and payout

```mermaid
sequenceDiagram
    autonumber
    participant S as Scheduler (every 6h)
    participant L as Redis lock
    participant Q as settlement queue
    participant W as Settlement worker
    participant M as MongoDB
    participant A as Bank rail
    participant LG as ledger queue

    Note over S,L: Every API replica ticks; one wins the lock.<br/>Poor-man's leader election.
    S->>L: SET lock:scheduler:settlement-sweep NX
    L-->>S: acquired (other replicas skip)

    S->>M: merchants with autoSettle
    loop per merchant
        S->>Q: settlement.build(merchantId, currency)
    end

    Q->>W: build job
    W->>L: lock settlement:{merchant}:{currency}
    W->>M: batchKey = {merchant}:{currency}:{hour}
    alt batch already exists
        M-->>W: return it — never pay a window twice
    else new window
        W->>M: payments WHERE status=SUCCESS<br/>AND settlement=null<br/>AND completedAt ≤ now − holdHours
        W->>W: net = gross − refunds − fees
        W->>M: insert settlement (QUEUED)
        W->>M: claim payments<br/>(filter settlement:null — un-stealable)
        W->>Q: settlement.execute
    end

    Q->>W: execute job
    W->>M: CAS QUEUED → PROCESSING
    W->>A: payout(net)
    alt success
        A-->>W: reference
        W->>M: CAS PROCESSING → SETTLED
        W->>LG: ledger.settlement.payout
        Note over LG: DEBIT merchant_payable (liability discharged)<br/>CREDIT gateway_clearing (funds leave)
    else failure
        W->>M: CAS PROCESSING → FAILED, increment attempts
        Note over W: Payments stay claimed by this batch,<br/>so another batch can never double-pay them.
    end
```

---

## 6. Acquirer unreachable — the reconciliation path

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as API
    participant CB as Circuit breaker
    participant A as Acquirer
    participant M as MongoDB
    participant S as Reconcile scheduler

    C->>API: POST /payments
    API->>M: payment → PROCESSING
    API->>CB: authorize()
    CB->>A: HTTP
    A--xCB: timeout

    Note over API,M: The payment is NOT marked failed.<br/>The authorisation may have succeeded upstream;<br/>declaring it failed would strand a real charge.
    API->>M: leave status PROCESSING
    API-->>C: 201 { status: PROCESSING }

    loop 5 consecutive transport failures
        CB->>CB: failures++
    end
    CB->>CB: OPEN — fail fast for 30s
    Note over CB: Protects our own connection pool<br/>and gives the acquirer room to recover.

    S->>M: payments PROCESSING older than 2 min
    S->>API: reconcileWithAcquirer (under a lock)
    API->>CB: authorize() — half-open probe
    alt acquirer recovered, approved
        A-->>API: approved
        API->>M: CAS PROCESSING → SUCCESS
        API->>API: emit the async pipeline
    else declined
        API->>M: CAS PROCESSING → FAILED
    else still unreachable
        Note over API: Leave PROCESSING. Never guess<br/>at an outcome we cannot observe.
    end
```
