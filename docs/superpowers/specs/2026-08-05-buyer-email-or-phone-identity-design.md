# Buyer email-or-phone identity — design

**Date:** 2026-08-05
**Status:** Approved (brainstorming) → pending implementation plan
**Scope:** Carrot Tickets buyer (ticket-holder) authentication — `api` + `landing`
**Author:** Laslie + Claude

## Problem

Buyer (ticket-holder) accounts authenticate with **phone number only**. Phone is
not merely a login field — it is the buyer's *identity*: the JWT carries
`userPhone`, "My Tickets" runs `Ticket.find({ customerPhone })`, IDOR ownership
checks on payment polling compare `sale.customerPhone`, and the social "who's
going" feed queries `customerPhone: { $in: [...] }`. Vendors/organizers already
accept email or phone; buyers do not.

**Goal:** a buyer can register and log in with **email OR phone**, including
buyers who have *no phone at all* (true email-only accounts), verified via a
6-digit OTP on whichever channel they chose.

## Decisions (locked during brainstorming)

1. **Surface:** buyer / "My Tickets" only. Vendor, reseller, operator, gate, and
   the Keshless in-app proxy purchase path are untouched.
2. **Identity model:** email OR phone as *peer* identity. Email-only accounts are
   first-class (no phone required).
3. **Email verification:** 6-digit **OTP code emailed via YeboLink** — same UX as
   the existing SMS OTP. Not a magic link.
4. **Rollout:** all at once, one spec/plan (not phased).
5. **Live tokens:** **hard cutover.** Only new `buyerId`-bearing tokens are
   accepted; every currently-signed-in buyer re-logs-in once. No legacy
   `userPhone`-only token branch is kept. (This is a deliberate break, not a
   backward-compat allowance.)

## Core idea

Introduce the Buyer's Mongo `_id` (`buyerId`) as the **canonical identity**.
Phone and email become *contact handles* that both resolve to that id. The token
carries `buyerId` (always) plus whichever handles exist (`userPhone`,
`userEmail`). `resolveBuyerFromRequest` — the single choke point already used by
the social layer and profile — resolves by `buyerId`, so most social code rides
along unchanged. The concentrated risk is the purchase/ticket-matching path,
which stores and matches on raw `customerPhone` in ~8 places.

## Design by area

### 1. Data model

**`Buyer` (`api/src/models/buyer.model.ts`)**
- `phone`: `required: true` → **optional** (`unique`, `sparse`, `index`).
- Add `email`: optional, `unique`, `sparse`, `index`, lowercased + trimmed,
  format-validated.
- Add `emailVerifiedAt?: Date`, `phoneVerifiedAt?: Date`.
- Schema-level invariant: **at least one of `phone` / `email` must be present**,
  and an account's identity handle(s) must be verified (verification is proven at
  creation time via the OTP, so a freshly created buyer always has ≥1 verified
  handle). Enforced in a `pre('validate')` hook.
- `comparePassword`, username/social fields, notification prefs: unchanged.

**`Ticket` + `TicketSale` (`ticket.model.ts`, `ticketSale.model.ts`)**
- Add `customerEmail?: string` (optional, lowercased, indexed).
- Add `buyerId?: ObjectId` (optional, indexed) — the canonical owner link,
  stamped whenever a *logged-in buyer* purchases. Absent for POS/guest sales.
- Keep `customerPhone` (still the norm for phone buyers, POS, and Keshless path).
- New compound index to support the My-Tickets `$or` query efficiently (see §4).

**`BuyerOtp` (`buyerOtp.model.ts`)**
- Generalize from phone-only to channel-based:
  - `channel: 'sms' | 'email'`
  - `destination: string` (normalized phone or lowercased email)
  - (rename `phone` → `destination`; add `channel`)
- Hash, TTL index, `attempts`, `consumed` logic unchanged.

### 2. Token & middleware

**Token payload** (minted in `BuyerAuthService.signToken`):
```
{ userType: 'buyer', app: 'tickets', buyerId, userPhone?, userEmail? }
```
- `buyerId` always present. `userPhone` present iff the buyer has a phone;
  `userEmail` iff they have an email. Same secret + `app: 'tickets'` claim, so
  `TicketsAuthService.verifyToken` accepts it unchanged.

**`ticketsAuth.middleware.ts`** — `authenticateBuyer`, `authenticateCommunityViewer`,
`optionalCommunityViewer`:
- Buyer-token check becomes `decoded.userType === 'buyer' && decoded.buyerId`
  (was `&& decoded.userPhone`). Hard cutover: a token lacking `buyerId` is
  rejected (community-viewer/optional paths simply treat it as
  unauthenticated/anonymous respectively).

**`buyerRequest.util.ts`** — `resolveBuyerFromRequest`:
- Resolve `Buyer.findById(ticketsUser.buyerId)`. (No phone fallback needed — every
  accepted token now carries `buyerId`.)

**`socialActor.util.ts`** — `resolveActorFromRequest`:
- Branch on `user.userType === 'buyer' && user.buyerId` → `resolveBuyerFromRequest`.
  Otherwise unchanged.

**`realtime/socketAuth.ts`**:
- Gate on `decoded.buyerId`; resolve the buyer/social identity by id rather than
  `normalizePhone(decoded.userPhone)`.

### 3. Auth service — `BuyerAuthService`

- **Identifier detection:** a small helper classifies a raw identifier as phone or
  email (email if it matches an email regex, else treat as phone → normalize).
- `login(identifier, password)`:
  - Resolve the buyer by email or normalized phone. Same `requiresRegistration`
    semantics when no account exists on that handle.
  - On success mint `signToken(buyer)`.
- `requestRegistrationOtp(identifier)`:
  - Detect channel. Reject if a buyer already owns that handle.
  - SMS path: `SmsService.sendOtp` (unchanged). Email path: `EmailService.sendOtp`
    (new — via YeboLink). Store `BuyerOtp{ channel, destination, ... }`.
- `registerWithOtp(identifier, code, password, name?)`:
  - Consume OTP for `(channel, destination)`. Create the buyer with the verified
    handle set + its `*VerifiedAt`. Mint token.
- `requestPasswordResetOtp(identifier)` / `resetPassword(identifier, code, pw)`:
  - Mirror registration, channel-aware, require an existing account on the handle.
- `signToken(buyer)`: emit `buyerId` + `userPhone?`/`userEmail?`.
- **No silent fallback:** if the email/SMS send fails, throw a user-facing error
  (per global rule). Email failures surface exactly like SMS failures do today.

**New `EmailService` (`api/src/services/email.service.ts`)**
- Thin YeboLink email client (mirrors `SmsService`). `sendOtp(email, code)` and a
  generic `send({ to, subject, html })`. Wired per the `yebolink-implementation`
  skill: `CARROT_TICKETS__YEBOLINK_API_KEY` (or existing tickets YeboLink key) via
  Secret Manager → Cloud Run env. Reuses the existing "Carrot Tickets" YeboLink
  workspace already used for international SMS.

### 4. Purchase / My Tickets

**Payment initiators + status polling** (`public.controller.ts`: MoMo, Peach card,
DeltaPay initiate + status; ~8 `userPhone` sites):
- Resolve the buyer via `buyerId`. Bind the sale to `buyerId` and stamp
  `customerEmail` (and `customerPhone` when present).
- IDOR ownership checks on status polling: compare `sale.buyerId === buyer._id`
  (fallback to phone match only for legacy sales that predate `buyerId`).
- MoMo still needs `momoPhone` (the wallet number) from the body — unchanged; an
  email-only buyer just types their wallet number.

**`TicketService`**
- `findTicketsByCustomerPhone(phone)` → `findTicketsForBuyer(buyer)` matching
  `{ $or: [ { buyerId }, { customerPhone }, { customerEmail } ] }` (only the
  clauses whose handle exists), so tickets bought **before** `buyerId` existed
  still surface for the right buyer. Legacy phone-keyed callers (Keshless proxy)
  keep a thin `findTicketsByCustomerPhone` wrapper.
- `purchaseForCustomer` gains optional `customerEmail` + `buyerId`.

**`public.controller.getMyTickets`** and **`tickets.controller.getMyTickets`**:
- Web path resolves the buyer and calls `findTicketsForBuyer`. The Keshless proxy
  path (`tickets.controller`) stays phone-based (that path always has a phone) via
  the wrapper.

### 5. Frontend — `landing`

**`BuyerAuthPanel.tsx`** (shared by `/my-tickets/login` + in-checkout `PurchaseModal`):
- Replace the `PhoneField`-only input with an **identifier field** accepting phone
  or email (lightweight client-side detection to show the right helper text and
  keyboard). Keep `PhoneField` behavior when the input looks like a phone.
- The verify step is channel-aware copy: "Enter the 6-digit code we sent to your
  {email|phone}". Reset overlay mirrors it.
- `BuyerAuthContext` / `onAuthenticated(token, identity)`: pass through
  `{ phone?, email? }` instead of a bare phone. Any consumer that assumed a phone
  string is audited.

### 6. Out of scope (YAGNI)

- Merging a pre-existing phone buyer and an email buyer into one account
  (account linking). Each handle = one account for now.
- Adding a *second* handle to an existing account (profile "add email/phone").
  Future enhancement; not required for login parity.
- Any change to vendor / reseller / operator / gate auth.
- Changing the Keshless in-app proxy purchase path (always phone-authed).

## Error handling

- Send failures (SMS or email) throw user-facing errors — no canned/fallback
  success (global rule).
- Duplicate-handle registration returns the existing "already has an account,
  please sign in" message, per-channel.
- Invalid identifier (neither a valid phone nor a valid email) → single clear
  validation error.

## Testing

- **Unit (`BuyerAuthService`):** identifier detection; login/register/reset on each
  channel; duplicate-handle rejection; OTP consume/attempts/expiry unchanged;
  at-least-one-handle invariant.
- **Model:** Buyer invariant (reject no-handle); sparse-unique on email + phone.
- **Middleware:** buyerId-token accepted; legacy userPhone-only token rejected
  (hard cutover); community/optional viewer paths.
- **Ticket matching:** `findTicketsForBuyer` surfaces buyerId, phone, and email
  tickets; legacy (no buyerId) tickets still match by phone/email.
- **Purchase IDOR:** buyerId ownership check; legacy-sale phone fallback.
- **Frontend:** `BuyerAuthPanel` login/signup/reset for both channels; existing
  phone tests keep passing.

## Migration / rollout notes

- **Hard token cutover:** ship note that active buyers re-login once. No data
  migration for tokens.
- **Data:** existing buyers keep `phone`; backfill `phoneVerifiedAt` for existing
  rows (they were OTP-verified at creation) so the invariant holds. No `buyerId`
  backfill on old tickets — the `$or` match covers them.
- **Deploy order:** API (model + auth + email service + secret) before the landing
  build that calls the new identifier flow. Verify `EmailService` send end-to-end
  on dev before prod.
- Two repos: `api` (main), `landing` (dev → prod per its Pages flow).

## Open questions

- None blocking. (Account-linking + add-second-handle intentionally deferred.)
