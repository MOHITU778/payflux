# API Design

Base path `/api/v1`. Interactive documentation at `/api/docs` (Swagger UI), machine-readable spec at `/api/openapi.json`.

## Design principles

1. **Versioned in the path** — a breaking change ships as `/v2` while `/v1` keeps serving existing merchants. Header-based versioning is invisible in logs and hard to route on.
2. **One response envelope** — every endpoint answers with the same shape, so the client has exactly one unwrapping path and one error path.
3. **Money is always integer minor units** — decimals are rejected outright.
4. **Stable error codes** — clients branch on `error.code`, never on the message text.
5. **Server-authored fields are never accepted as input** — Joi's `stripUnknown` silently drops them.

## Response envelope

```jsonc
// Success
{
  "success": true,
  "data":    { /* resource or array */ },
  "pagination": { "total": 420, "page": 1, "limit": 20, "pages": 21,
                  "hasNext": true, "hasPrev": false },
  "meta": { "timestamp": "2026-08-31T10:39:46.012Z",
            "correlationId": "cor_mth3wnylb478e71e4287",
            "requestId": "req_8093443d34066963" }
}

// Failure
{
  "success": false,
  "error": {
    "code": "REFUND_EXCEEDS_BALANCE",
    "message": "Refund of 70000 exceeds the refundable balance of 60000",
    "details": { "requestedMinor": 70000, "availableMinor": 60000,
                 "alreadyCommittedMinor": 40000 }
  },
  "meta": { "correlationId": "cor_mth3udnj51d478f1844b", ... }
}
```

The `correlationId` is echoed on **every** response and in the `x-correlation-id` header. A user reporting a failure quotes one string that finds the whole request across the API and all five workers.

---

## Endpoints

### Authentication

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/login` | public | Rate limited 10 / 15 min per IP+email, failures only |
| POST | `/auth/refresh` | public | Rotates the token pair |
| POST | `/auth/logout` | any | Bumps `tokenVersion` — revokes **every** issued token |
| GET | `/auth/me` | any | |
| POST | `/auth/change-password` | any | Also invalidates existing sessions |
| POST | `/auth/register` | ADMIN | User provisioning |

### Payments

| Method | Path | Role | Idempotent |
|---|---|---|---|
| POST | `/payments` | MERCHANT, ADMIN | **Required** |
| GET | `/payments` | any | — |
| GET | `/payments/:paymentId` | any | — |
| POST | `/payments/:paymentId/verify` | MERCHANT, ADMIN | naturally |
| POST | `/payments/:paymentId/cancel` | MERCHANT, ADMIN | optional |
| POST | `/payments/:paymentId/refunds` | MERCHANT, ADMIN | **Required** |
| GET | `/payments/state-machine` | any | — |
| GET | `/transactions` | any | — |
| GET | `/refunds`, `/refunds/:refundId` | any | — |

`GET /payments/state-machine` publishes the transition table the server enforces, so the console derives its action buttons from the same source of truth instead of duplicating the rules — they can never drift apart.

### Settlements, webhooks, ledger, analytics

| Method | Path | Role |
|---|---|---|
| GET | `/settlements`, `/settlements/queue`, `/settlements/:id` | any |
| POST | `/settlements/run` | **ADMIN** |
| POST/GET/PATCH | `/webhooks/endpoints[/:id]` | MERCHANT, ADMIN |
| POST | `/webhooks/endpoints/:id/rotate-secret` | MERCHANT, ADMIN |
| GET | `/webhooks/deliveries`, `/webhooks/dead-letter` | any |
| POST | `/webhooks/deliveries/:id/replay` | MERCHANT, ADMIN |
| POST | `/webhooks/inbound/:provider` | **HMAC signature** — no bearer token |
| GET | `/ledger/balance` | MERCHANT scope |
| GET | `/ledger/trial-balance`, `/ledger/accounts/:code/statement` | ADMIN, SUPPORT |
| GET/POST | `/ledger/reconciliations` | ADMIN, SUPPORT / ADMIN |
| GET | `/analytics/overview`, `/analytics/timeseries` | any |
| GET | `/fraud/alerts`, `/fraud/analytics` | any |
| POST | `/fraud/alerts/:id/review` | ADMIN, SUPPORT |
| GET | `/audit-logs` | ADMIN, SUPPORT |

Operational endpoints sit outside `/api` and are deliberately unauthenticated **and** un-rate-limited, so a probe never fails because of a quota: `/health`, `/health/live`, `/health/ready`, `/metrics`.

---

## The idempotency contract

Every mutating payment endpoint requires an `Idempotency-Key` header (8–255 characters; a UUID v4 is ideal).

For a given `(merchant, endpoint, key)`:

| Situation | Response |
|---|---|
| First request | Executes; the response is stored for 24 h |
| Retry, identical body | **The stored response, replayed verbatim** + `x-idempotent-replay: true` |
| Retry while the first is still executing | `409 IDEMPOTENT_REQUEST_IN_FLIGHT`, `x-retryable: true` — back off and retry |
| Same key, **different** body | `422 IDEMPOTENCY_KEY_REUSE` — replaying would be a lie |

Verified: **12 concurrent requests with one key produced exactly one charge** — 1 × 201 and 11 × 409, with a single row in the database.

Business rejections (fraud block, invalid state) are stored like any other response: they are reproducible answers, and replaying them is correct. Only unexpected 5xx failures release the key, so a client's retry can actually retry.

---

## Error codes

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | no | Schema failure; `details[]` lists every offending field at once |
| `UNAUTHORIZED` / `MISSING_TOKEN` / `TOKEN_EXPIRED` | 401 | no | |
| `TOKEN_REVOKED` | 401 | no | `tokenVersion` mismatch — re-authenticate |
| `FORBIDDEN` / `INSUFFICIENT_ROLE` | 403 | no | |
| `FRAUD_BLOCKED` | 402 | no | Carries `riskScore` and `triggeredRules` |
| `NOT_FOUND` | 404 | no | Also returned for cross-tenant access — existence is not disclosed |
| `CONFLICT` | 409 | no | |
| `INVALID_STATE_TRANSITION` | 409 | no | Carries `{ from, to }` |
| `IDEMPOTENT_REQUEST_IN_FLIGHT` | 409 | **yes** | |
| `PAYLOAD_TOO_LARGE` | 413 | no | |
| `IDEMPOTENCY_KEY_REUSE` | 422 | no | |
| `REFUND_EXCEEDS_BALANCE` | 422 | no | Carries requested / available / committed |
| `PAYMENT_NOT_REFUNDABLE` | 422 | no | |
| `LOCK_UNAVAILABLE` | 423 | **yes** | |
| `RATE_LIMITED` | 429 | **yes** | With `Retry-After` |
| `UPSTREAM_UNAVAILABLE` | 502 | **yes** | |
| `CIRCUIT_OPEN` | 503 | **yes** | Carries `retryAfterMs` |
| `INTERNAL_ERROR` | 500 | no | Never leaks a stack trace in production |

Responses that may succeed on retry carry `x-retryable: true`, so a client library can decide without a hard-coded status list.

---

## Cross-tenant behaviour

A `MERCHANT` requesting another merchant's payment receives **404, not 403**. A 403 would confirm the resource exists, which is an information leak. The tenant filter is computed once by `scopeToMerchant` middleware and applied at the repository, so a controller that forgets to filter fails closed rather than open.
