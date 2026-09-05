# Standalone tag wallets — a tag that works without a ticket

**Date:** 2026-09-05
**Status:** approved (brainstormed 2026-09-04/05)

## The problem

A tag registered to an event still cannot hold money. Top-up looks a wallet up by
band uid (`cashier.controller.ts`), and a wallet only exists once a tag is BOUND
to a ticket — `Wallet.ticketId` is the wallet identity, `required`, uniquely
indexed. So "we handed them a tag" ends at `No wallet for that band/ticket`.

The 2026-08-07 cashless design anticipated the walk-up case and solved it by
minting a ticket behind the tag (`sell-band-as-ticket`, shipped on the reseller
surface, removed 2026-08-20 because an external outlet must not put an
organizer's tags into circulation). That removal was about WHO, not about the
capability.

## The decision

**A wallet is identified by a ticket OR by its band, and must have at least one.**

`Wallet.ticketId` becomes optional. A tag handed out on its own gets a wallet
whose identity is the band. Refunds, cash-out and settlement target the WALLET,
which is what they already do — `reconciliation.service.ts` and
`settlement.service.ts` contain no reference to `ticketId` at all.

Rejected alternative: mint a phantom ticket for every handed-out tag. It keeps
the model uniform but puts a real, admitting ticket behind a tag meant only for
spending — a free entry someone can pass out the door — and pollutes capacity
and sales reporting with tickets nobody bought.

## Data model

`ticketId` optional. Its index changes from plain unique to PARTIAL unique on
`ticketId: {$exists:true}`, mirroring the `{eventId, bandUid}` index directly
above it. A compound sparse index would not do: it only skips documents missing
ALL indexed fields, so every ticketless wallet would index as null and collide —
the same trap the bandUid index comment already documents.

A schema validator rejects a wallet with neither a ticket nor a band. Such a row
is reachable by no lookup and therefore unmanageable, the same reasoning applied
to an organizer-scope gate operator with no vendorId.

### Index migration (required — this is not autoIndex-safe)

Mongoose never rewrites an existing index's options in place; a name collision
with different options throws IndexKeySpecsConflict. The legacy non-partial
`ticketId_1` must be DROPPED before `syncIndexes()` recreates it partial.
`migrate-wallet-indexes.ts` mirrors `migrate-review-indexes.ts` exactly: drop by
name (ignoring IndexNotFound so re-runs are inert), then syncIndexes. Called at
boot, logged-not-fatal, so an environment nobody migrated self-heals on deploy.
`wallet.model.ts` turns its own autoIndex off outside tests so the migration is
the only thing that ever builds these indexes — otherwise the background build
races the drop and loses (verified against a real mongod for reviews).

## The issue flow

`POST /api/tickets/events/:eventId/tags/issue`, gated
`requireSuperAdminOrPermission(ISSUE_TAGS)` — the Register desk and Carrot staff.

`WalletService.ensureStandaloneWalletForBand({eventId, bandUid})`:
create the wallet with no ticket and `bandUid: null`, then `bindBand` it.

Creation deliberately does NOT set the uid directly. `bindBand` is THE choke
point where a uid reaches a wallet — it normalises, shape-checks, and asserts the
tag is in the event's register, which is what makes check-in-by-tag, stall
charges and wallet lookups safe for free. Setting the uid at insert would open a
second door past that gate. One door stays one door.

Idempotency comes free from the identity model: a retry finds the existing wallet
at `{eventId, bandUid}` and returns it. A race loser deletes its orphan and
re-reads the winner, the pattern `ensureWalletForTicket` already uses.

Tapping a band that already has a wallet has three distinct outcomes, never
collapsed into one message: this event's standalone wallet (idempotent success),
a ticket-bound wallet (refuse — it belongs to a ticket), not in the register
(refuse — not registered for this event).

An optional opening load reuses `topUpCash` with its existing `clientTxnId`
idempotency and `recordedByType`, so a tag issued with money attributes to the
operator exactly like any cashier top-up. No new money path, no new
reconciliation surface.

## At the gate and in reports

A standalone wallet has no ticket, so it cannot admit. Check-in resolves through
the single `ScanService.checkInTicket` choke point; a tag with no ticket behind it
is refused there with a message that says so rather than throwing.

Tag reporting (`tagReport.service.ts`) `$lookup`s the ticket for a ticket code and
customer name. Those become null for standalone wallets — several branches are
already `?? null`; the rest are made so. `WalletService`'s wallet view returns
`ticket: null` rather than `String(undefined)`.

## Out of scope (next slice)

`mode: 'ticket'` — selling a ticket ONTO a tag at the desk (tier + cash + load in
one atomic step). `TicketService.sellTickets` takes
`soldByType: 'vendor'|'sub-user'|'reseller-operator'`; a register-desk gate
operator is none of those, so this needs operator attribution threaded through
sales reporting, plus the clientTxnId reservation collection the deleted
`ResellerBandSale` provided (TicketSale has no clientTxnId, so a retry would mint
a second ticket — reserve the key BEFORE the sale, per commit 5c3d33e).
