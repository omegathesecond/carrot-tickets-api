# Stock controller: a stall-scoped `manage_stock` grant

**Date:** 2026-09-05
**Status:** Design — approved in chat, pending spec review
**Surfaces:** `carrot-tickets-api`, `pos-app`, `carrot-tickets-dashboard`

## Problem

At a cashless event there are many stalls, and each one holds its own stock:
someone sells sandwiches, someone else sells drinks, and the organizer may run
shops of their own. Each of those is a `Merchant` — a stall at one event — and
`ProductStock` is already keyed `(merchantId, productId)`, so the ledger is
per-stall today.

What has no home is the **person who controls that stall's stock**.

### Stock can only be added from a browser

`POST /tickets/events/:eventId/stock/receive`, `/transfer` and `/count` are
gated on `TicketsPermission.MANAGE_STOCK` — an organizer team member on the
dashboard. The POS-facing merchant token carries a single fixed permission
(`merchant:charge`); a stall operator can read `/merchant/stock` and post a
stock-take, and that is all. When a delivery arrives at the sandwich stall,
nobody at the stall can enter it. Someone in the office has to, for every
stall, all night.

### Waste has a column but no writer

`StockMovementReason.SPOILAGE` exists and `StockReportService` already folds a
`spoilage` figure into the reconciliation report — but nothing in the codebase
has ever written a spoilage movement. The column reads zero at every event
because breakages are recorded nowhere.

### Stall staff have no per-person capabilities

`GateOperator` rows carry `grants` and the register desk is expressed as one
(`OperatorGrant.ISSUE_TAGS`), following the rule stated in
`operatorGrant.interface.ts`: *roles stay the floor, grants are the per-person
extras*. `MerchantAuthService.login` mints `permissions: [CHARGE]` from a
hard-coded literal, with a comment noting there is "no role/permission matrix
to look up, unlike" gate operators. Stall staff are therefore all identical,
even though the stock job and the till job are different jobs.

## Non-goals

- **A fifth operator population.** A stock controller is a `MerchantOperator`
  carrying a grant, not a new collection — the same shape the register desk
  took on the gate side.
- **A separate stock-only POS login type.** `type` stays `'merchant'`; the POS
  decides what to show from `permissions`. A storeman who must not take
  payments is a later `canCharge: false` flag, not a new shell.
- **Creating catalogue products from the handheld.** Price is revenue and stays
  with the organizer on the dashboard. An unknown barcode is refused.
- **A two-step transfer.** Transfers land immediately, as they do on the
  dashboard today.
- **Tightening the existing stock-take.** `POST /merchant/stock/count` stays
  open to any operator with `merchant:charge`; moving it behind the new grant
  would take a capability away from staff who have it today.
- **New monitoring UI.** `EventStockReport` already renders the board, event
  dashboard, reconciliation and a paginated movements log.

## Design

### 1. The grant and its translation

`MerchantOperator` needs no schema change: `grants` arrives from the shared
`applyOperatorCredentials()` schema, which all four operator populations apply.
It is already enum-validated with `default: []`.

```
OperatorGrant.MANAGE_STOCK      = 'manage_stock'            // new
MerchantPermission.MANAGE_STOCK = 'merchant:manage_stock'   // new
```

`TICKETS_BY_GRANT` and `CASHIER_BY_GRANT` are currently total
`Record<OperatorGrant, …>` maps — they typecheck only because one grant exists.
A second grant forces every namespace to answer for it, and stock is
stall-scoped: a gate operator or cashier holding `manage_stock` must gain
nothing. Both maps become `Partial<Record<…>>`, and the translators drop
grants with no mapping in that namespace — the same instinct as the existing
filter that already discards unknown values. Alongside them:

```ts
const MERCHANT_BY_GRANT: Partial<Record<OperatorGrant, MerchantPermission>> = {
  [OperatorGrant.MANAGE_STOCK]: MerchantPermission.MANAGE_STOCK,
};
export function grantedMerchantPermissions(grants?: string[] | null): MerchantPermission[]
```

`MerchantAuthService.login` mints
`permissions: [CHARGE, ...grantedMerchantPermissions(operator.grants)]`.
`CHARGE` stays the floor, so every existing operator is unaffected.

### 2. Grants are read per request, not from the token

`requireMerchantPermission` reads `permissions` off the JWT, and merchant
tokens live 7 days — so revoking a grant would not take effect for a week.
`authenticateMerchant` already re-reads the operator row on every request for
liveness (`.select('isActive')`), for exactly the reason its comment gives: a
sacked operator otherwise "kept reading the stall's takings… until their token
expired". Widen that projection to `.select('isActive grants')` and derive the
permission set per request from the row. Same query, no extra round trip, and
the fix covers every future grant as well as this one.

The JWT keeps carrying `permissions` for the POS to render from; the server
never trusts it for authorization.

### 3. Three write paths on the merchant router

All three mount on the existing `/api/merchant` router (already
`router.use(authenticateMerchant)`), each guarded by
`requireMerchantPermission(MerchantPermission.MANAGE_STOCK)`. **`merchantId`
and `eventId` come from the JWT, never from the body** — a stall can only move
its own stock.

| Route | Body | Effect |
|---|---|---|
| `POST /merchant/stock/receive` | `{ productId, qty, note? }` | `StockService.applyMovement(+qty, RECEIVE)` |
| `POST /merchant/stock/waste` | `{ productId, qty, note? }` | `StockService.applyMovement(-qty, SPOILAGE)` |
| `POST /merchant/stock/transfer` | `{ productId, toMerchantId, qty, note? }` | `StockTransferService.transfer`, `fromMerchantId` forced to the token's stall |

Each attributes `byType: 'Merchant', by: merchantOperatorId`, exactly as
`MerchantController.recordCount` does today, so the existing movements log
names the human with no change to the read side. Each validates that the
product belongs to the token's event — the check `recordCount` already makes.

`applyMovement`'s CAS guard (a decrement matches only when
`onHand >= -delta`) means waste and transfer-out cannot drive a stall negative;
the write simply fails.

One supporting read is also new:

```
GET /merchant/stalls → [{ merchantId, name }]   // active stalls at this event
```

without it the transfer screen has no destination to offer. It is guarded by
the same permission.

### 4. POS

The Stock tab in `merchant_shell.dart` is a stock-take today: product rows with
on-hand and a per-row Submit. That stays exactly as-is for operators without
the grant — no new affordances appear.

With `merchant:manage_stock` present, the tab gains:

- **A Scan button** wired to the existing
  `showScanBarcodeSheet(context:, products:, onAdd:)`. It already matches
  EAN/UPC client-side against the fetched catalogue, keeps scanning after a
  hit, and shows *"Not in catalogue"* for an unknown code — already the
  refusal this design wants. Only `onAdd` changes: it opens the action sheet
  instead of adding to a basket.
- **Receive / Waste / Transfer** on that sheet, also reachable by tapping a row
  so barcodeless items (ice, cups) are not stranded.
- **Receive in cases.** `StockProduct` already carries `unitsPerPack` and
  `packLabel`. When `unitsPerPack != null` the quantity field offers a
  cases ⇄ units toggle and sends base units — a delivery is 5 cases, not 120
  bottles.
- **Transfer** picks a destination from `GET /merchant/stalls`, then a quantity.

After each write the row's on-hand updates from the response — `applyMovement`
returns `onHand`, which is what `_submit` already consumes. Failures surface
through the existing `_snack(msg, isError: true)` carrying the API's own
message; nothing is swallowed.

### 5. Dashboard

`merchantOperatorAdmin` create and patch accept
`grants: sanitizeGrants(req.body.grants)` — the two lines `gateOperatorAdmin`
already runs on both handlers.

`OperatorGrantsField` moves into `StallOperatorsPanel`. It currently renders
**every** grant in `OPERATOR_GRANT_LABELS`, on the stated assumption that "a
grant means the same thing to both" populations. A stall-scoped grant ends
that: unchanged, it would offer `issue_tags` to stall staff and `manage_stock`
to gate operators, both inert. Each grant therefore gains an `appliesTo`, and
each admin surface renders only the grants that mean something there. This must
land in the same change as the second grant, or the UI lies the moment it
exists.

Monitoring needs no new views: `EventStockReport` already renders the board,
event dashboard, reconciliation and a paginated movements log, and the
`spoilage` column starts carrying real figures the moment the waste path
exists.

One deliberate addition, though — without it the dashboard cannot answer "who
moved this". `StockReportService.movements` resolves `productName` and
`merchantName` through id → name maps but returns `by` raw, which for every
POS-side write is a `merchantOperatorId` hex string. It gains a third map over
`MerchantOperator.find(…).select('fullName')` and returns `byName` beside `by`
(falling back to `'Unknown operator'`, matching the `'Unknown bar'` convention
already there); the movements table renders `byName ?? by`. Organizer-side
writes keep whatever `by` they set today.

## Error handling

| Case | Result |
|---|---|
| Waste or transfer exceeds on-hand | CAS matches nothing → 400 "not enough on hand", balance untouched |
| Product not in the token's event | 400 |
| Destination stall suspended, missing, or at another event | 400 |
| Operator lacks the grant | 403 from `requireMerchantPermission` |
| Grant revoked mid-token | 403 on the next request, via §2's per-request read |
| Operator deactivated or stall suspended | 401, unchanged from `authenticateMerchant` |
| Database failure | 500 through the error handler, never a 401 — as the middleware already insists |

No path substitutes a default for a failed call. A refused scan says why.

## Testing

New route tests beside the existing `stockAdmin` / `stockCount` /
`stockTransfer` suites:

- no grant → 403 on all three routes; with grant → 200
- grant removed while the token is still valid → 403 on the next request
- a body-supplied `merchantId` is ignored; `fromMerchantId` is always the
  token's stall
- receive and waste move both the ledger and `onHand`; the `onHand == Σ delta`
  invariant still holds (extend the existing property test)
- waste beyond on-hand → 400 with the balance unchanged
- transfer to a stall at another event → 400
- a gate operator granted `manage_stock` gains no `TicketsPermission` from it,
  and a stall operator granted `issue_tags` gains no merchant permission
- `GET /merchant/stalls` returns only active stalls at the token's event
- a movement written by a stall operator comes back with `byName` set to that
  operator's full name, and an unresolvable `by` falls back rather than leaking
  a bare id

POS: a widget test for the cases → base-units conversion on receive.

## Sequencing

Two changes, each reviewable on its own.

1. **API** — grant, permission, per-request derivation, the three routes, the
   stalls list, the admin grants wiring, and `byName` on the movements
   response, with the tests above. Inert until a client uses it, and harmless:
   no existing operator's permission set moves.
2. **POS + dashboard** — the Stock tab actions; the grant switch in
   `StallOperatorsPanel` (with `appliesTo`); the movements table rendering
   `byName ?? by`.

## Rollout

Nothing to migrate. `grants` already exists on every merchant operator row and
defaults to `[]`, so every operator keeps exactly today's permission set until
an organizer turns the switch on. The POS reads its capability from
`permissions`, so an old build simply never shows the new actions.
