# Per-person cashless operators and base32 login codes

**Date:** 2026-08-18
**Status:** Design — approved forks, pending spec review
**Surfaces:** `carrot-tickets-api`, `carrot-tickets-dashboard`, `pos-app`

## Problem

Two populations in the cashless system conflate a **place** with a **person**,
and the login-code pool is too small for the number of people the fix implies.

### Cashiers are an org-wide roster

A `Cashier` carries `scope` + `vendorId` and reaches events through the shared
`eventIds` set (`applyOperatorEventScope`), where empty means "every event this
organizer runs". The dashboard manages them from a top-level sidebar entry.
But a cashier is hired for one event: the account should end with the event
rather than linger as an active org-wide login nobody deactivates. The rest of
the cashless surface — stalls, catalogue, stock, money — already moved inside
the event; cashiers did not follow.

### Stall sales are not attributable to a human

A `Merchant` **is** the stall: one `loginCode` and one `pin` shared by everyone
working it. The only per-person field on a sale is `merchantCharge.staffName?`
— an optional free-text string the POS sends from memory
(`charge_page.dart`: *"who's on this till — memory only, per shift"*), written
verbatim at `merchant.service.ts:197`.

Consequences at a stall with four people on it:

- Everyone shares one PIN. Revoking one person means rotating the stall's PIN
  and locking out the other three.
- "How much did Thabo take?" is unanswerable — the record may say `thabo`,
  `Thabo`, `T`, or nothing.
- Shrinkage at a stall has no per-person trail, which is most of the reason to
  run cashless instead of cash.

Note the asymmetry: the money desk is already tracked correctly.
`walletTopup` and `walletWithdrawal` both carry `recordedBy` (indexed) and a
`recordedByType` enum. Only stall sales are anonymous.

### The code pool is too small for per-person operators

`generateUniqueLoginCode()` issues 6-digit numeric codes, globally unique
across four populations and never reclaimed — a pool of 900,000 that only
shrinks. Today one stall burns one code. Once every person at a stall gets
their own, a 20-stall festival at 4 people per stall goes from 20 codes to 80,
before cashiers and gate. Per-person attribution is exactly the change that
makes a numeric pool feel small.

## Non-goals

- **Code recycling.** Reclaiming codes after an event was considered and
  rejected: sale and top-up history must stay attributable for a long time, and
  a reclaim sweep risks reissuing a code out from under someone at an event
  running past its scheduled end. A larger alphabet removes the need.
- **Per-person settlement.** Money stays owed to the *stall*.
  `LedgerAccountType.MERCHANT` keeps referencing `merchantId`. Only attribution
  moves to the person; there are no per-bartender payout accounts.
- **Changing the login contract.** `loginCode` + `pin` stays the shape. The
  device never tells the server which event or stall it is — that would
  recreate the device-chosen-scope trust gap closed on the gate side.
- **Touching gate or reseller operator scoping.** Those are genuinely
  multi-event and keep `applyOperatorEventScope` unchanged.
- **A manager tier at the stall.** Any operator at a stall can see that
  stall's charge history, as today. No `isManager` flag until something needs
  one.

## Design

### 1. Cashiers become event-owned

`cashier.model.ts`:

- Add `eventId: { type: ObjectId, ref: 'Event', index: true, immutable: true }`.
- Required **when `scope === 'organizer'`**, via a Mongoose `required` function.
- Remove `applyOperatorEventScope(cashierSchema)` — a single owning event
  supersedes the `eventIds` set for this population.
- Add index `{ eventId: 1, isActive: 1 }`; keep `{ vendorId: 1, isActive: 1 }`.

`vendorId` stays, denormalized from the event at creation, so organizer-level
authorization does not need a join.

**Platform-scoped cashiers keep no event.** `scope: 'platform'` is Carrot's own
staff, created by a super-admin with no `vendorId`; they are legitimately global
and are the one remaining global cashier.

`cashierAdmin.controller.ts`:

- Create accepts `eventId` (single) instead of `eventIds`, validated against the
  cashier's own vendor via the existing `validateEventAssignment`, narrowed to
  one id.
- List filters by `eventId`.
- The `setEvents` endpoint and its route are deleted.

### 2. Stalls separate the place from the person

**`Merchant` stays the stall** — `name`, `eventId`, `commissionPercent`,
`status`, and its settlement identity. It **loses** `applyOperatorCredentials`
and its `loginCode`. A place does not log in.

**New `MerchantOperator`**, mirroring `Cashier`:

- `fullName`, `phoneNumber?`
- `merchantId` (required, immutable), `eventId` (denormalized from the stall)
- `applyOperatorCredentials` + its own `loginCode`
- index `{ merchantId: 1, isActive: 1 }`

`merchantAuth.service.ts` looks up `MerchantOperator` instead of `Merchant`.
The token carries `merchantOperatorId` alongside the derived `merchantId` and
`eventId`, so the stall is still server-derived and never device-chosen — the
same trust property the cashier's event has.

`merchantCharge.model.ts`:

- `staffName?: string` (client-supplied, optional) → `merchantOperatorId:
  ObjectId`, **required**.
- `staffName` is retained as a **server-derived snapshot** of the operator's
  name at sale time, so historical records still read correctly after a rename.
  The client stops sending it; `merchant.service.ts:197` reads it off the
  authenticated operator instead.

Also updated for the new actor:

- Stock movements post `byType: 'Merchant', by: merchantId`
  (`merchant.service.ts:172`) → the operator.
- `recordedByType` enums on `walletTopup` / `walletWithdrawal`: `'Merchant'` →
  `'MerchantOperator'`.

**The population count is unchanged.** `Merchant` drops out of
`generateUniqueLoginCode()`'s uniqueness check as `MerchantOperator` enters it
— still four populations, still one shared generator.

### 3. Login codes become Crockford base32

Alphabet: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — 32 characters, with `I`, `L`,
`O` and `U` excluded.

| Format | Space | Relative |
| --- | --- | --- |
| 6 digits, numeric (today) | 900,000 | — |
| 6 chars, Crockford base32 | 1,073,741,824 | 1,193× |

Applies to all four populations, so `generateUniqueLoginCode()` stays a single
shared function with permanent uniqueness. At a billion codes the 20-attempt
retry loop never fires in practice.

**Input normalization.** Codes are uppercased on input, with `I`/`L` folded to
`1` and `O` to `0`, so someone misreading an ambiguous glyph off a printed slip
still logs in. Normalization happens once, in the auth services, before the
`findOne({ loginCode })` lookup.

**No migration.** Numeric codes are a strict subset of this alphabet, so codes
already issued on dev keep working untouched.

PINs are unaffected and stay 6-digit numeric — bcrypt-hashed behind lockout,
and faster to enter on a handheld.

### 4. Dashboard

- The `Cashiers` sidebar entry **narrows to super-admins** rather than
  disappearing: organizers lose it, and for super-admins it manages
  platform-scoped cashiers only. `CashiersPage` already gates its scope
  selector on `user.isSuperAdmin`, and that branch becomes the whole page.
- Add `Cashiers` as a fifth sub-tab of `EventCashlessTab`:
  `Money | Stock | Stalls | Catalogue | Cashiers`, at `?tab=cashless&sub=cashiers`.
- `CashiersPage` becomes an event-scoped panel and loses its `EventPicker`;
  the event comes from route context, and the "3 assigned / All events" column
  goes with it.
- The existing Stalls sub-tab gains a per-stall operator list — same shape as
  the cashier panel: add person, show login code once, reset PIN, deactivate.

### 5. POS

`login_page.dart` pins both fields to `TextInputType.number` with
`FilteringTextInputFormatter.digitsOnly`.

- Login code field: accept alphanumerics, uppercase as typed, normalize before
  send. PIN field unchanged.
- The same fix applies to the reseller portal and gate-operator logins, since
  all four populations draw from the one alphabet.

`charge_page.dart` drops `_staffName` and its input entirely — the server now
derives the name from the authenticated operator.

**Shift changes become a logout/login.** That is the deliberate cost of
attribution: the till is bound to a person, not a place. Code + PIN keeps it
quick.

## Error handling

- Creating an organizer-scoped cashier without `eventId` → 400.
- Creating a cashier against another vendor's event → 400 from
  `validateEventAssignment`.
- Changing `eventId` or `merchantId` on an existing operator → rejected by
  immutability; create a new operator instead.
- A charge from a token without `merchantOperatorId` → 401. There is no
  anonymous-stall fallback path.
- Login with a code containing an excluded glyph → normalized, then treated as
  any other miss: generic failure, no oracle distinguishing "bad alphabet" from
  "no such operator".

## Testing

- **Model:** cashier `eventId` required for organizer scope, absent-allowed for
  platform scope, immutable; `MerchantOperator.merchantId` required and
  immutable.
- **Generator:** issued codes contain only alphabet characters; never emit
  `I`, `L`, `O`, `U`; normalization round-trips `I`→`1`, `L`→`1`, `O`→`0`;
  uniqueness checked across all four populations.
- **Attribution:** a charge records the authenticated operator's id; a
  client-supplied `staffName` in the request body is ignored, not trusted.
- **Routes:** creating a cashier against another vendor's event 400s;
  `setEvents` is gone; cashier list is event-filtered; operator list is
  stall-filtered.
- **Auth:** a legacy all-numeric code still authenticates unchanged; a
  `Merchant` loginCode no longer authenticates anything.
- **Settlement:** ledger postings still credit `merchantId`, not the operator.
- **POS:** widget test that the login-code field accepts and uppercases letters.

Run the API suite with `--runInBand` — the full suite is order-sensitive.

## Sequencing

Three tracks, ordered so each diff stays readable:

1. **Base32 codes** — generator + normalization + all POS/portal login inputs.
   The input fix must ship in the *same push* as the generator: a base32 code
   issued to an operator whose login screen still rejects letters is a live
   lockout.
2. **MerchantOperator** — model, auth swap, charge attribution, stall operator
   admin UI.
3. **Event-scoped cashiers** — model, controller, sub-tab move.

Track 1 is independent. Tracks 2 and 3 both touch the operator-admin UI
patterns and are easier in that order.

## Rollout

`origin/main` contains no cashier or cashless files: the slice has never
shipped to production. There are no production operators to migrate and no
backward-compatibility surface, so this lands as a clean break on dev.

Dev fixtures carrying `eventIds`, `Merchant` credentials, or free-text
`staffName` are dropped rather than migrated.
