# Event-scoped cashiers and base32 login codes

**Date:** 2026-08-18
**Status:** Design — approved forks, pending spec review
**Surfaces:** `carrot-tickets-api`, `carrot-tickets-dashboard`, `pos-app`

## Problem

Cashiers today are an organizer-wide staff roster. A `Cashier` row carries
`scope` + `vendorId` and reaches events through the shared `eventIds`
assignment set (`applyOperatorEventScope`), where an empty set means "every
event this organizer runs". The dashboard manages them from a top-level
sidebar entry, next to Gate Operators.

That shape is wrong for how cashiers are actually staffed, in four ways:

1. **Lifecycle.** A cashier is hired for one event. The account should end
   with the event rather than linger as an active org-wide login nobody
   remembers to deactivate.
2. **Capacity.** `generateUniqueLoginCode()` issues 6-digit numeric codes that
   are globally unique across four populations — reseller operators, gate
   operators, cashiers, merchants — and are never reclaimed. The pool is
   900,000 and only shrinks.
3. **Guessability.** Six numeric digits is a small space to defend with a PIN,
   even behind lockout.
4. **Mental model.** Organizers think "who is working Friday's show", not "my
   staff roster". The rest of the cashless surface — stalls, catalogue, stock,
   money — already moved inside the event; cashiers did not follow.

## Non-goals

- **Code recycling.** Reclaiming codes after an event was considered and
  rejected: sale and top-up history must stay attributable for a long time, and
  a reclaim sweep risks reissuing a code out from under a cashier at an event
  running past its scheduled end. A larger alphabet removes the need entirely.
- **Changing the login contract.** `POST` with `loginCode` + `pin` stays as-is.
  In particular the POS never tells the server which event it is logging into —
  that would recreate the device-chosen-scope trust gap closed on the gate side.
- **Touching gate or reseller operator scoping.** Those populations are
  genuinely multi-event and keep `applyOperatorEventScope` unchanged.

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
and are the one remaining global cashier. The conditional-required rule is
expressed as a Mongoose `required` function on `eventId`, not as two models.

`cashierAdmin.controller.ts`:

- Create accepts `eventId` (single) instead of `eventIds`, and validates the
  event belongs to the cashier's own vendor — reusing the existing
  `validateEventAssignment` check, narrowed to one id.
- List filters by `eventId`.
- The `setEvents` endpoint and its route are deleted.

Spend-time enforcement reads `cashier.eventId` directly rather than scanning a
set — a simplification of what is on dev today.

### 2. Login codes become Crockford base32

Alphabet: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — 32 characters, with `I`, `L`,
`O` and `U` excluded.

| Format | Space | Relative |
| --- | --- | --- |
| 6 digits, numeric (today) | 900,000 | — |
| 6 chars, Crockford base32 | 1,073,741,824 | 1,193× |

Applies to **all four populations**, so `generateUniqueLoginCode()` stays a
single shared function with its existing four-way `exists()` check and its
permanent-uniqueness guarantee. At a billion codes the 20-attempt retry loop
never fires in practice.

**Input normalization.** Codes are uppercased on input, with `I`/`L` folded to
`1` and `O` to `0`, so a cashier who misreads an ambiguous glyph off a printed
slip still logs in. Normalization happens once, in the auth services, before
the `findOne({ loginCode })` lookup.

**No migration.** Numeric codes are a strict subset of this alphabet, so every
code already issued on dev keeps working untouched. Widening the alphabet is
backward-safe in a way that changing the length or format would not be.

PINs are unaffected and stay 6-digit numeric — they are bcrypt-hashed behind
lockout, and a numeric PIN is faster to enter on a handheld.

### 3. Dashboard

- Remove the `Cashiers` entry from `Sidebar.tsx`.
- Add `Cashiers` as a fifth sub-tab of `EventCashlessTab`:
  `Money | Stock | Stalls | Catalogue | Cashiers`, reachable at
  `?tab=cashless&sub=cashiers`.
- `CashiersPage` becomes an event-scoped panel and loses its `EventPicker`;
  the event comes from route context. The "3 assigned / All events" column is
  removed along with it.
- The sidebar entry does not disappear outright — it **narrows to
  super-admins** and manages platform-scoped cashiers only. `CashiersPage`
  already gates its scope selector on `user.isSuperAdmin`; that branch becomes
  the whole page, and the organizer branch moves to the event tab.

### 4. POS

`login_page.dart` currently pins both fields to `TextInputType.number` with
`FilteringTextInputFormatter.digitsOnly`.

- Login code field: accept alphanumerics, uppercase as the user types, apply
  Crockford normalization before send.
- PIN field: unchanged.

The reseller portal and gate-operator login inputs need the same change, since
all four populations now draw from the same alphabet.

## Error handling

- Creating an organizer-scoped cashier without `eventId` → 400.
- Creating one against an event belonging to another vendor → 400 from
  `validateEventAssignment` (unchanged behaviour, narrowed input).
- Attempting to change `eventId` on an existing cashier → rejected by the
  immutability rule; the organizer creates a new cashier for the other event.
- Login with a code containing an excluded glyph → normalized, then treated as
  any other miss: generic failure, no oracle distinguishing "bad alphabet" from
  "no such cashier".

## Testing

- **Model:** `eventId` required for organizer scope, absent-allowed for
  platform scope, immutable after create.
- **Generator:** issued codes contain only alphabet characters; never emit
  `I`, `L`, `O`, `U`; normalization round-trips `I`→`1`, `L`→`1`, `O`→`0`;
  uniqueness still checked across all four populations.
- **Routes:** creating a cashier against another vendor's event 400s;
  `setEvents` is gone; list is event-filtered.
- **Auth:** a legacy all-numeric code still authenticates unchanged.
- **POS:** widget test that the login-code field accepts letters and uppercases
  them.

Run the API suite with `--runInBand` — the full suite is order-sensitive.

## Sequencing

The two changes are independent and can land in either order. The alphabet
change touches all four operator populations but no data model; the
event-scoping change touches only cashiers. Landing the alphabet change first
keeps each diff readable, and its POS input fix must ship in the same push as
the generator change — a base32 code issued to an operator whose login screen
still rejects letters is a live lockout.

## Rollout

`origin/main` contains no cashier files: the cashless slice has never shipped to
production. There are no production cashiers to migrate and no
backward-compatibility surface, so this lands as a clean break on dev.

Dev cashiers created before this change carry `eventIds` and no `eventId`. They
are dev fixtures; they are dropped rather than migrated.
