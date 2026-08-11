# Reseller Allocation Tier (DeltaPay pre-bought block) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a party who pre-buys a block of tickets off-platform (DeltaPay: 100 general-access seats, paid to the organizer directly at E250) resell them on-platform as a dedicated tier ("General Ticket - DeltaPay Exclusive", E260, DeltaPay-only, zero platform fee) whose sales are attributed to the reseller — visible to them, held for their settlement — and never added to the organizer's revenue, while still counting toward attendance/capacity.

**Architecture:** Add an *allocation* facet to an existing ticket type: it carries a `resellerId`, an `allocationUnitCost`, a payment-method restriction, and a fee waiver. Reuse the existing reseller subsystem (`Reseller`, `TicketSale.resellerId`, `ResellerReportService` scoping, `resellerSettlement`) rather than new tables. The single behavioral change on the money side is: allocation-tier sales increment `ticketType.sold` + `event.totalTicketsSold` (attendance/inventory) but **skip** `event.totalRevenue`, and are tagged with the tier's `resellerId` so they flow to the reseller's scoped reports and settlement instead of the organizer's line.

**Tech Stack:** Node/TypeScript, Express, Mongoose (MongoDB Atlas), Jest + mongodb-memory-server. Frontend: Vite/React (dashboard `carrot-tickets-dashboard`; buyer site `carrot-tickets-website`).

## Global Constraints

- No backward-incompatible changes: all new ticket-type fields are OPTIONAL and default to today's behavior (non-allocation). Existing events/tiers are unaffected. (per user global rule)
- No silent fallbacks: a restricted tier bought with the wrong method, or an allocation tier with no `resellerId`, must FAIL LOUDLY (4xx / thrown error), never silently succeed. (per user global rule)
- Data isolation is a first-class requirement: a reseller must only ever see sales carrying their own `resellerId`. Every reporting change ships with an isolation test. (this codebase has leaked cross-tenant data before)
- Money math single source of truth: reuse `serviceFee.util.ts` and `updateTicketsSold`; do not duplicate fee/attendance math.
- Prices are in E (SZL). DeltaPay is live on prod (`deltapayEnabled=true`, public fee E6 — waived for this tier).

---

## Phase 0 — Gate (config, no code)

- [ ] **Confirm DeltaPay checkout is live** — DONE: `GET /api/public/payment-methods` returns `deltapay` in `methods`.
- [ ] **Create a DeltaPay `Reseller` row** via `POST /admin/reseller/resellers` (resellerAdmin.route.ts): `{ businessName: "DeltaPay", commissionPercent: 0 }`. Record the returned `_id` — it's the `resellerId` tag used everywhere below. Commission is 0 (DeltaPay keeps proceeds via settlement, not a commission).

**Open product decisions to confirm before Phase 2 (do not block Phase 1):**
1. **Capacity carve-out:** are the 100 seats *additional* capacity, or carved out of an existing public tier? If carved, reduce that tier's `quantity` by 100 when creating the allocation tier so `event.capacity` math doesn't inflate by 100.
2. **Organizer's E25,000:** left off-platform (dashboard shows 100 seats, E0 on-platform revenue for them) for MVP. A later optional "allocation revenue" admin line can surface their real E25k. Out of scope for this plan unless requested.

---

## Phase 1 — Backend core (the money logic)

### Task 1: Allocation fields on the ticket type

**Files:**
- Modify: `api/src/interfaces/event.interface.ts` (`ITicketType`)
- Modify: `api/src/models/event.model.ts` (ticketType sub-schema, ~L18-41)
- Test: `api/src/services/__tests__/allocationTier.model.test.ts`

**Interfaces:**
- Produces: `ITicketType` gains optional `resellerId?: Types.ObjectId`, `isAllocation?: boolean`, `allocationUnitCost?: number`, `restrictToMethod?: PaymentMethod`, `waiveServiceFee?: boolean`.

- [ ] **Step 1: Write the failing test**

```typescript
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/payment.interface';
import mongoose from 'mongoose';

describe('ticketType allocation fields', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);
  it('persists allocation metadata and defaults non-allocation tiers to undefined', async () => {
    const v = await Vendor.create({ businessName: 'Farmers', password: 'password123', slug: 'farmers' });
    const rid = new mongoose.Types.ObjectId();
    const ev = await Event.create({
      vendorId: v._id, name: 'Farmers Market', venue: 'V',
      eventDate: new Date(Date.now()+86400000), startTime: new Date(Date.now()+86400000), endTime: new Date(Date.now()+90000000),
      status: EventStatus.PUBLISHED,
      ticketTypes: [
        { name: 'General', price: 100, quantity: 50 },
        { name: 'General Ticket - DeltaPay Exclusive', price: 260, quantity: 100,
          resellerId: rid, isAllocation: true, allocationUnitCost: 250,
          restrictToMethod: PaymentMethod.DELTAPAY, waiveServiceFee: true },
      ],
    });
    const plain = ev.ticketTypes.find(t => t.name === 'General')!;
    const alloc = ev.ticketTypes.find(t => t.isAllocation)!;
    expect(plain.isAllocation).toBeUndefined();
    expect(String(alloc.resellerId)).toBe(String(rid));
    expect(alloc.allocationUnitCost).toBe(250);
    expect(alloc.restrictToMethod).toBe(PaymentMethod.DELTAPAY);
    expect(alloc.waiveServiceFee).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd api && npx jest allocationTier.model` → FAIL (schema strips unknown fields).
- [ ] **Step 3: Add the fields.** In `event.interface.ts` `ITicketType`, append the 5 optional fields. In `event.model.ts` ticketType sub-schema, add: `resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller' }`, `isAllocation: { type: Boolean }`, `allocationUnitCost: { type: Number, min: 0 }`, `restrictToMethod: { type: String, enum: Object.values(PaymentMethod) }`, `waiveServiceFee: { type: Boolean }`.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Commit** — `feat(alloc): allocation metadata on ticket type`.

### Task 2: Allocation-tier sales skip organizer revenue (keep attendance/inventory)

**Files:**
- Modify: `api/src/services/event.service.ts` `updateTicketsSold` (L534-563)
- Test: `api/src/services/__tests__/allocationRevenue.test.ts`

**Interfaces:**
- Produces: `updateTicketsSold` credits `ticketType.sold` + `event.totalTicketsSold` always, but adds to `event.totalRevenue` ONLY when the tier is not an allocation. No signature change (it already has `ticketTypeId`, so it reads `isAllocation` off the tier).

- [ ] **Step 1: Write the failing test** — seed an event with an allocation tier; call `EventService.updateTicketsSold(eventId, allocTierId, 2, 520)`; assert `ticketType.sold === 2`, `event.totalTicketsSold === 2`, and `event.totalRevenue === 0`. Second case: a normal tier DOES add to `totalRevenue`.

```typescript
it('counts allocation sales toward attendance/inventory but not organizer revenue', async () => {
  // seed event: alloc tier _id = allocId, qty 100, isAllocation true
  await EventService.updateTicketsSold(String(ev._id), allocId, 2, 520);
  const after = await Event.findById(ev._id);
  const tt = after!.ticketTypes.find(t => String(t._id) === allocId)!;
  expect(tt.sold).toBe(2);
  expect(after!.totalTicketsSold).toBe(2);
  expect(after!.totalRevenue).toBe(0); // organizer NOT credited
});
```

- [ ] **Step 2: Run to verify it fails** (currently `totalRevenue` becomes 520).
- [ ] **Step 3: Implement.** In `updateTicketsSold`, after finding `ticketTypeObj`:
```typescript
event.totalTicketsSold += quantity;
if (!ticketTypeObj?.isAllocation) {
  event.totalRevenue += revenue;
}
```
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(alloc): exclude allocation-tier sales from organizer totalRevenue`.

### Task 3: Zero service fee for allocation tiers

**Files:**
- Modify: `api/src/utils/serviceFee.util.ts` (`computeCharge`/`serviceFeeFor` caller)
- Modify: purchase-initiation callers that compute the fee (`ticket.service.ts` initiate* paths) to pass the tier's `waiveServiceFee`
- Test: `api/src/utils/__tests__/serviceFee.alloc.test.ts`

**Interfaces:**
- Produces: `computeCharge(subtotal, method, cfg, quantity, opts?: { waiveServiceFee?: boolean })` → when `waiveServiceFee` is true, `serviceFeeAmount = 0` and `amountCharged = subtotal`.

- [ ] **Step 1: Write the failing test** — `computeCharge(520, PaymentMethod.DELTAPAY, cfg /* deltapayServiceFee: 6 */, 2, { waiveServiceFee: true })` → `{ serviceFeeAmount: 0, amountCharged: 520 }`; and without the flag → `serviceFeeAmount: 12, amountCharged: 532`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the `opts.waiveServiceFee` short-circuit in `computeCharge`; thread `waiveServiceFee: ticketType.waiveServiceFee` from each initiate* caller (buyer + reseller) into `computeCharge`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(alloc): waive service fee on allocation tiers`.

### Task 4: Enforce payment-method restriction at the shared gate

**Files:**
- Modify: `api/src/services/event.service.ts` `checkTicketAvailability` (L568+) — add `method?: PaymentMethod` param; reject if `ticketType.restrictToMethod` is set and `!== method`.
- Modify: the initiate* callers to pass their method into `checkTicketAvailability`.
- Test: `api/src/services/__tests__/allocationMethodRestriction.test.ts`

**Interfaces:**
- Consumes: builds on the `isSoldOut` gate already in `checkTicketAvailability` (see 2026-08 sold-out fix).
- Produces: `checkTicketAvailability(eventId, ticketTypeId, quantity, method?)` returns `{ available:false, message:'This ticket requires DeltaPay' }` when a restricted tier is bought with another method.

- [ ] **Step 1: Write the failing test** — allocation tier `restrictToMethod=DELTAPAY`; `checkTicketAvailability(ev, alloc, 1, PaymentMethod.MTN_MOMO)` → `available:false`; with `PaymentMethod.DELTAPAY` → `available:true`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the guard (place it right after the `isSoldOut` check). Only enforce when `restrictToMethod` is set (non-restricted tiers behave exactly as before). Wire `method` from every initiate* caller.
- [ ] **Step 4: Run to verify it passes** + run existing `checkTicketAvailability.test.ts` to confirm no regression (method omitted ⇒ unchanged).
- [ ] **Step 5: Commit** — `feat(alloc): enforce per-tier payment-method restriction`.

### Task 5: Tag online allocation sales with the tier's resellerId

**Files:**
- Modify: `api/src/services/ticket.service.ts` — in the sale-record creation for buyer/online paths, when the tier `isAllocation`, set the sale's `resellerId = ticketType.resellerId` and `soldByType`/channel appropriately (channel stays ONLINE).
- Test: `api/src/services/__tests__/allocationAttribution.test.ts`

**Interfaces:**
- Consumes: `TicketSale.resellerId` (already in the model).
- Produces: an online purchase of an allocation tier persists a `TicketSale` with `resellerId = tier.resellerId`.

- [ ] **Step 1: Write the failing test** — drive a completed DeltaPay (or synchronous test-friendly) purchase of the allocation tier; assert the persisted `TicketSale.resellerId` equals the tier's `resellerId`; a normal-tier purchase persists `resellerId` undefined.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — read the tier inside the sale-record builder; when `isAllocation && resellerId`, stamp `resellerId` onto the `TicketSale`. Fail loudly if `isAllocation` but `resellerId` missing.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(alloc): attribute online allocation sales to the reseller`.

### Task 6: Exclude allocation revenue from organizer analytics/exports

**Files:**
- Modify: `api/src/services/analytics.service.ts` (revenue aggregation ~L165/440) and `api/src/services/export.service.ts` (~L302) — exclude sales whose tier `isAllocation` (or whose `TicketSale.resellerId` is set) from the ORGANIZER revenue totals; keep them in attendance counts.
- Test: `api/src/services/__tests__/allocationAnalytics.test.ts`

**Interfaces:**
- Consumes: `TicketSale.resellerId`.
- Produces: organizer analytics `totalRevenue` excludes reseller-attributed sales; `ticketsSold`/attendance still includes them.

- [ ] **Step 1: Write the failing test** — event with one normal completed sale (E100) + one allocation sale (E260, resellerId set); organizer analytics → `totalRevenue == 100`, `ticketsSold == 2`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add `resellerId: { $exists: false }` (or `isAllocation` join) to the revenue aggregation match; leave the attendance/checkin aggregation unfiltered.
- [ ] **Step 4: Run to verify it passes** + full `npx jest src/services src/controllers` green.
- [ ] **Step 5: Commit** — `feat(alloc): keep allocation revenue off organizer analytics`.

---

## Phase 2 — Dashboard: create/manage an allocation tier

**Files:** `carrot-tickets-dashboard` ticket-type editor + `api` add/update-ticket-type controller/validator (`tickets.controller.ts`, `tickets.validator.ts`).

- [ ] Extend the add/update-ticket-type API validator to accept `resellerId`, `isAllocation`, `allocationUnitCost`, `restrictToMethod`, `waiveServiceFee` (super-admin / organizer-with-permission only).
- [ ] Dashboard form: an "Allocation / reseller block" section on a ticket type — pick reseller (DeltaPay), unit cost (250), restrict-to-method (DeltaPay), waive-fee (on), price (260), qty (100). TDD the validator; component test the form gating.
- [ ] Commit per sub-step.

## Phase 3 — DeltaPay's minimal allocation view (single screen)

**Surface decision (confirmed):** DeltaPay gets NEITHER the POS app NOR the full reseller portal — the portal's hubs / operators / web-POS / commission / payout-request machinery is all irrelevant to a party who pre-bought one online block. Reuse the reseller **account** only as the backend scope key (`resellerId`) — that gives us free data isolation + sale attribution — and build ONE purpose-built, read-only screen for them. Nothing else.

**Files:** new `api/src/controllers/allocationPartner.controller.ts` + route `GET /allocation/me` (auth = reseller token, scoped to `req.reseller._id`); reuse `ResellerReportService.summary` for the money; new minimal frontend page `carrot-tickets-dashboard/src/pages/partner/AllocationPage.tsx` + a bare login (reuse `ResellerAuthContext`, no `ResellerLayout`/sidebar).

**Interfaces:**
- Produces: `GET /allocation/me` → `{ blocks: [{ eventName, tierName, quantity, sold, remaining, collected }] }`, computed by matching event ticketTypes where `resellerId == caller` + summing completed `TicketSale.totalAmount` for that scope. Strictly scoped to the caller's `resellerId`.

- [ ] **Step 1 (backend): failing test** — seed event with an allocation tier (resellerId=D, qty 100), 3 completed allocation sales (E260) + 1 sale for a DIFFERENT reseller; `getAllocationForReseller(D)` → `{ blocks:[{ tierName:'General Ticket - DeltaPay Exclusive', quantity:100, sold:3, remaining:97, collected:780 }] }`; reseller D never sees the other reseller's sale.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement `getAllocationForReseller(resellerId)` (find events with a ticketType whose `resellerId` matches; derive sold/remaining from the tier; `collected` via `ResellerReportService.summary` scoped to that resellerId) + the `GET /allocation/me` controller/route behind the existing reseller auth middleware.
- [ ] **Step 4:** run → pass. **Isolation test (required):** a second reseller calling `/allocation/me` gets only their own blocks; the organizer's other tiers never appear.
- [ ] **Step 5:** commit — `feat(alloc): scoped /allocation/me endpoint`.
- [ ] **Frontend:** a single `AllocationPage` — for each block, one card: "Sold 37 / 100 · Remaining 63 · Collected E9,620", optional collapsible sales list. Behind a bare reseller login (no sidebar, no other pages). Component test: renders the counts from a mocked `/allocation/me`.
- [ ] Commit.

## Phase 4 — Buyer site: DeltaPay-only, zero-fee display

**Files:** `carrot-tickets-website` `EventPage.tsx` / `PurchaseModal.tsx`, `services/api.ts` mapping.

- [ ] Serialize `restrictToMethod` + `waiveServiceFee` on the public ticket type (extend `eventCard.util.ts` `buildEventCardFields` — one place).
- [ ] On the buyer tier, when `restrictToMethod` is set, offer ONLY that method at checkout; show "DeltaPay exclusive". Show no service fee when `waiveServiceFee`.
- [ ] Component test: selecting the tier restricts the method picker to DeltaPay and the total equals face (E260, no fee).

---

## Self-review notes

- **Spec coverage:** inventory (T1) · price/name (T1, dashboard) · DeltaPay-only (T4, Phase 4) · zero-fee (T3, Phase 4) · money not to organizer (T2, T6) · money visible+held for DeltaPay (T5 attribution → existing settlement/reports) · DeltaPay scoped view (Phase 3) · attendance/capacity intact (T2 keeps `sold`/`totalTicketsSold`) · isolation (Phase 3 test). 
- **Load-bearing precedent verified in code:** `TicketSale.resellerId` + `ResellerReportService` scoping exist; `updateTicketsSold` is the sole organizer-revenue credit; reseller/POS already sit at face value; DeltaPay live on prod.
- **Not backward-incompatible:** every new field optional; behavior changes are gated on `isAllocation`/`restrictToMethod`/`waiveServiceFee` being set.
- **Deploy:** API via `gcloud run deploy carrot-tickets-api --source .` (no trigger); dashboard + website via push to their prod branches. Build & seed in DEV first (`carrot-tickets-api-dev`).
