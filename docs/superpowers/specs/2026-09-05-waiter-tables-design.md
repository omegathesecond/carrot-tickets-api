# Waiter tables — a running tab across stalls

**Date:** 2026-09-05
**Status:** design approved in chat; spec awaiting review

## What a waiter does

A waiter opens a table, walks the floor collecting drinks and food from
DIFFERENT stalls onto that one table, and settles it when the guests leave.
Nothing in the cashless system does this today: `MerchantCharge` is one stall
charging one tag once, and `MenuOrder` is a buyer pre-ordering and paying up
front through the gateway. Neither is a tab, and neither crosses stalls.

## Decisions taken, and why

**A table is a running tab, settled at the end** — not charged per round. This
is what table service means, and it is the reason the feature exists: tapping a
guest's tag for every round is the queue the waiter was hired to remove.

**A table is opened by NUMBER, with no tag attached.** The waiter opens
"Table 7" and taps a tag only at settle. This matches a bar: a group sits down
before anyone has decided who pays, and some of them may not hold a tag yet.
The cost is accepted deliberately — the tab is unbacked, the POS cannot warn as
it grows, and a table that leaves is a loss to the venue. That loss is made
visible rather than hidden (see Voiding, below).

**Settlement is all or nothing.** Tap a tag; if the balance does not cover the
whole bill, nothing is charged and the waiter is told the shortfall. A table is
open or settled, never partly paid. Partial settlement and splitting across
several tags were both considered and rejected as a first cut — they multiply
the states a floor operator has to reason about mid-service.

**Stock leaves the stall when the item is added, not at settle.** The drink
physically left the shelf when the waiter took it; a stall whose count only
moves at settle is wrong all night, and the discrepancy is worst exactly when
the venue is busiest. This means stock and money legitimately disagree in time
for the life of a tab — an accepted consequence of tabs, not a bug, and the
reason a stall's stock report and its takings report will not tie out mid-event.

## Data model

### `Waiter`

Mirrors `Cashier` exactly, which is the established shape for a per-event
in-venue operator: `fullName`, `phoneNumber?`, `loginCode`, `pin` (through the
shared `applyOperatorCredentials` mixin — hash, lockout, `comparePin`),
`scope: 'organizer'`, `vendorId`, `eventId` (immutable, required for organizer
scope), `isActive`, `grants`.

A waiter is NOT a `MerchantOperator` with a grant. That actor is scoped to one
stall, and crossing stalls is the waiter's entire job — reusing it would mean
weakening a scope that is load-bearing for stall security.

`POST /api/operator/login` gains a `type: 'waiter'` branch alongside the
existing `cashier` and `merchant` ones, so the POS routes on one field the way
it already does.

`WaiterPermission` namespace, same pattern as `CashierPermission`:
`waiter:view_events`, `waiter:manage_tables`, `waiter:settle_tables`. Settling
is separate from serving on purpose — an organizer may want the money moment
held by a supervisor.

### `Table`

```
eventId      ObjectId, required, indexed
label        string, required        // "7", "Terrace 2" — the waiter's words
status       'open' | 'settled' | 'voided'
openedBy     string                  // waiter id
items        [{ merchantId, productId, name, unitPrice, qty, addedBy, addedAt }]
subtotal     integer cents           // derived, stored for reporting
settledAt?   Date
settledBy?   string
walletId?    ObjectId                // the tag that paid
voidedAt?    Date
voidReason?  string
```

`{ eventId, label }` unique among OPEN tables via a partial index, so "Table 7"
cannot be open twice at one event while remaining reusable after settling.

Line prices are SNAPSHOTTED at add time (`unitPrice`, `name`), the way
`MerchantCharge.items` already does. A price change at the stall must not
silently reprice a drink somebody already drank.

## The waiter's flow

**Open** — `POST /api/waiter/tables` `{ label }`. Scoped to the waiter's event.

**Add items** — `POST /api/waiter/tables/:id/items` `{ merchantId, productId, qty }`.
Validates the stall belongs to this event and the product to that stall, snapshots
name and price, appends the line, and deducts the stall's stock immediately with
`StockMovementReason.SALE`, `refType: 'table'`, `refId: tableId`. SALE rather than
a new reason because the item genuinely left as a sale; a new reason would have to
be taught to every stock report before any of them were correct.

**Remove a line** — `DELETE /api/waiter/tables/:id/items/:lineId`, open tables
only. Reverses the stock movement: this is the mis-punch case, where the drink
never left the counter. Distinct from voiding, below, which does NOT return
stock.

**Settle** — `POST /api/waiter/tables/:id/settle` `{ bandUid, clientTxnId }`.
See below.

**Void** — `POST /api/waiter/tables/:id/void` `{ reason }`. Closes an unpaid
table. Stock is NOT returned — the drinks were consumed or walked, and pretending
they returned to the shelf would make a loss look like it never happened. A
voided table is the venue's record of exactly that loss, with the reason and the
waiter attached.

## Settlement

One balanced journal entry, not N charges.

```
WALLET   ref=walletId   delta = +total          (debit-positive)
MERCHANT ref=stallA     delta = -netA
FEES                    delta = -feeA
MERCHANT ref=stallB     delta = -netB
FEES                    delta = -feeB
...
refType: 'table_settlement', refId: tableId
```

`LedgerService.post` accepts an arbitrary posting array that must sum to zero,
so the whole table lands atomically or not at all. Each stall's `fee` uses ITS
OWN `commissionPercent`, read fresh from the merchant document the way
`MerchantService.charge` already does, so a rate change takes effect immediately
and one stall's rate never leaks onto another's line.

A `MerchantCharge` is written per stall alongside, inside the same transaction,
so every existing stall report, settlement run and reconciliation keeps working
with no knowledge of tables.

**Order of operations.** Read the wallet balance, compute the total, and refuse
BEFORE posting anything if it falls short — message names the shortfall
("R180.00 short"), because "declined" alone sends the waiter back to the table
with nothing to say. The status transition uses a guarded
`findOneAndUpdate({ _id, status: 'open' }, { status: 'settled' })` so two
simultaneous settles cannot both charge; the loser sees the table already
settled. `clientTxnId` makes a POS retry a replay rather than a second bill,
mirroring `MerchantService.charge`.

### The `merchantOperatorId` wrinkle

`MerchantCharge.merchantOperatorId` is `required` — the person on the till.
A table settlement has a WAITER instead, and inventing a fake operator id to
satisfy the schema would corrupt per-operator takings reports.

Decision: make `merchantOperatorId` optional, add `waiterId?`, and keep
`staffName` populated with the waiter's name so every existing display keeps
naming a human. Reports that group by operator must treat the absent case as
"table service" rather than dropping the row — a charge with no operator is
still money the stall is owed. This is the one change to an existing money model
and it needs its own test.

## Failure modes

- **Tag short at settle** — nothing charged, shortfall named, table stays open.
- **Table walks** — voided with a reason; stock stays gone; loss is visible.
- **Two waiters, one table** — `$push` on items is atomic; settle is guarded by
  the status precondition.
- **POS retry mid-settle** — `clientTxnId` replay, one bill.
- **Stall suspended after items were added** — settlement still pays it; the
  goods were served. Suspension blocks NEW items, not money already owed.
- **Product deleted after being added** — the line's snapshot carries name and
  price, so the bill is unaffected.

## Reporting

The organizer's Cashless tab gains a Tables view: open tables with running
totals, settled tables with what each stall earned, and voided tables with
reasons — the last being the number that tells an organizer whether table
service is costing them money.

Stall-side reporting needs no change: settlement writes ordinary
`MerchantCharge` rows.

## Out of scope

- **Splitting a bill across several tags.** Wanted eventually; adds a shortfall
  question per tag and a partial-settlement state this design deliberately
  avoids.
- **Partial settlement.** Same reason.
- **Waiter tips.** No tipping model exists anywhere in the product yet.
- **Moving items between tables**, table merges, and seat-level assignment.
- **A dashboard editor for waiters** beyond hire / disable / reset PIN, matching
  what cashiers have today.

## Testing

- A waiter opens a table, adds items from TWO stalls, settles: one journal
  entry, postings sum to zero, each stall credited at its own commission.
- Two `MerchantCharge` rows written, each carrying the waiter and no operator.
- Stock leaves each stall at add time, not at settle.
- Removing a line returns stock; voiding does not.
- Settle with an insufficient balance charges nothing, names the shortfall, and
  leaves the table open.
- A second concurrent settle loses to the status guard and charges nothing.
- A retried settle with the same `clientTxnId` replays rather than double-billing.
- A waiter cannot touch another event's tables, stalls or products.
- `waiter:settle_tables` is required to settle; serving alone is not enough.
