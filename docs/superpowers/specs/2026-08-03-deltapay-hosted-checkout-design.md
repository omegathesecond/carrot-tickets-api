# DeltaPay Hosted Checkout — Design

**Date:** 2026-08-03
**Status:** Approved
**Scope:** Add DeltaPay as a fourth payment method on Carrot Tickets' online consumer checkout.

---

## 1. Goal

Let a buyer pay for tickets with DeltaPay (DeltaCrypt's Eswatini wallet) via DeltaPay's
**Hosted Checkout**: our server creates a checkout session, the buyer is redirected to a
DeltaPay-hosted page, pays by phone/username or QR, and returns to us — where the server
confirms the outcome with an authoritative `verify-return` call before minting tickets.

**Surface:** online consumer checkout only (`landing/` `PurchaseModal`). Not POS, not
reseller, not bus/transport bookings. Hosted checkout is a browser redirect flow; the
Flutter POS has no place to land a redirect.

**Credentials:** not yet issued. Everything ships behind placeholders plus an off-by-default
toggle, so the code is deployable today and becomes live by setting secrets + flipping a switch.

---

## 2. Provider contract (from DeltaPay docs)

Base URLs — dev `https://api.dev.deltacrypt.net`, prod `https://api.prod.deltacrypt.net`.
Auth — `x-api-key: <key>` header.

### Create session
`POST /v1/hosted-checkout/sessions`

Request: `amount` (number, SZL, > 0), `merchant_reference` (string), and optional
`return_url`, `platform_order_id`, `display_description`, `metadata`,
`session_callback_url`, `payer_identifier_type` (`phone_number`|`username`),
`payer_identifier`.

Response: `checkout_session_id` (UUID), `checkout_url`, `expires_at`.
**Sessions expire 10 minutes after creation.**

### Verify result
`GET /v1/hosted-checkout/sessions/{checkout_session_id}/verify-return`

Response: `checkout_session_id`, `status`, `merchant_reference`, `platform_order_id`,
`amount`, `finalised_at`. Read-only and safe to call repeatedly.

### Status values
`pending` · `processing` · `succeeded` · `failed` · `expired` · `cancelled`.
**Only `succeeded` means paid.**

### Session callback
If `session_callback_url` is supplied, DeltaPay POSTs `{ "checkout_session_id": "…" }` when
the session concludes. The body carries **no outcome and no signature** — it is a trigger to
go verify, never evidence. Best-effort delivery; respond 200.

> The RSA-PSS signature scheme in DeltaPay's docs belongs to the separate C2B/IPN and
> payment-request callbacks, **not** to hosted-checkout session callbacks. There is nothing
> to verify cryptographically here, and nothing forgeable either — the callback body cannot
> assert payment.

### Other provider behaviours we rely on
- Retry limit (default 3 attempts) is enforced on DeltaPay's page; exhaustion → `failed`.
- QR payments must match the session amount exactly; mismatches are auto-reversed.
- Duplicate payments for one session are auto-reversed by DeltaPay.
- An invalid upfront `payer_identifier` does **not** fail session creation — the page falls
  back to prompting the customer.

---

## 3. Architecture

DeltaPay joins the existing **async redirect lane**, as a peer of `peach_card` — not a new
pattern.

### New files
| File | Role |
|---|---|
| `src/services/payments/deltapay.client.ts` | `isConfigured()`, `createSession()`, `verifySession()` |
| `src/services/payments/deltapay.processor.ts` | Registry entry; `charge()` throws |
| `src/controllers/deltapay.controller.ts` | Return redirect + session callback |
| `src/routes/deltapay.route.ts` | Unauthenticated provider-facing routes |
| `src/utils/paymentResult.util.ts` | Shared SPA result-page URL (used by card too) |

### Modified files
- `src/interfaces/ticket.interface.ts` — `PaymentMethod.DELTAPAY = 'deltapay'`; `deltapaySessionId` on `ITicketSale`
- `src/models/ticketSale.model.ts` — `deltapaySessionId` (sparse, indexed)
- `src/models/paymentMethodConfig.model.ts` — `deltapayEnabled`, `deltapayServiceFee`
- `src/services/paymentConfig.service.ts` — defaults + passthrough
- `src/utils/serviceFee.util.ts` — `deltapayServiceFee` in config + `serviceFeeFor` case
- `src/services/payments/index.ts` — register processor
- `src/services/ticket.service.ts` — `initiateDeltapayPurchase`, `finalizeDeltapaySale`, `getDeltapaySaleBySessionId`, `reconcilePendingDeltapaySales`
- `src/controllers/public.controller.ts` — initiate + status handlers, `getPaymentMethods`
- `src/routes/public.route.ts`, `src/app.ts`, `src/tasks/backgroundTasks.ts` — wiring
- `src/controllers/card.controller.ts` — use the shared result-page util

### Why `charge()` throws

`CardProcessor.charge()` throws by design: the synchronous `sellTickets` path treats any
non-`failed` result as `COMPLETED`, so a redirect method reaching it would mint tickets
without payment. `DeltaPayProcessor` follows the identical rule. The registry entry exists
so `getProcessor()` resolves the method (config lookups, fee math, admin surfaces) — never
to charge through.

---

## 4. Data flow

1. Buyer selects DeltaPay → `POST /api/public/purchase/deltapay` (buyer-authed).
2. Server:
   a. Guard: client configured **and** `deltapayEnabled`.
   b. Check availability; compute `serviceFeeAmount` / `amountCharged` (online channel only).
   c. Create `TicketSale` — `PENDING`, `ticketIds: []`.
   d. Reserve inventory, TTL **12 min** (deliberately longer than DeltaPay's 10-min session
      expiry, so the hold never lapses while a payment could still land).
   e. `createSession()`; store `deltapaySessionId`.
   f. On provider failure: release reservation, mark sale `FAILED`, **rethrow** (no silent
      fallback — the buyer sees the error).
3. Respond `{ checkoutUrl, checkoutSessionId, saleId, expiresAt }`; SPA redirects.
4. Buyer pays on DeltaPay's page.
5. Finalisation — **four independent paths, one idempotent function**:
   - `GET /api/public/purchase/deltapay/return` — browser lands; server finalises, then 302s
     to the SPA result page with `?id=&status=`.
   - `POST /api/public/purchase/deltapay/callback` — DeltaPay's session callback; finalises;
     **always** answers 200 so DeltaPay never retry-storms.
   - `GET /api/public/purchase/deltapay/:sessionId/status` — SPA poll (buyer-authed).
   - `reconcilePendingDeltapaySales` — 60 s background sweep over sales PENDING > 2 min.

---

## 5. `finalizeDeltapaySale` — the security core

The only place DeltaPay tickets mint. Invariants:

1. **Idempotent.** Sale not `PENDING` → return current status; never re-mint.
2. **Server-side verification only.** Calls `verify-return`. The return redirect is never
   proof of payment — a buyer can hit the URL manually.
3. **Status mapping.** `pending`/`processing` → `pending` (hold untouched).
   `failed`/`expired`/`cancelled` → release hold + mark `FAILED`. Only `succeeded` proceeds.
   An unrecognised status is treated as **pending** — never as success — so a provider-side
   enum addition can't mint tickets. The reservation sweep is the backstop.
4. **Exact amount guard.** DeltaPay's reported `amount` must equal `sale.amountCharged`
   (falling back to `totalAmount` for pre-service-fee rows). Mismatch → loud `console.error`,
   release, `FAILED`, no mint. No currency check: DeltaPay is SZL-only and returns no
   currency field.
5. **Atomic claim.** `findOneAndUpdate({_id, paymentStatus: PENDING})` before minting, so
   concurrent return + callback + poll cannot double-mint.
6. Post-claim: mint tickets, `ReservationService.confirm`, `EventService.updateTicketsSold`,
   best-effort SMS confirmation (failure logged, never blocks).

---

## 6. Configuration

### Payment config (dashboard Settings, persisted)
| Key | Default | Meaning |
|---|---|---|
| `deltapayEnabled` | `false` | Off until credentials land |
| `deltapayServiceFee` | `5` | Per-ticket buyer fee (E), matching MoMo |

### Environment variables
| Var | Placeholder / default | Notes |
|---|---|---|
| `DELTAPAY_ENABLED` | `false` | Env-level kill switch, ANDed with the DB toggle |
| `DELTAPAY_BASE_URL` | `https://api.prod.deltacrypt.net` | Dev: `https://api.dev.deltacrypt.net` |
| `DELTAPAY_API_KEY` | *(secret)* | `x-api-key` value |
| `DELTAPAY_RETURN_URL` | `https://api.carrottickets.com/api/public/purchase/deltapay/return` | Must be on an allowed return domain |
| `DELTAPAY_CALLBACK_URL` | *(optional)* | `session_callback_url`; omitted → no callbacks |
| `PAYMENT_RESULT_PAGE_URL` | `https://carrottickets.com/payment-result` | Shared SPA result page |

`isConfigured()` = `DELTAPAY_ENABLED === 'true'` **and** `DELTAPAY_API_KEY` **and**
`DELTAPAY_RETURN_URL`. `getPaymentMethods` surfaces `deltapay` only when `isConfigured()`
**and** `deltapayEnabled` — a half-configured deploy hides the button rather than failing
mid-checkout.

### Fees
`serviceFeeFor(DELTAPAY)` → `deltapayServiceFee`, charged **per ticket**, online channel
only, inside the existing `MAX_TICKETS_PER_ORDER` (10) cap. POS/reseller stay at face value.

### Currency
DeltaPay is SZL-native and the API takes a bare `amount`. `amountCharged` is sent as-is; no
conversion, no currency field.

### Upfront payer identifier
When the buyer's stored phone normalises to an Eswatini E.164 number (`+268…`), it is passed
as `payer_identifier_type: 'phone_number'` to skip identifier entry. Per the docs, an
unknown identifier degrades to the normal prompt rather than failing session creation.

---

## 7. Frontend (`landing/`)

- `PaymentMethodId` gains `'deltapay'`.
- `PurchaseModal`: DeltaPay option (shown only when the API lists it), redirect on submit —
  same shape as the card branch, no extra input fields.
- `api.ts`: `initiateDeltapayPayment()`, `checkDeltapayPaymentStatus()`.
- `lib/pricing.ts`: mirror the fee so displayed total == charged total.
- Payment-result page: recognise DeltaPay sessions and poll the DeltaPay status endpoint.

Dashboard `SettingsPage`: DeltaPay enable toggle + service-fee field alongside the existing
method controls.

---

## 8. Testing

Unit tests mirroring the existing peach suite:
- `deltapay.client.test.ts` — session creation shape, `x-api-key` header, non-2xx **throws**
  (never a silent fallback), verify-return parsing.
- `deltapay.processor.test.ts` — `charge()` throws.
- `serviceFee.util.test.ts` — DeltaPay per-ticket fee math.
- `ticket.service` finalise tests — idempotency, amount-guard rejection, unknown status
  treated as pending, atomic double-finalise safety.

---

## 9. Out of scope

- POS / reseller / bus-transport DeltaPay payments.
- Refunds and disbursements (DeltaPay B2C) — separate flow.
- C2B / IPN callbacks and their RSA-PSS signature verification.
- Storing DeltaPay identity for repeat buyers.

---

## 10. Registration data to send DeltaPay

Produced as a deliverable at the end of implementation: platform type, allowed return
domains, default return URL, session callback URL, display name, brand colour, logo,
accepted payer identifiers, retry limit — and what DeltaPay must return (API key, confirmed
base URLs).
