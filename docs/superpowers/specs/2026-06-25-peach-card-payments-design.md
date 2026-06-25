# Peach card payments for online ticket buyers — Design

**Date:** 2026-06-25
**Status:** Revised after live probing — integration target changed to **Peach Payments API v2** (hosted-redirect), see "Integration pivot" below.
**Scope:** Add Visa/Mastercard card payments to the **online buyer checkout** of Carrot Tickets.

## Goal

Let online ticket buyers pay by card, alongside the existing Keshless wallet and MTN MoMo
methods, on the public website (`carrot-tickets-website` / `landing`). Card is an
**asynchronous, redirect-verified** payment and therefore follows the existing **MTN MoMo
pattern** (initiate → external payment → verify status → mint tickets idempotently), **not**
the synchronous `charge()` path used by cash/wallet.

## Integration pivot (what live probing established 2026-06-25)

The originally-approved design targeted OPPWA **COPYandPAY** (embedded widget on
`card.peachpayments.com`, auth via a Bearer access token). Probing the merchant's actual
credentials against Peach prod proved those credentials belong to a **different product**:

- **Product:** Peach **Payments API v2**.
- **Base URL:** `https://api-v2.peachpayments.com` (sandbox `https://testapi-v2.peachpayments.com`).
- **Auth:** a JSON `authentication` object in the request body: `{ userId, password, entityId }`
  (NOT a Bearer access token — that path is the Mobile SDK / COPYandPAY product, which this
  merchant is not using).
- **Card UX:** **hosted redirect**, not an embedded in-page widget. `POST /payments` returns a
  `redirect` object; the buyer is sent to Peach's hosted card page and returns to
  `shopperResultUrl`.

The embedded-widget UX is therefore replaced by a redirect UX. The backend gains Peach
**webhook decryption** (AES-128-GCM). The MoMo-style lifecycle (PENDING sale → reserve
inventory → verify → idempotent mint) is unchanged.

### Outstanding credential blocker

With `userId` == `password's account` == `entityId` as supplied (Username given identical to
Entity ID), all brands — including Peach's `MOCK` test brand — return `800.900.300 invalid
authentication` at processing time. Resolution required from the merchant: the real Username
(expected to differ from the Entity ID) and/or a regenerated Password. Implementation can be
built and unit-tested (PeachClient mocked) before this is resolved; only the live charge +
deploy are gated on it.

## Locked decisions

| Decision | Choice |
|---|---|
| Surface | Online buyer checkout only (landing site `PurchaseModal`). No dashboard/POS card. |
| Peach product | **Payments API v2** (`api-v2.peachpayments.com`), hosted-redirect card flow. |
| Environment | **Production** (live charges permitted — no active buyers). |
| Currency | `ZAR`, sent 1:1 with the SZL price. Configurable via `CARD_CURRENCY` (default `ZAR`). Buyer sees `E`. |
| Payment type | `DB` (immediate debit), `paymentBrand=CARD`. No preauth, no refunds in this plan. |
| Finalisation | Encrypted webhook (primary) + transaction-status check on return to `shopperResultUrl` (secondary). Both idempotent. |

## Confirmed Payments API v2 card flow

1. **Create payment (server):** `POST https://api-v2.peachpayments.com/payments`, JSON body:
   - `authentication: { userId, password, entityId }`
   - `amount` (string, 2dp), `currency` (`ZAR`), `paymentType: "DB"`, `paymentBrand: "CARD"`
   - `merchantTransactionId` (our `saleId`), `nonce` (idempotency key), `shopperResultUrl`
   - Response: `result.code = 000.200.000` (pending) + `redirect: { url, method, parameters }`.
2. **Redirect buyer:** frontend sends the buyer to `redirect.url`. If `method` is `GET`, append
   `parameters` as query string; if `POST`, auto-submit a form with `parameters` as hidden
   `x-www-form-urlencoded` fields.
3. **Return:** Peach redirects the buyer back to `shopperResultUrl` (our `/payment-result`).
4. **Verify (server):** transaction-status request (exact path from the Peach Postman
   collection; to be pinned during implementation) → `result.code`. Success = `000.000.000`;
   pending = `000.200.*`; otherwise failed.
5. **Webhook (server):** Peach POSTs an **encrypted** body (AES-128-GCM; IV + authTag in
   headers; key = the dashboard webhook secret). Decrypt → payload includes `id`,
   `merchantTransactionId`, `amount`, `currency`, `result.code`. Always 200 to Peach. Idempotent.

### Result-code classification
- Success: `000.000.000` (and the `000.000.*`/`000.100.1*` family).
- Pending: `000.200.*`.
- Else: failed.

## Backend changes (`carrot-tickets-api`)

1. **Enum** — add `PaymentMethod.CARD = 'card'`.
2. **Peach client** — `src/services/payments/peach.client.ts`:
   - `isConfigured()` → `CARD_PAYMENTS_ENABLED==='true'` && `PEACH_ENTITY_ID` && `PEACH_USER_ID` && `PEACH_PASSWORD`.
   - `createPayment({ amount, currency, merchantTransactionId, shopperResultUrl, nonce })` →
     `{ id, redirect: { url, method, parameters }, code }`.
   - `getPaymentStatus(id)` → `{ code, amount?, currency?, raw }`.
   - `decryptWebhook({ body, iv, authTag })` → parsed JSON payload (AES-128-GCM, key from `PEACH_WEBHOOK_SECRET`).
   - `classifyResultCode(code)` → `'success' | 'pending' | 'rejected'`.
   - Fail loudly on every Peach error.
3. **CardProcessor** — registered in `payments/index.ts`; `charge()` throws (async-only), mirroring `MtnMomoProcessor`.
4. **TicketSale model** — add `peachPaymentId` (indexed; the Peach transaction `id`). Keep
   `merchantTransactionId` == existing `saleId`.
5. **TicketService**:
   - `initiateCardPurchase(params)` → PENDING sale (electronic ⇒ `fundsCustody:'carrot'`,
     snapshot via `buildSaleSnapshot`), reserve inventory, `createPayment`, store `peachPaymentId`,
     return `{ paymentId, redirect, saleId, expiresAt }`. On failure: release + fail + rethrow.
   - `finalizeCardSale(peachPaymentId)` → idempotent: non-PENDING returns current; `getPaymentStatus`;
     pending→pending; rejected→release+fail; success→assert `amount`+`currency` exactly equal the
     sale's → atomic claim → mint via `buildTicket` → confirm reservation → update sold → best-effort SMS.
   - `getCardSaleByPaymentId(id)`.
6. **Config toggle** — `cardEnabled` on `PaymentMethodConfig` + `PaymentConfigService` (default false).
7. **Public surface**:
   - `getPaymentMethods` adds `'card'` when `cfg.cardEnabled && new PeachClient().isConfigured()`.
   - `POST /api/public/purchase/card` (buyer-auth) → `{ paymentId, redirect, saleId }`.
   - `GET /api/public/purchase/card/:paymentId/status` (buyer-auth, ownership-checked) → `{ status }`.
   - `POST /api/public/purchase/card/webhook` (unauth) → decrypt → `finalizeCardSale` → always 200.
8. **Env** (`.env.example`, additive): `CARD_PAYMENTS_ENABLED`, `PEACH_BASE_URL=https://api-v2.peachpayments.com`,
   `PEACH_ENTITY_ID`, `PEACH_USER_ID`, `PEACH_PASSWORD`, `PEACH_WEBHOOK_SECRET`, `CARD_CURRENCY=ZAR`, `CARD_RESULT_URL`.
   Secrets (`PEACH_PASSWORD`, `PEACH_WEBHOOK_SECRET`, `PEACH_USER_ID`, `PEACH_ENTITY_ID`) bind on Cloud Run additively.

## Frontend changes (`carrot-tickets-website` / `landing`)

1. **types** — `PaymentMethodId` += `'card'`; `CardInitiateResponse { paymentId; redirect: { url; method; parameters }; saleId }`.
2. **api** — `initiateCardPayment(...)`, `checkCardPaymentStatus(paymentId)`.
3. **PurchaseModal** — add a **Card (Visa/Mastercard)** method. On pay: `initiateCardPayment` →
   perform the redirect (GET → `window.location`; POST → auto-submit a hidden-field form to `redirect.url`).
4. **PaymentResultPage** (`/payment-result`) — read the returned id (`merchantTransactionId`/`id`
   query param Peach appends, plus our own `ref`), call status, poll briefly, show success
   (→ My Tickets) / failure.

## Security / correctness

- Mint only after server-side status (or decrypted-webhook) success **and** exact amount+currency match.
- Idempotent atomic claim prevents double-mint across webhook + status poll.
- Webhook body is encrypted; decrypt + verify before acting; always 200 to Peach.
- Buyer phone always from the token; ownership-checked status endpoint.
- No silent fallbacks; SMS best-effort.

## Testing

Unit tests (PeachClient with mocked fetch + a known-vector webhook-decrypt test; finalizeCardSale
covering pending / rejected→release+fail / success→mint / amount-currency-mismatch→fail / idempotent).

## Out of scope

Refunds, dashboard/POS card, Apple/Google Pay, tokenisation/saved cards.

## Deployment

- `carrot-tickets-api` → Cloud Run (`europe-west1`), env on the service, Peach secrets added additively.
- `carrot-tickets-website` → Cloudflare Pages (contracts CF account), prod branch `main`.
- Sequence once credentials work: deploy → one live card charge end-to-end → enable card
  (`CARD_PAYMENTS_ENABLED=true` + `cardEnabled=true`).
