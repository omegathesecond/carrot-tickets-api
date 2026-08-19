# Cashless — Cashier role, attendee withdrawals & organizer reporting

**Date:** 2026-08-11
**Status:** Design — awaiting review
**Branch:** `feat/cashless-cashier` (off `feat/cashless-tag-ticket` @ 2e4443f)
**Repos:** `api` (backend), `pos-app` (Flutter handheld), `dashboard` (organizer web)
**Builds on:** `2026-08-07-cashless-tag-ticket-registration-design.md` (the wallet/ledger/reseller/vendor/gate system)

---

## 1. Why

Client feedback on the cashless system:

> "Add a **Cashier** role in charge of **topping up & withdrawing** user funds *inside the venue*.
> A **reseller** sells tickets and helps top-ups *before* the event; once inside, **cashiers** handle
> the funds. **Separate the cashier from the reseller** — the cashier must see the transactions she did
> and their status, in case a user complains about funds not reflecting.
> On the **organiser dashboard** show vendor transactions, top-ups, withdrawals — how much each vendor
> made, how much money circulated, how much users left behind un-withdrawn.
> After a top-up or purchase, show a screen with the transaction and the **LEFT BALANCE** so staff can
> show the attendee how much is left / that the right amount was taken."

Two capabilities are genuinely missing today: a **Cashier actor**, and **attendee cash-out (withdrawal)** — money *out* of a wallet. (The existing `withdrawal.service.ts` is unrelated: it pays *reseller commission* out. The "left balance" receipt already ships in the POS for top-up and charge.)

## 2. Actor taxonomy (client language ↔ code)

The client's words are authoritative in every **UI label**. Some differ from the stored model name — we keep the stored names (renaming them is out of scope and breaks a lot) but never surface "reseller" anywhere near a cashier.

| Client label | Meaning | Stored as | Auth |
|---|---|---|---|
| **Organizer** | Owns the event; in charge; sees all cashless activity | `Vendor` | tickets `OWNER` JWT |
| **Cashier** *(new)* | Works for the organizer; tops up + withdraws in-venue; sees own transactions | **`Cashier` (new)** | tickets `cashier` JWT |
| **Vendor** | In-event seller (bar, food stall); charges bands; sees takings | `Merchant` | merchant JWT |
| **Reseller** | External ticket outlet (e.g. Shoprite); sells tickets pre-event | `Reseller`/`ResellerOperator` | reseller JWT |
| **Gate** | Check-in / band binding | `GateOperator` | tickets `gate-operator` JWT |
| **Admin** | Carrot/Omevision; sees everything | platform super-admin | — |

**Naming rule for implementers:** no cashier-facing string, route, token field, seed label, or dashboard label may contain "reseller". The Cashier is its own actor, modelled on `GateOperator`, **not** a `ResellerRole`.

## 3. Scope

In scope (this project, one branch per repo):

1. **Cashier actor + auth** (api) — a new PIN-login operator scoped to an organizer.
2. **Attendee withdrawal (cash-out)** money flow (api) — the mirror of cash top-up.
3. **Cashier "my transactions"** view (api + pos-app).
4. **Organizer cashless reporting** (api + dashboard) — full transaction log + per-vendor takings + totals.
5. **POS**: cashier login → top-up (exists) + **withdraw** (new) + my-transactions; withdrawal reuses the "New balance" receipt.
6. **Dashboard**: organizer manages cashiers (Add/Deactivate) + a Cashless report page.
7. **Seed**: enrich the existing dev demo (same event/actors) with a Cashier + sample withdrawals, as a committed, repeatable script.

Out of scope (deferred, unchanged from the parent spec): settlement/payout of vendor takings, item/inventory buttons, card/MoMo top-up, offline mode, auto-sweep/auto-refund of residual card balance.

## 4. Cashier actor (api)

Mirror `GateOperator` exactly — it already proves the "per-organizer, non-reseller, PIN-login" shape.

**Model** `src/models/cashier.model.ts`:
```
Cashier {
  fullName: string (required)
  phoneNumber?: string (unique, sparse)
  loginCode: string (required, unique, indexed)     // 6-digit
  scope: 'platform' | 'organizer' (required, indexed)
  vendorId?: ObjectId → Vendor (organizer; required when scope='organizer')
  isActive: boolean (default true, indexed)
  ...applyOperatorCredentials(schema)               // pin (hashed, select:false), lockout, comparePin
}
index { vendorId: 1, isActive: 1 }
toJSON/toObject strip pin
```
Reuses the shared `applyOperatorCredentials` — **no new auth crypto**.

**Auth** `src/services/cashierAuth.service.ts` — a near-copy of `GateOperatorAuthService.login` (same lockout constants, same failure semantics), issuing:
```
{
  app: 'tickets',
  userType: 'cashier',
  userId: <cashierId>,
  role: 'cashier',
  permissions: CASHIER_PERMISSIONS,
  isSuperAdmin: scope === 'platform',
  vendorId: <organizerId>            // omitted when platform-scoped
}
```

**Permissions.** Cashier issues a `tickets`-app token (like gate), so its permissions live in the `tickets:` namespace. Add to `TicketsPermission`:
- `CASH_TOPUP = 'tickets:cash_topup'`
- `CASH_WITHDRAW = 'tickets:cash_withdraw'`
- `VIEW_OWN_CASHLESS_TXNS = 'tickets:view_own_cashless_txns'`

and a role `TicketsRole.CASHIER = 'tickets_cashier'` →
`[VIEW_EVENTS, CASH_TOPUP, CASH_WITHDRAW, VIEW_OWN_CASHLESS_TXNS]`. No `SELL_TICKETS`, no scan, no event management. (These are additive to the enum; they are **not** added to any existing role's default set — OWNER already gets everything except platform-staff perms, which is the right outcome: an organizer can do everything a cashier can.)

*Note:* the reseller keeps its own `reseller:cash_topup` (different token scope, different endpoint). The two top-up permissions coexist because the actors are distinct; the shared logic is the service, not the permission.

**Admin/management** `src/controllers/cashierAdmin.controller.ts` + routes:
- Organizer (OWNER/MANAGER, scoped to own `vendorId`): `POST /api/organizer/cashiers` (create → returns generated `loginCode` + `pin` once), `GET /api/organizer/cashiers`, `PATCH /api/organizer/cashiers/:id` (deactivate/reactivate).
- Platform admin may create `scope:'platform'` cashiers.
Login-code generation reuses whatever `generateLoginCode` the gate/reseller admin controllers use (uniqueness-checked).

**Cashier middleware** `src/middleware/cashierAuth.middleware.ts` — verifies the JWT, asserts `userType === 'cashier'`, loads permissions, exposes `req.cashier = { id, vendorId, scope }`. Same shape as `resellerAuth`/gate middleware.

## 5. Withdrawal — attendee cash-out (api)

The new money-out primitive, the exact mirror of `WalletService.topUpCash` / `MerchantService.charge`.

**Decision (confirmed):** *cash back = full remaining balance.* A cashier may return the attendee's **entire** remaining balance in cash regardless of how it was loaded. We still track the cash-funded portion for the organizer's drawer reconciliation, but never block the cash-out on it.

**Model** `src/models/walletWithdrawal.model.ts` — mirrors `WalletTopup`:
```
WalletWithdrawal {
  walletId, eventId, amount (int cents, >0),
  method: 'cash',
  status: 'completed',
  recordedBy: string,                 // cashier id
  recordedByType: 'Cashier',          // NEW discriminator (see §6)
  clientTxnId: string,
}
index { walletId: 1, clientTxnId: 1 } unique   // idempotency
```

**Service** `WalletService.withdrawCash({ walletId, eventId, amount, recordedBy, clientTxnId })`:
- Idempotent pre-check on `{walletId, clientTxnId}` (return original outcome on repeat).
- Inside a transaction, atomic **CAS debit** (same guard shape as `MerchantService.charge`):
  ```
  Wallet.findOneAndUpdate(
    { _id: walletId, eventId, status: 'active', balance: { $gte: amount } },
    [{ $set: {
        balance:           { $subtract: ['$balance', amount] },
        cashFundedBalance: { $max: [0, { $subtract: ['$cashFundedBalance', amount] }] },
    }}],
    { new: true, session },
  )
  ```
  Null result → throw `WithdrawalDeclinedError('insufficient_balance' | 'wallet_not_active' | 'wallet_not_found', currentBalance)` — re-read to report the true reason + current balance, exactly like the charge path. The balance is left **untouched** on decline.
- **Ledger** (reverse of top-up, still balanced — sum of deltas = 0):
  ```
  { account: FLOAT,        delta: -amount, tag: CASH_DESK }   // we hold less cash
  { account: WALLET:ref,   delta: +amount }                   // liability to attendee reduced
  refType: 'wallet_withdrawal', refId: clientTxnId
  ```
- Insert the `WalletWithdrawal` row; E11000 on the unique index re-reads the winner (concurrent-duplicate safety).
- Reuse `MAX_TOPUP_CENTS` (or a symmetric `MAX_WITHDRAW_CENTS`) as a defense-in-depth ceiling.

The ledger invariant `float = wallets owed + merchants owed + fees` continues to hold after a withdrawal, so `ReconciliationService` needs no change. *Reconciliation note for ops (documented, not blocking):* paying out cash against a card-funded balance moves value from the Keshless-held float to the organizer's cash drawer; once card/MoMo top-up exists this is a real settlement line. Today only cash top-up exists, so `cashFundedBalance == balance` and the case can't yet arise.

**Endpoints (cashier-guarded)** `src/routes/cashier.route.ts`:
- `POST /api/cashier/withdraw` `{ eventId, bandUid, amount, clientTxnId }` → resolves wallet by band (reusing the topup path's band→wallet resolution), calls `withdrawCash`, returns `{ wallet: { balance, ... }, withdrawal }`. Response carries the new balance for the receipt.
- `POST /api/cashier/topup` — same handler the reseller uses, but under the cashier token (delegates to `WalletService.topUpCash`, `recordedByType: 'Cashier'`).
- `GET /api/cashier/balance?eventId=&bandUid=` — balance + unified history (see §6), so a cashier can answer "how much is left?".
- `GET /api/cashier/transactions?eventId=` — **my transactions** (§7).

## 6. Actor-tagged transaction records

To let both the cashier's "my transactions" and the organizer report attribute money moves, add a discriminator to the money-move records:

- `WalletTopup`: add `recordedByType: 'Cashier' | 'ResellerOperator' | 'Merchant' | 'Platform'` (default preserves existing rows — backfill existing to `'ResellerOperator'`, the only historical writer). *(This is an additive field; per the no-silent-back-compat rule it is called out explicitly here for approval.)*
- `WalletWithdrawal`: `recordedByType` as above (always `'Cashier'` in v1).

`WalletService.getWalletViewByBand` is extended to merge **top-ups + withdrawals + merchant charges** into one time-sorted `history` (currently top-ups only), each tagged `{ type: 'topup'|'withdrawal'|'purchase', amount, at, status }`, so the balance-check and receipt screens show a true statement.

## 7. Cashier "my transactions" (api + pos)

`GET /api/cashier/transactions?eventId=` → the union of `WalletTopup` and `WalletWithdrawal` where `recordedBy = <cashierId>` (scoped to the event), newest first, each with `{ type, amount, status, at, maskedBand }`, plus a session summary `{ toppedUp, withdrawn, net, count }`. This is what lets a cashier answer "your funds didn't reflect" — she sees the row and its status.

POS: a **Transactions** tab on the cashier shell (mirrors the Vendor "Takings" tab).

## 8. Organizer cashless reporting (api + dashboard)

The organizer (Vendor OWNER) is *in charge* and must see **everything** cashless in their event. Endpoints are scoped to events the vendor owns (existing ownership guard) + `VIEW_REVENUE`/`VIEW_STATS`.

`GET /api/organizer/events/:eventId/cashless/summary` →
```
{
  circulated:      <sum of top-ups, cents>,        // money loaded onto bands
  spent:           <sum of merchant charges>,      // money spent at vendors
  withdrawn:       <sum of withdrawals>,           // money handed back
  leftBehind:      <sum of remaining wallet balances>,   // un-withdrawn (== circulated - spent - withdrawn)
  fees:            <Carrot commission collected>,
  walletsFunded:   <count of wallets with any top-up>,
  vendors: [ { merchantId, name, gross, commission, net, chargeCount } ],   // per-vendor takings
  cashiers: [ { cashierId, name, toppedUp, withdrawn, txnCount } ]          // per-cashier activity
}
```
All figures come from the **ledger + wallets** (authoritative, always balanced) — not recomputed from app state.

`GET /api/organizer/events/:eventId/cashless/transactions?type=&cursor=` → the **full event transaction log** (top-ups, withdrawals, vendor charges) — paginated, filterable by type/vendor/cashier — because "they'll be in charge" means a drill-down, not just totals.

Dashboard: a **Cashless** tab on the event page with the summary tiles (Circulated / Spent / Withdrawn / **Left behind**), a per-vendor takings table, a per-cashier table, and the paginated transaction log. Plus a **Cashiers** management section (§4).

## 9. POS (pos-app, `feat/cashless-pos`)

- **Login routing**: `userType: 'cashier'` → Cashier shell (Top-up · Withdraw · Transactions · Balance check). Reuses the NFC read + money widgets already there.
- **Withdraw screen**: tap band → enter amount → confirm → **reuse the existing "New balance: RXX" success view** (the receipt the client asked for). Decline path mirrors the charge screen's "Declined · Balance RX".
- **Top-up**: the existing `cash_topup_sheet` under the cashier token.
- **Transactions tab**: lists `GET /api/cashier/transactions`.

## 10. Seed enrichment (dev)

Dev already holds the demo (created ad-hoc, timestamp-suffixed): event "Cashless NFC Tap Test Fest", reseller `597081`, vendor "Test Bar" `640220`, gate `380443`, 4 wallets, 8 top-ups, 2 charges. **Reuse it.** Write a committed, idempotent `src/scripts/seedCashlessDemo.ts` (`npm run seed:cashless`) that:
- Finds-or-creates the demo event + reseller + vendor + gate (so it's repeatable and documents the fixtures), **and**
- Adds a **Cashier** (organizer-scoped to the event's Vendor) with a fixed demo `loginCode`/`pin`, and
- Records a couple of sample **withdrawals** against existing funded wallets (via `WalletService.withdrawCash`, so the ledger stays real), so the organizer report and cashier "my transactions" have data on first view.
Run it against `carrot-tickets-dev`. Update `CASHLESS_DEMO_GUIDE.md` with the cashier login + a "cash out" act, and `SEED_DATA.md` with the new script.

## 11. Build slices (for the plan)

1. **Cashier actor + auth + admin** (api) — model, auth service, permissions, middleware, admin controller/routes, tests.
2. **Withdrawal money flow** (api) — `WalletWithdrawal` model, `WalletService.withdrawCash`, ledger, `recordedByType`, unified history, cashier topup/withdraw/balance endpoints, tests (incl. decline safety + idempotency + ledger-invariant property test).
3. **Cashier my-transactions** (api) + **organizer reporting** endpoints (api), tests.
4. **POS** cashier shell (login routing, withdraw screen + receipt, transactions tab).
5. **Dashboard** organizer Cashless tab + Cashiers management.
6. **Seed** script + run on dev + docs.

Each api slice is TDD; money paths get the same adversarial tests as the existing charge/top-up (decline leaves balance untouched, idempotent on `clientTxnId`, ledger stays balanced).

## 12. Deploy topology (unchanged)

- api: `gcloud run deploy carrot-tickets-api --source .` (prod) / dev trigger; realtime shares the image. Merge onto the cashless line, not `main`, until the whole cashless system ships.
- dashboard: Cloudflare Pages (contracts CF account), prod branch `main`.
- pos-app: EAS/APK build shared out of band (dev points at `dev-api.carrottickets.com`).

## 13. Open questions

- **Cashier ↔ event binding**: cashier is organizer-scoped and picks the event per session (mirrors gate). Confirm organizers don't need a cashier pinned to a single event.
- **Who deactivates a cashier at event end?** Organizer self-serve (assumed) — confirm.
- **"Money left behind" at event end**: reported live as the sum of remaining balances. A formal end-of-event close/auto-refund is deferred (parent spec's office-collection model still applies).
