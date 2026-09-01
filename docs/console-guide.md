# Operations Console Guide

For the people who *use* PayFlux rather than integrate with it: merchant operations staff, platform
admins, and support agents.

**Open** http://localhost:8080 and sign in. (If you changed `CONSOLE_PORT` in `.env`, use that port.)

---

## Who sees what

Three roles. The differences are enforced by the **server**, not just hidden in the UI — a role that
cannot do something gets a `403` even if it calls the API directly.

| | ADMIN | MERCHANT | SUPPORT |
|---|:---:|:---:|:---:|
| Dashboard, transactions, refunds view | ✅ all merchants | ✅ own only | ✅ all merchants |
| Issue a refund / cancel a payment | ✅ | ✅ | ❌ |
| Create payments | ✅ | ✅ | ❌ |
| Manage webhook endpoints | ✅ | ✅ | ❌ |
| Trigger a settlement run | ✅ | ❌ | ❌ |
| Ledger & reconciliation | ✅ | ❌ | ✅ read-only |
| Review fraud alerts | ✅ | ❌ | ✅ |
| Audit logs | ✅ | ❌ | ✅ |

Verified live:

```
SUPPORT creating a payment  → 403 {"code":"INSUFFICIENT_ROLE",
                                   "message":"Role SUPPORT may not perform this action"}
SUPPORT listing payments    → 200, 430 payments visible
MERCHANT opening the ledger → 403 {"code":"INSUFFICIENT_ROLE", ...}
```

**MERCHANT users are scoped to their own merchant at the data layer.** Requesting another merchant's
payment by id returns `404`, not `403` — a 403 would confirm the record exists.

### Demo accounts

| Role | Email | Password |
|---|---|---|
| ADMIN | `admin@payflux.io` | `PayFlux#2024` |
| SUPPORT | `support@payflux.io` | `PayFlux#2024` |
| MERCHANT | `merchant@nimbusretail.example` | `PayFlux#2024` |

---

## Dashboard

The landing screen. Auto-refreshes every 15 seconds; the range selector (top right) covers the last
hour through 90 days.

### The six headline tiles

| Tile | Meaning | When to worry |
|---|---|---|
| **Gross volume** | Everything captured in the period | — |
| **Net revenue** | Gross minus refunds | Diverging sharply from gross means a refund spike |
| **Success rate** | Succeeded ÷ *terminal* payments | **Amber below 88%, red below 75%** |
| **Failed payments** | Count, plus the most common decline reason | A jump usually means an issuer or acquirer problem, not customer behaviour |
| **Platform fees** | Fee revenue recognised | — |
| **Avg ticket** | Mean payment size | A sudden collapse can indicate card testing |

> **Why success rate excludes pending payments:** they are counted only once they reach a final
> state. Including in-flight payments would make the rate dip every time traffic spiked, which would
> be alarming and meaningless.

### Charts

- **Payment volume** — stacked succeeded vs failed per bucket. Bucket size adapts: hourly for ranges
  up to two days, daily beyond. Hover any bar for exact counts.
- **By payment method** — CARD / UPI / NETBANKING / WALLET split.
- **Status breakdown** — horizontal bars with counts and percentages.
- **Risk decisions** — ALLOW / REVIEW / BLOCK mix.

### Operational tiles

- **Settlement queue** — batches built but not yet paid out.
- **Queue depth** — the async pipeline (`waiting` / `active` / `failed` per queue). **A non-zero
  `failed` count is the earliest signal that background processing is broken**, usually before any
  customer notices.
- **Recent payments** — the last eight. Click any row for full detail.

---

## Transactions

Search and filter every payment.

### Filters

| Filter | Notes |
|---|---|
| **Payment ID** | Prefix search, debounced 350 ms. Paste a full `pay_…` for an exact hit. |
| **Status** | Any of the eight payment states |
| **Method** | Card / UPI / Net banking / Wallet |
| **From / To** | Date range; `To` covers the whole day |
| **Sort** | Newest, oldest, or by amount |

Filters combine, and "Clear filters" appears once any is active.

### Reading the table

The **Risk** column is colour-coded: green below 50, amber 50–79, red 80+. **Refunded** shows a dash
when nothing has been returned.

---

## Payment detail

Click any transaction. This is the screen a support agent lives in.

### Header

Amount, status badge, payment id, and the available actions. **Which buttons appear is decided by
the server**, from the same state machine it enforces — so the UI can never offer an action that
would be rejected.

- **Verify with acquirer** — always available. Re-checks with the card network and resolves a stuck
  `PROCESSING` payment. Safe to press repeatedly.
- **Cancel** — only for uncaptured payments.
- **Refund** — only when there is a refundable balance.

### Details panel

Method, currency, platform fee, refunded amount, refundable balance, customer, instrument
(`VISA •••• 4242`), country, acquirer reference and auth code, timestamps. A red block appears for
failures with the decline code and message.

### Risk assessment

The 0–100 score with a coloured bar, the decision, and the exact rules that fired. Hover a rule chip
for the evidence behind it — "14 attempts in 300s", not just "velocity rule".

### State history

Every transition the payment has been through, with who caused it and why:

```
● NONE → PENDING       by api        Payment created         01 Sep 2026, 03:33:34
● PENDING → PROCESSING by system     Submitted to acquirer   01 Sep 2026, 03:33:34
● PROCESSING → SUCCESS by acquirer   Authorised and captured 01 Sep 2026, 03:33:34
```

Append-only. Nothing is ever rewritten, which is what makes it usable as evidence in a dispute.

### Ledger entries

The double-entry legs posted for this payment, with a **Balanced / Imbalanced** badge:

```
DEBIT   gateway_clearing                    249900
CREDIT  merchant_payable:mrch_GnXjjTFsQ6To  244902
CREDIT  platform_revenue                      4998
                                    balanced: 249900 = 249900 ✓
```

Empty immediately after capture is normal — posting is asynchronous and lands within a second or two.

---

## Issuing a refund

1. Open the payment → **Refund**.
2. Enter an amount in **rupees** (the console converts to minor units), or leave it blank for the
   full remaining balance.
3. Choose a reason: requested by customer, duplicate, fraudulent, merchant error, other.
4. **Confirm refund.**

The panel shows the refundable balance and caps the input at it. If you exceed it anyway, the server
rejects with the exact figures:

> Refund of 250000 exceeds the refundable balance of 199900

The payment then reads `PARTIALLY_REFUNDED` or `REFUNDED`, and the refundable balance drops.

> **Two agents refunding at once is safe.** Concurrent refunds are serialised and the total can never
> exceed what was captured — guaranteed at the database level, not by the UI.

---

## Risk

### Score distribution

A histogram of every score in the period, coloured by band — green allow, amber review, red block.
**This is the tuning tool.** If a large mass of legitimate traffic sits just under 80, the threshold
is too tight; if fraud is clustering at 70, it is too loose.

### Most-triggered rules

Which rules fire most, how often each leads to a block, and the average score when they fire. A rule
with many hits and no blocks is contributing noise, not signal.

### Alerts

Everything blocked or flagged. Live sample:

```
score  73  REVIEW  rules: HIGH_AMOUNT
score  84  BLOCK   rules: HIGH_AMOUNT
```

Each row links to the payment. ADMIN and SUPPORT can record a review decision, overturning the
automated verdict — the override is stored alongside the original for later analysis.

---

## Settlements

How merchants actually get paid.

### Payout queue

Batches built but not yet transferred, showing the full derivation:

```
setl_yOjndIUoxThnMTZ93pDd  SETTLED
gross ₹1416.15  −  fees ₹28.33  −  refunds ₹0.00  =  net ₹1387.82   (2 payments)
```

### History

Every batch with status, the four figures, payment count, period and bank reference.

| Status | Meaning |
|---|---|
| `QUEUED` | Built, waiting for the bank rail |
| `PROCESSING` | Payout instructed |
| `SETTLED` | Money sent |
| `FAILED` | Payout failed — **automatically retried**; payments stay claimed by this batch so they can never be double-paid |

### Running one manually (ADMIN)

**Run settlement now** builds a batch immediately instead of waiting for the six-hourly schedule.

> Safe to press twice. The batch key is derived from merchant + currency + time window, so a second
> run in the same window returns the existing batch rather than paying the merchant again.

Payments only become settleable after the merchant's hold window (default 24h). "No payments are
eligible" means nothing has aged past it yet.

---

## Webhooks

Three tabs.

### Endpoints

Each shows its URL, active state, subscribed events, **consecutive failures**, last success, and the
retry ladder.

**Adding one:** click **+ Add endpoint**, enter the URL. The signing secret is displayed **once** in
a prominent panel — copy it immediately. It is stored hashed and cannot be shown again; if lost,
rotate it.

> An endpoint that fails repeatedly is **auto-disabled** so a dead URL stops consuming delivery
> capacity. Re-enabling from the console clears the failure count.

### Delivery log

Every attempt: event type, status, attempt count against the maximum, destination, the last HTTP
response with its duration, and when the next retry is due.

### Dead letter

Deliveries that exhausted their retries or hit a permanent failure. The tab badge shows the count in
red when it is non-zero.

**Replay** re-sends one after you have fixed the cause. This creates a *new* delivery record and
leaves the failed history intact — the original attempts are evidence.

---

## Ledger (ADMIN and SUPPORT)

The platform's books.

### The balance banner

The single most important indicator in the console:

> ✓ **Books are balanced** — Total debits ₹1,121,372.84 = total credits ₹1,121,372.84 · 453 entries

Green means every rupee is accounted for. **Red means stop and investigate** — something has moved
money without a matching counter-entry.

### The accounting identity

```
assets = liabilities + revenue − expenses
```

Four tiles: assets (money held), liabilities (owed to merchants), revenue (fees), and an identity
check. All four must reconcile.

### Chart of accounts

| Account | Type | Meaning |
|---|---|---|
| `gateway_clearing` | ASSET | Money held at the acquirer |
| `merchant_payable:<id>` | LIABILITY | What we owe a specific merchant |
| `platform_revenue` | REVENUE | Processing fees earned |
| `payment_reversals` | EXPENSE | Value returned to customers |

### Reconciliation runs

Each run recomputes every balance from the immutable entry stream and compares it to the cached
value. A run with discrepancies expands to show exactly what diverged and by how much.

> **Reconciliation reports; it never repairs.** Automatically "correcting" money would turn a bug
> into a cover-up. A human decides, and the correction is posted as a visible reversing journal.

ADMIN can trigger a run on demand; the scheduler runs one every 12 hours.

---

## Daily routine

**Merchant operations — start of day**
1. Dashboard: is the success rate normal? Any failure spike?
2. Settlements: did yesterday's payout go out?
3. Webhooks → Dead letter: anything to replay?

**Support — per ticket**
1. Transactions: search the payment id the customer quoted.
2. Read the state history — it says exactly what happened and when.
3. Check the risk panel if it was declined.
4. Quote the `correlationId` when escalating; it recovers the entire request across every service.

**Platform admin — weekly**
1. Ledger: balance banner green, identity holding.
2. Reconciliation runs: any discrepancies.
3. Risk → score distribution: are the thresholds still right?
4. Dashboard → queue depth: any `failed` jobs accumulating.

---

## Small things worth knowing

- **Theme toggle** (top right, ☀/☾) — dark by default; the choice persists.
- **Sidebar collapse** (☰) — more room for wide tables.
- **Deep links work.** Any URL can be bookmarked or shared with a colleague.
- **Errors show the real reason.** The server's own message is displayed, with the correlation id
  underneath — so "Refund of 250000 exceeds the refundable balance of 199900" is what you see, not
  "Something went wrong".
- **Sign out revokes every session** for that user, on every device — not just this browser.
