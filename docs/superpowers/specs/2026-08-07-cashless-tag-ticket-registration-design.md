# Carrot Tickets — Cashless Slice 1: Tag Registration + Tag = Ticket (Design)

**Date:** 2026-08-07
**Status:** Approved design → ready for implementation plan
**Parent spec:** `docs/superpowers/specs/2026-07-16-carrot-cashless-system-design.md` (the full cashless system). This document is a re-scoped, product-driven **first shippable slice** of that build — the piece that is demonstrable with a blank NFC tag in hand — not a replacement for it. All four binding architecture decisions and the ledger model from the parent spec are inherited unchanged; this doc does not relitigate them.

---

## 1. Why this slice, and what it delivers

The parent cashless build sequences as: ledger → wallet+binding → top-up/refund → merchant+mgmt → POS tap-to-pay → settlement → reconciliation. Phases 1–2 (**SP1 ledger**, **SP2 wallet + band-binding**, **SP2b per-ticket check-in over HTTP**) are **already built** on branch `feat/cashless-system` (unmerged). Nothing consumer- or staff-facing exercises them yet.

This slice makes that foundation **real and demonstrable**: a staff operator, with a blank tag in hand, can register the tag against a wallet, load cash onto it, tap it to read the balance, and tap it at the gate to be admitted — all inside the existing Carrot staff app. It deliberately stops short of spending (vendor tap-to-pay), merchant management, and settlement, which are later slices.

**Success criterion.** On an event flagged `cashless`, an operator with the right permissions can, on the ZCS handheld or an ordinary Android phone running `carrot_tickets_pos`:
1. Turn a blank tag into a ticket + wallet (walk-up), **or** bind a blank tag to an existing (online/QR) ticket.
2. Load cash onto the wallet.
3. Tap the tag to see its balance + recent history.
4. Tap the tag at the gate → resolve its ticket → check in (same result as scanning the QR).

## 2. The "tag = ticket" model (the one new design decision)

The user's goal is to avoid "bumbling with two artifacts." The resolution is **not** to merge tags and tickets into one record. It is:

> **A tag is a bearer credential that points at a ticket. The ticket remains the source of truth.**

The ticket is what was paid for, what carries the price tier, what the event capacity counts against, and what a refund targets. The tag's factory UID is a second credential type (alongside the QR code) that resolves to that same ticket — exactly as the already-built wallet is keyed to the ticket (`Wallet.ticketId`, unique). "The tag is the ticket" therefore means **one tap does entry + wallet**, without collapsing two models and without rewriting the ticket/refund/capacity logic.

This produces exactly two new capabilities on top of the built binding:
- **Tag-as-entry** — the gate scanner accepts a tag UID, resolves it to its ticket, and runs the existing check-in path.
- **Sell-band-as-ticket** — a walk-up path that issues a ticket + binds a tag + optionally loads cash in one atomic step, so a box-office sale needs only one artifact. (Online pre-sales still bind-at-gate — a URL cannot dispense a physical tag.)

### 2.1 Tags are read-only UID pointers — we never write to them

Every NFC tag carries a factory-burned **UID** in a locked, read-only area, broadcast during the anti-collision handshake before any memory access. Carrot reads that UID and keeps **all** state (balance, ticket binding, history) server-side, keyed by UID. We never write to the tag. Blank/cheap tags are the ideal input; there is no provisioning step. Consequences that are load-bearing for this design:
- No half-written-tag failure mode (a write dying mid-tap at a busy gate would corrupt a tag; a read cannot).
- A lost tag is safe — the balance was never on it; deactivate + reissue (already built) preserves it.
- **UID storage:** store the UID exactly as the reader returns it, lowercased hex, no separators. **4-byte UIDs (8 hex chars) are the minimum accepted** — common cheap NFC tags (e.g. MIFARE Classic) ship 4-byte UIDs, and there is no collision-defense reason to reject them: the unique-per-event index on `Wallet.bandUid` already rejects a duplicate UID at bind time, and cloning defense (per-tap spend cap, block-list) is server-side and applies regardless of UID length. The bind endpoints reject a UID shorter than 4 bytes.

The honest tradeoff — a bare UID is cloneable — is **not** defended by writing to the tag. It is defended server-side (per-tap spend cap, block-list, optional hardware-signed token *read* where chips support it). Those defenses live in the spend/vendor slices; **nothing for them is built in slice 1**, because slice 1 has no spend path.

## 3. Scope

**In scope**
- `Event.cashless` boolean flag (model + read/write through existing event settings).
- New `CASH_TOPUP` tickets permission; reuse of `SCAN_TICKETS` / `SELL_TICKETS`.
- Backend: sell-band-as-ticket endpoint; cash top-up endpoint; wallet-by-band read endpoint; gate check-in accepting a band UID.
- App (`carrot_tickets_pos`): a permission- and `cashless`-gated **Cashless mode** with native read-only NFC, a shared `TagReader`, and the register / top-up / balance / gate flows.
- Backend tests for every new endpoint and gate.

**Explicitly out of scope (later slices)**
- Vendor/merchant **tap-to-pay (spending)** and any `Merchant` model or management/inventory UI.
- Web (MoMo/card) top-up, refunds, and auto-sweep. Slice 1 is **cash top-up only**.
- Merchant settlement / withdrawal ("pay vendors").
- Reconciliation dashboards, fraud alerts, and the pre-go-live security review.
- Offline POS queueing (no spend path exists to queue).
- Any writing to tags or hardware-signed-token provisioning.

## 4. Data model

**Reused unchanged (already built on `feat/cashless-system`):** `LedgerEntry`, `Wallet` (`{ ticketId (unique), eventId, balance, cashFundedBalance, status, currency, ... }`), `BandBinding` (UID↔wallet audit trail), `WalletService.ensureWalletForTicket / bindBand / unbindBand`, `ScanService.bindBandToTicket / reissueBandForTicket`, `ReconciliationService`.

**New / changed:**
- **`Event.cashless: boolean`** — default `false`. When false, none of the band/wallet behavior is reachable for that event; the Cashless mode is hidden and the band-aware endpoints reject the event. This is the single switch that keeps the feature inert for ordinary ticketed events.
- **`WalletTopup`** — the parent spec's model, introduced here in its **cash-only** form: `{ walletId, eventId, amount (cents), method: 'cash', status: 'completed', recordedBy (operatorId), clientTxnId (idempotency), createdAt }`. Web/MoMo/card methods and `pending`/`failed` states are added in the top-up slice; slice 1 writes only completed cash rows.
- **`ResellerPermission.CASH_TOPUP = 'reseller:cash_topup'`** — new enum member in `src/interfaces/resellerPermission.interface.ts`. Cash top-up and sell-band are **reseller-authenticated** (see §5), so the new permission lives in the reseller system; gate-side band ops reuse the existing `TicketsPermission.SCAN_TICKETS`.

No change to `Ticket`. The tag→ticket link is `BandBinding` + `Wallet.ticketId`, both already present.

## 5. Backend endpoints

**5.0 Two auth systems (honored, not fought).** Carrot's staff app already straddles two auth contexts, and this slice places each endpoint in the one that matches the app screen calling it:
- **Reseller auth** (`authenticateReseller` → `req.reseller`, `ResellerPermission`) — the selling/box-office operator. The app's **PosPage** sells via `POST /api/reseller/sales`. **Sell-band and cash top-up are reseller-side.**
- **Tickets/gate auth** (`authenticateTickets` → `req.ticketsUser`, `TicketsPermission`) — the gate operator. The app's **ScanPage** validates/checks-in via `POST /api/tickets/scans/*` under `SCAN_TICKETS`. **Bind-to-existing (already built), gate-by-band, and wallet-by-band read are tickets-side.**

This maps the two issuance paths onto the two existing screens: **sell-band on PosPage (reseller)**, **bind-to-existing on ScanPage (gate)**.

All amounts are integer ZAR cents. Every money endpoint **fails loudly** — a failure surfaces as a non-2xx with a real reason; no canned-success fallback (workspace rule). Genuine server faults return 5xx (so money-path alerting can fire), distinguished from client/validation 4xx. The selected event id travels in the request body/params (`expectedEventId` / `eventId`), matching the existing handlers — there is no event header.

| # | Method + path | Auth · permission | Behavior |
|---|---|---|---|
| 1 | `POST /api/reseller/sales/sell-band` | reseller · `SELL_TICKETS` (+ `CASH_TOPUP` if `cashAmount > 0`) | **Idempotent orchestration** keyed on `clientTxnId` (§5.1): `ResellerSaleService.createSale` (cash, quantity 1) → `WalletService.ensureWalletForTicket` → `WalletService.bindBand(uid)` → if `cashAmount > 0`, `WalletService.topUpCash`. Returns sale + wallet + binding for printing. Rejects non-`cashless` events, already-bound UID, and <4-byte UID. |
| 2 | `POST /api/reseller/wallets/cash-topup` | reseller · `CASH_TOPUP` | Body `{ ticketId \| bandUid, eventId, amount, clientTxnId }`. `WalletService.topUpCash` in one transaction: balanced ledger post + atomic credit + `WalletTopup` row. **Idempotent on `clientTxnId`.** Rejects non-`cashless` events and non-`active` wallets. |
| 3 | `GET /api/tickets/wallets/by-band/:uid?eventId=` | tickets · `SCAN_TICKETS` | Resolve the active binding for the UID in that event → `{ ticket summary, balance, cashFundedBalance, status, recent history }`. 404 if no active binding. |
| 4 | `POST /api/tickets/scans/check-in` **extended** to accept `bandUid` alongside `ticketId` | tickets · `SCAN_TICKETS` | If `bandUid` given: resolve UID → active binding → ticket → the **existing** `ScanService.checkInTicket` path (unchanged validation, same idempotent `TicketStatus.CHECKED_IN` transition). Only when `event.cashless`. Unbound / wrong-event UID → distinct, human-readable reason. |
| — | `POST /api/tickets/scans/bind-band` (already built, reused) | tickets · `SCAN_TICKETS` | Bind-to-existing — the gate-side issuance path, unchanged. |

**5.1 Sell-band atomicity (honest scope).** Full one-Mongo-transaction atomicity across `createSale` + wallet ops is **out of scope for slice 1** — it would mean threading a mongoose session through the proven `createSale` money path. Because sell-band is **cash-only** (no external charge; nothing moves until the sale row is written), the endpoint is instead an **idempotent orchestration of individually-safe steps**: `createSale` persists `clientTxnId` on the sale so a duplicate request returns the existing sale rather than re-issuing; `ensureWalletForTicket` is an idempotent upsert; `bindBand` is a CAS. The one partial failure worth naming: if the bind fails *after* the ticket + wallet exist (e.g. the UID is already bound), the endpoint returns the error **loudly** and leaves a `SOLD` ticket with no band — fully recoverable by a later bind-to-existing. Nothing is lost or double-charged. Full transactional sell-band is a hardening item for a later slice.

**Ledger postings (parent spec §3, debit-positive):** cash top-up of `X` → `float +X` (Dr, tag `cash_desk`), `wallet −X` (Cr); Σ = 0. Plus the atomic credit adding `X` to **both** `balance` and `cashFundedBalance` via an aggregation-pipeline update (not `$inc` — the model's `cashFundedBalance ≤ balance` invariant is a `pre('validate')` hook that does **not** fire on updates, so the credit must keep them consistent itself). Postings + credit + `WalletTopup` row commit in one Mongo transaction, so `WalletService.topUpCash` requires a replica-set connection (the `connectLedgerTestDb` harness), exactly like `LedgerService.post`.

**Idempotency** uses the established single-arbiter pattern: each operation persists its `clientTxnId` on a record always created for it — sell-band on its `ResellerSale`/`TicketSale`, cash top-up on its `WalletTopup` — under a unique index; a duplicate request is recognized by that index and returns the original outcome. `LedgerService.post` is intentionally non-idempotent, so exactly-once is enforced by this caller-side guard, never by re-posting.

## 6. App — `carrot_tickets_pos`

**Dependencies / platform:** add `nfc_manager` and the Android `<uses-permission android:name="android.permission.NFC"/>` (+ foreground-dispatch wiring). NFC is used **read-only** — we read the tag identifier (UID) only; no NDEF read/write. Reading the UID natively is more reliable than WebNFC and is why this lives in the app rather than a web page.

**Gating.** The app has **no per-permission array** today — it gates by operator **type** only (`Session.type` is `'reseller'` → PosPage, or `'gate'` → ScanPage). Slice 1 keeps that model: cashless controls appear only when (a) the operator type matches the screen and (b) the **selected event is `cashless`**. On a non-cashless event, both screens behave exactly as today. The backend still enforces the real permission on every call (defense in depth), so the app never needs a permissions array. The event list responses (`ResellerApi.getEvents` / `GateApi.events`) must include the `cashless` flag so the app can gate on it.

**Shared component (DRY):** a single `TagReader` widget encapsulates the native NFC session and returns a UID string. Every flow funnels through it — no flow reads NFC directly.

**Flows / screens (split across the two existing screens, matching §5.0):**
- **PosPage (reseller)** — gains, when the selected event is cashless:
  - *Sell band as ticket* — pick ticket type → optional initial cash amount → `TagReader` tap → `POST /api/reseller/sales/sell-band` → print receipt. One artifact, no pre-existing QR.
  - *Cash top-up* — identify the wallet (tap tag) → enter amount → `POST /api/reseller/wallets/cash-topup`.
- **ScanPage (gate)** — gains, when the selected event is cashless:
  - *Bind to existing ticket* — scan the ticket QR (existing `mobile_scanner`) or look it up → `TagReader` tap → `POST /api/tickets/scans/bind-band` (already built).
  - *Tap-to-check-in* — a "tap band" affordance beside the QR scanner → `POST /api/tickets/scans/check-in` with `bandUid`. Both QR and tag work.
  - *Balance* — `TagReader` tap → `GET /api/tickets/wallets/by-band/:uid` → show balance + recent history.

## 7. Permissions & guard rails

- **Permissions (two systems, per §5.0):** tickets-side `TicketsPermission.SCAN_TICKETS` covers bind-to-existing / band-read / gate-by-band; reseller-side `ResellerPermission.SELL_TICKETS` covers sell-band, and the **new** `ResellerPermission.CASH_TOPUP` covers cash top-up (and sell-band's optional initial load). Granular, matching the existing operator model — no single broad `MANAGE_CASHLESS`.
- **Event gate:** every band/wallet endpoint and the Cashless mode require `event.cashless`.
- **One active band per ticket / per event:** enforced by the built `{eventId, bandUid}` partial-unique index and `Wallet.ticketId` uniqueness; a second bind attempt fails loudly.
- **Lost tag:** reissue is already built (`reissueBandForTicket`) — unbind old UID (audit) → bind new UID, balance intact.
- **Fail loudly:** no silent fallbacks on any money path.

## 8. Testing & verification

**Backend (self-verified in full, reusing the existing jest harness):**
- `sell-band`: happy path issues ticket + wallet + binding (+ optional cash); a duplicate `clientTxnId` does not double-issue (returns the original sale); a bind failure after ticket creation surfaces the error loudly and leaves a `SOLD`, still-bindable ticket (per §5.1) — asserted, not a rollback; rejects non-cashless event, already-bound UID, and <4-byte UID; the optional-load path enforces `CASH_TOPUP`.
- `cash-topup`: writes one balanced ledger txn (`float +X` cash_desk / `wallet −X`), increments `balance` **and** `cashFundedBalance` by `X`; idempotent on `clientTxnId`; rejects non-cashless event and non-active wallet; `ReconciliationService.checkWalletBalances` shows no drift after a random sequence of top-ups.
- `wallet-by-band`: returns the correct wallet for an active binding; 404 on unbound UID; scoped to the operator's event.
- gate-by-band: a bound UID checks in the right ticket via the existing path; idempotent re-tap is a no-op; unbound / wrong-event UID rejected with distinct reasons; blocked when event not cashless.
- permission gates: each endpoint rejects a token missing its required permission.

**App:** per the standing rule, the APK is **not** built or run without an explicit request. The Dart is written so its logic (state, API calls, error handling) is sound and reviewable; the on-device tap is verified by the user on their phone/handheld as a green-lit step.

## 9. Step 0 — integration prerequisite (before any slice-1 code)

Slice 1 consumes the built ledger + wallet + binding, which are unmerged and behind. Before building:
1. Rebase `feat/cashless-system` onto current `main` (single known conflict: `src/models/vendor.model.ts` — SP1 removed duplicate index declarations, `main` added operator-type/logo work).
2. Confirm the suite is green at `npx jest --maxWorkers=4` (the full-worker run is flaky on a loaded machine — a startup-contention flake, not a logic bug).
3. The prod **TTL-index migration** (`RefreshToken` / `BuyerOtp` `expiresAt_1`) entangled in SP1's Task 1 remains a **separate, explicitly-authorized** operation. Slice 1 does **not** trigger it; do not couple them.

Slice-1 work then proceeds on a dedicated branch/worktree off the rebased base, isolated from any concurrent agent's checkout.

## 10. Build sequence within this slice

1. Step 0 integration (above).
2. `Event.cashless` flag + `CASH_TOPUP` permission.
3. `POST /wallets/cash-topup` (+ `WalletTopup` cash form) — smallest new money movement, unblocks "watch a balance move."
4. `POST /scans/sell-band` (atomic issue+bind+optional-load).
5. `GET /wallets/by-band/:uid` and gate check-in-by-band.
6. App: `nfc_manager` + `TagReader`, then Register / Top-up / Balance / Gate flows behind the cashless gate.

Each backend step is independently testable; the app layer lands last on top of a fully-tested backend.

## 11. Deferred / open (do not block this slice)

- **Commission direction** (merchant-paid vs attendee-paid) — irrelevant until the spend/vendor slice.
- **Band/reader hardware naming & anti-clone token** — slice 1 is UID-only by design.
- **`event.cashless` settings UI** — the flag + API support are in-scope; a polished organizer/admin toggle can be a thin follow-up if the minimal control proves insufficient.
- **Cash top-up on the dashboard cash-desk** — slice 1 puts cash top-up on the handheld; the dashboard cash-desk is the parent spec's eventual home and arrives with the full top-up slice.
