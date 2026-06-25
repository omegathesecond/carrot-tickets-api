# Peach card payments for online ticket buyers — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming → spec)
**Scope:** Add Visa/Mastercard card payments to the **online buyer checkout** of Carrot Tickets via Peach Payments **COPYandPAY** (OPPWA, `card.peachpayments.com/v1`).

## Goal

Let online ticket buyers pay by card, alongside the existing Keshless wallet and MTN MoMo
methods, on the public website (`carrot-tickets-website` / `landing`). Card is an
**asynchronous, redirect-verified** payment and therefore follows the existing **MTN MoMo
pattern** (initiate → external payment → verify status → mint tickets idempotently), **not**
the synchronous `charge()` path used by cash/wallet.

## Locked decisions

| Decision | Choice |
|---|---|
| Surface | Online buyer checkout only (landing site `PurchaseModal`). No dashboard/POS card. |
| Peach product | **COPYandPAY** (OPPWA), embedded payment widget. |
| Environment | **Production** (`card.peachpayments.com`). Sandbox skipped — awaiting Peach sandbox activation. |
| Currency | `ZAR`, sent 1:1 with the SZL price. Configurable via `CARD_CURRENCY` (default `ZAR`). Buyer still sees `E`. |
| Payment type | `DB` (immediate debit). |
| Refunds | Out of scope (purchase only). |
| Webhook | In scope — optional Peach webhook receiver, in addition to redirect-based verification. |

## Peach COPYandPAY flow (production)

1. **Prepare checkout (server):** `POST https://card.peachpayments.com/v1/checkouts`
   form-encoded body: `entityId`, `amount`, `currency`, `paymentType=DB`, `integrity=true`;
   header `Authorization: Bearer <access_token>`. Response → `{ id (checkoutId), integrity }`.
2. **Render widget (frontend):** load
   `https://card.peachpayments.com/v1/paymentWidgets.js?checkoutId={id}` (with `integrity`),
   render `<form class="paymentWidgets" action="{CARD_RESULT_URL}?ref={checkoutId}" data-brands="VISA MASTER">`.
3. **Redirect:** after the buyer pays, Peach redirects the page to
   `{CARD_RESULT_URL}?ref={checkoutId}&resourcePath=/v1/checkouts/{id}/payment`.
4. **Get status (server):** `GET https://card.peachpayments.com/v1/checkouts/{id}/payment?entityId=…`
   header `Authorization: Bearer <access_token>`. Inspect `result.code`:
   - **Success:** `/^(000\.000\.|000\.100\.1|000\.[36]|000\.400\.000)/`
   - **Pending:** `/^(000\.200)/`
   - Anything else → rejected.

### Authentication (one open detail — resolved by a spike, not by guessing)

Peach docs state the Bearer access token is "retrieved from the Dashboard", but the provided
credentials are `entityId` + `username` + `password` (where `username == entityId`). Working
hypothesis: a token exchange yields a short-lived Bearer token (username → clientId, password →
secret). `PeachClient.getAccessToken()` encapsulates this and caches the token to its expiry.

**Implementation step 1 is a one-call auth spike** against production to confirm the exact
request shape (token-exchange endpoint + body, vs. a static dashboard token, vs. Basic auth)
before anything else is built. The uncertainty is isolated to this single method; the rest of
the design is unaffected by how the token is obtained.

## Backend changes (`carrot-tickets-api`)

1. **Enum** — add `PaymentMethod.CARD = 'card'` to `src/interfaces/ticket.interface.ts`.
2. **Peach client** — new `src/services/payments/peach.client.ts`:
   - `isConfigured()` → `CARD_PAYMENTS_ENABLED === 'true'` && `PEACH_ENTITY_ID` && `PEACH_PASSWORD`.
   - `getAccessToken()` → token exchange + in-memory cache to expiry (see auth note).
   - `prepareCheckout({ amount, currency, merchantTransactionId })` → `{ checkoutId, integrity }`.
   - `getPaymentStatus(checkoutId)` → `{ code, amount, currency, raw }`.
   - Result-code regexes (success/pending) as module constants.
   - Fail loudly on every Peach error (no silent fallback).
3. **CardProcessor** — `src/services/payments/card.processor.ts`, registered in `payments/index.ts`.
   Mirrors `MtnMomoProcessor`: `charge()` **throws** so the synchronous `sellTickets` path can
   never mint a card sale without confirmed payment.
4. **TicketSale model** — add `peachCheckoutId` (indexed), mirroring `momoReferenceId`.
5. **TicketService** — two new methods mirroring the MoMo pair:
   - `initiateCardPurchase(params)` → check availability; create **PENDING** sale (electronic ⇒
     `fundsCustody: 'carrot'`, economic snapshot via the existing `buildSaleSnapshot` DRY helper);
     reserve inventory (`ReservationService.reserve`, MoMo TTL); `prepareCheckout`; store
     `peachCheckoutId`; return `{ checkoutId, integrity, saleId, expiresAt }`. On Peach failure:
     release reservation + mark sale FAILED + rethrow.
   - `finalizeCardSale(checkoutId)` → **idempotent**: non-PENDING returns current status;
     `getPaymentStatus`; pending → pending; rejected → release + fail; success → **assert returned
     `amount` and `currency` exactly equal the sale's** (same guard as `finalizeMomoSale`) →
     atomic `findOneAndUpdate({ _id, paymentStatus: PENDING })` claim → mint tickets via
     `buildTicket` → confirm reservation (reserved→sold) → `EventService.updateTicketsSold` →
     best-effort SMS.
6. **Config toggle** — add `cardEnabled` to `PaymentMethodConfig` model, `PaymentConfigService`
   DEFAULTS, and both `get`/`update` mappers (default `false`).
7. **Public payment-methods endpoint** — `getPaymentMethods` pushes `'card'` when
   `cfg.cardEnabled && PeachClient.isConfigured()` (mirrors the MoMo env-gate).
8. **Routes** (`src/routes/public.route.ts`):
   - `POST /api/public/purchase/card` (buyer-auth) → `PublicController.initiateCardPurchase`.
     Buyer phone comes from the token, never the body (as MoMo does).
   - `GET /api/public/purchase/card/:checkoutId/status` (buyer-auth) → `PublicController.getCardStatus`
     (ownership-checked, like `getMomoStatus`) → `finalizeCardSale`.
   - `POST /api/public/purchase/card/webhook` (unauthenticated) → `CardController.webhook` →
     `finalizeCardSale(checkoutId from payload)`; always returns 200 (no retry-storm), mirrors the
     MoMo callback. Safe alongside polling because finalize is idempotent.
9. **Env** (`api/.env.example`, **additive**):
   ```
   # Peach Payments (card via COPYandPAY)
   CARD_PAYMENTS_ENABLED=false
   PEACH_BASE_URL=https://card.peachpayments.com
   PEACH_ENTITY_ID=
   PEACH_USERNAME=
   PEACH_PASSWORD=
   CARD_CURRENCY=ZAR
   CARD_RESULT_URL=          # landing origin + /payment-result
   ```
   `PEACH_PASSWORD` (and possibly `PEACH_ENTITY_ID`) bind as **Secret Manager** secrets on the
   Cloud Run service, added **additively** (`--update-secrets`), never replacing existing bindings.

## Frontend changes (`carrot-tickets-website` / `landing`)

1. **types** (`src/types/index.ts`) — `PaymentMethodId` += `'card'`; add `CardInitiateResponse
   { checkoutId, integrity, saleId }`.
2. **api** (`src/services/api.ts`) — `initiateCardPayment(...)` (POST card), `checkCardPaymentStatus(checkoutId)` (GET status).
3. **PurchaseModal** — add a **Card (Visa/Mastercard)** method (CreditCard icon) and a new
   `'card_widget'` state. On "Pay with card": call `initiateCardPayment` → inject the Peach
   `paymentWidgets.js?checkoutId=…` script (with `integrity`) and render the
   `<form class="paymentWidgets" action="{CARD_RESULT_URL}?ref={checkoutId}" data-brands="VISA MASTER">`.
4. **PaymentResultPage** — new page + route `/payment-result` (registered in `App.tsx`). On mount:
   parse `ref` / `resourcePath` → checkoutId → call `checkCardPaymentStatus` (buyer token persists
   in `localStorage` across the redirect) → poll briefly while pending → show success (→ My Tickets)
   or failure (→ retry / back to event).
5. **Widget config** — `VITE_*` for the Peach widget base URL (prod) and `CARD_RESULT_URL`.

## Security / correctness (matches existing standards)

- Mint tickets **only** after server-side status verification with an **exact amount + currency
  match** — never on the redirect alone.
- Idempotent atomic claim prevents double-mint across poll + webhook.
- Ownership-checked status endpoint; buyer phone always from the token.
- Fail loudly on every provider error (global no-silent-fallback rule); SMS remains best-effort.

## Testing

Unit tests mirroring the MoMo suite (`src/services/__tests__`, `src/routes/__tests__`):
`PeachClient` with mocked `fetch`, and `finalizeCardSale` covering: pending, rejected →
release + fail, success → mint, amount/currency mismatch → fail, idempotent double-finalize.

## Out of scope

Refunds, dashboard/POS card payments, Apple/Google Pay, saved-card tokens.

## Deployment notes

- `carrot-tickets-api` → Cloud Run (`europe-west1`), env managed **on the service**; add Peach
  secrets/env additively. Deploy via `gcloud builds triggers run` (per project convention).
- `carrot-tickets-website` → Cloudflare Pages (contracts CF account), prod branch `main`.
- Live testing against production is permitted (no active buyers). Sequence: run the auth spike →
  do one real live card charge end-to-end → then enable card in prod (`CARD_PAYMENTS_ENABLED=true`
  + `cardEnabled=true`). The spike-first order stands only so we don't build on a wrong auth shape,
  not as a prod-safety gate.
