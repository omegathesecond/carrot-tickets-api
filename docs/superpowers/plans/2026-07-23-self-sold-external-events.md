# Slice A — Self-Sold (External-Link) Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organizer list an event on Carrot for discovery + the social layer while selling tickets themselves — Carrot never processes the sale. Buyers reach the organizer's ticketing via an external link.

**Architecture:** Add an `Event.ticketing` mode (`'carrot' | 'external'`) + `externalTicketUrl`. Carrot's purchase paths hard-refuse non-`carrot` events (fail loudly). Public serialization exposes the mode + URL so the frontend can branch to a "Get Tickets → external URL" CTA. Community join is opened for external events (no Carrot ticket exists to verify).

**Tech Stack:** Express + TypeScript, Mongoose (MongoDB), Jest + ts-jest, supertest, mongodb-memory-server. Cross-repo tail: `carrot-tickets-dashboard` (event form), `landing/` (event detail CTA).

## Global Constraints

- **No fake data / fail loudly (CLAUDE.md):** a Carrot purchase attempt on an `external` event MUST throw a clear error — never silently no-op or fabricate a ticket.
- **Backward-compat safety:** existing events have no `ticketing` field. Every guard/read treats a **missing** `ticketing` as `'carrot'` (`event.ticketing && event.ticketing !== 'carrot'`), so legacy events keep selling. Schema default is `'carrot'`.
- **Validation:** `externalTicketUrl` is required and must be an `https://` URL when `ticketing === 'external'`; ignored otherwise.
- Same envelope/error/auth conventions as the rest of the API (`ApiResponseUtil`, services throw, controllers map). Event create/edit is vendor-authed (`dualAuth` + `requireTicketsPermission`).
- Test commands: one file `npx jest <path>`; suite `npm test`.

---

## File Structure

**Create:**
- `src/utils/ticketingGuard.util.ts` — `assertCarrotTicketing(event)` (throws for non-carrot).
- `src/utils/__tests__/ticketingGuard.util.test.ts`
- `src/scripts/backfillEventTicketing.ts` + `src/scripts/__tests__/backfillEventTicketing.test.ts`

**Modify:**
- `src/interfaces/event.interface.ts` — `IEvent` gets `ticketing` + `externalTicketUrl`.
- `src/models/event.model.ts` — schema fields.
- `src/validators/tickets.validator.ts` — `createEventSchema` + `updateEventSchema`.
- `src/services/event.service.ts` — `CreateEventParams`/`UpdateEventParams` + create/update mapping.
- `src/services/ticket.service.ts` — insert `assertCarrotTicketing` at the 3 purchase entry points.
- `src/controllers/public.controller.ts` — expose `ticketing` + `externalTicketUrl` in event serialization.
- `src/services/communityMembership.service.ts` — open join for external events.
- `package.json` — `backfill:event-ticketing` script.

**Cross-repo (own tasks at the end):** `carrot-tickets-dashboard` event form; `landing/` `EventPage`/`PurchaseModal`.

---

### Task 1: `Event.ticketing` model + interface

**Files:**
- Modify: `src/interfaces/event.interface.ts`
- Modify: `src/models/event.model.ts`
- Create: `src/models/__tests__/eventTicketing.test.ts`

**Interfaces:**
- Produces: `IEvent.ticketing: 'carrot' | 'external'` (default `'carrot'`), `IEvent.externalTicketUrl?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/models/__tests__/eventTicketing.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';

describe('Event.ticketing', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('defaults to carrot', async () => {
    const e = await Event.create({ name: 'A', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }] });
    expect(e.ticketing).toBe('carrot');
    expect(e.externalTicketUrl).toBeUndefined();
  });

  it('stores an external mode + url', async () => {
    const e = await Event.create({ name: 'B', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketing: 'external', externalTicketUrl: 'https://my.tickets/b' });
    expect(e.ticketing).toBe('external');
    expect(e.externalTicketUrl).toBe('https://my.tickets/b');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`ticketing` unknown / stripped)

Run: `npx jest src/models/__tests__/eventTicketing.test.ts`

- [ ] **Step 3: Add to `IEvent`** (`src/interfaces/event.interface.ts`) — alongside the other event fields:

```ts
export type EventTicketing = 'carrot' | 'external';
// inside interface IEvent { ... }
ticketing: EventTicketing;
externalTicketUrl?: string;
```

- [ ] **Step 4: Add to the schema** (`src/models/event.model.ts`) — alongside `status`:

```ts
ticketing: { type: String, enum: ['carrot', 'external'], default: 'carrot', index: true },
externalTicketUrl: { type: String, maxlength: 500 },
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx jest src/models/__tests__/eventTicketing.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/event.interface.ts src/models/event.model.ts src/models/__tests__/eventTicketing.test.ts
git commit -m "feat(api): Event.ticketing + externalTicketUrl model fields"
```

---

### Task 2: Validators accept + enforce ticketing

**Files:**
- Modify: `src/validators/tickets.validator.ts` (`createEventSchema`, `updateEventSchema`)
- Create: `src/validators/__tests__/eventTicketing.validator.test.ts`

**Interfaces:**
- Produces: create/update event validation that requires an `https` `externalTicketUrl` when `ticketing === 'external'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/validators/__tests__/eventTicketing.validator.test.ts
import { createEventSchema } from '@validators/tickets.validator';

const base = { name: 'E', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(Date.now() + 8.64e7), endTime: new Date(Date.now() + 9e7) };

it('rejects external without a url', () => {
  const { error } = createEventSchema.validate({ ...base, ticketing: 'external' });
  expect(error).toBeDefined();
});
it('rejects a non-https external url', () => {
  const { error } = createEventSchema.validate({ ...base, ticketing: 'external', externalTicketUrl: 'http://x' });
  expect(error).toBeDefined();
});
it('accepts external with an https url', () => {
  const { error, value } = createEventSchema.validate({ ...base, ticketing: 'external', externalTicketUrl: 'https://my.tickets/e' });
  expect(error).toBeUndefined();
  expect(value.ticketing).toBe('external');
});
it('defaults ticketing to carrot', () => {
  const { value } = createEventSchema.validate({ ...base, ticketTypes: [{ name: 'GA', price: 10, quantity: 5 }] });
  expect(value.ticketing).toBe('carrot');
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/validators/__tests__/eventTicketing.validator.test.ts`

- [ ] **Step 3: Add the fields to BOTH schemas** in `src/validators/tickets.validator.ts`

Add to `createEventSchema` object:
```ts
ticketing: Joi.string().valid('carrot', 'external').default('carrot'),
externalTicketUrl: Joi.string().uri({ scheme: ['https'] }).when('ticketing', {
  is: 'external', then: Joi.required(), otherwise: Joi.optional().allow('', null),
}),
```
Add the same two keys to `updateEventSchema` (both optional there — but keep the `.when` so an update to `ticketing:'external'` still requires the url):
```ts
ticketing: Joi.string().valid('carrot', 'external'),
externalTicketUrl: Joi.string().uri({ scheme: ['https'] }).when('ticketing', {
  is: 'external', then: Joi.required(), otherwise: Joi.optional().allow('', null),
}),
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/validators/__tests__/eventTicketing.validator.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/validators/tickets.validator.ts src/validators/__tests__/eventTicketing.validator.test.ts
git commit -m "feat(api): validate ticketing mode + external url on event create/edit"
```

---

### Task 3: Persist ticketing through the event service

**Files:**
- Modify: `src/services/event.service.ts` (`CreateEventParams`, `UpdateEventParams`, `createEvent`, `updateEvent`)
- Create: `src/services/__tests__/eventServiceTicketing.test.ts`

**Interfaces:**
- Consumes: validated `{ ticketing, externalTicketUrl }` from the controller.
- Produces: created/updated events persist `ticketing` + `externalTicketUrl`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/eventServiceTicketing.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';

describe('EventService ticketing passthrough', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('persists external ticketing on create', async () => {
    const e = await EventService.createEvent({
      vendorId: '507f1f77bcf86cd799439011', name: 'X', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketing: 'external', externalTicketUrl: 'https://my.tickets/x', ticketTypes: [],
    } as any);
    expect(e.ticketing).toBe('external');
    expect(e.externalTicketUrl).toBe('https://my.tickets/x');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/services/__tests__/eventServiceTicketing.test.ts`

- [ ] **Step 3: Thread the fields through `event.service.ts`**

Add to `CreateEventParams` and `UpdateEventParams`:
```ts
ticketing?: 'carrot' | 'external';
externalTicketUrl?: string;
```
In `createEvent`, add to the `new Event({...})` literal:
```ts
ticketing: params.ticketing ?? 'carrot',
externalTicketUrl: params.externalTicketUrl,
```
In `updateEvent`, ensure `ticketing`/`externalTicketUrl` are included in the fields copied onto the event (follow whatever assignment pattern `updateEvent` already uses — e.g. add them to its allowed-fields set / `Object.assign`).

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/services/__tests__/eventServiceTicketing.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/event.service.ts src/services/__tests__/eventServiceTicketing.test.ts
git commit -m "feat(api): persist ticketing mode through event service"
```

---

### Task 4: Purchase guard rails (fail loudly)

**Files:**
- Create: `src/utils/ticketingGuard.util.ts`
- Create: `src/utils/__tests__/ticketingGuard.util.test.ts`
- Modify: `src/services/ticket.service.ts` (3 purchase entry points)

**Interfaces:**
- Produces: `assertCarrotTicketing(event: { ticketing?: string }): void` — throws `Error('This event sells tickets externally')` for non-carrot events; no-op for `carrot` or missing.

- [ ] **Step 1: Write the failing unit test**

```ts
// src/utils/__tests__/ticketingGuard.util.test.ts
import { assertCarrotTicketing } from '@/utils/ticketingGuard.util';

it('throws for external events', () => {
  expect(() => assertCarrotTicketing({ ticketing: 'external' })).toThrow('externally');
});
it('is a no-op for carrot events', () => {
  expect(() => assertCarrotTicketing({ ticketing: 'carrot' })).not.toThrow();
});
it('is a no-op for legacy events with no ticketing field', () => {
  expect(() => assertCarrotTicketing({})).not.toThrow();
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/utils/__tests__/ticketingGuard.util.test.ts`

- [ ] **Step 3: Implement the guard**

```ts
// src/utils/ticketingGuard.util.ts
/** Refuse to process a Carrot ticket sale for an externally-sold event.
 *  Missing `ticketing` is treated as 'carrot' (legacy events). */
export function assertCarrotTicketing(event: { ticketing?: string }): void {
  if (event.ticketing && event.ticketing !== 'carrot') {
    throw new Error('This event sells tickets externally');
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/utils/__tests__/ticketingGuard.util.test.ts`

- [ ] **Step 5: Insert the guard at all 3 purchase entry points** in `src/services/ticket.service.ts`

Add the import at the top: `import { assertCarrotTicketing } from '@/utils/ticketingGuard.util';`

In `purchaseForCustomer` (~line 749), right after the event is loaded:
```ts
const event = await Event.findOne({ _id: eventId, status: EventStatus.PUBLISHED });
if (!event) { throw new Error('Event not found or not available'); }
assertCarrotTicketing(event);   // ← add
```
In `initiateMomoPurchase` (~line 912) and `initiateCardPurchase` (~line 1055), right after each `const event = await Event.findById(...)` / `if (!event) throw ...`:
```ts
const event = await Event.findById(p.eventId);
if (!event) throw new Error('Event not found');
assertCarrotTicketing(event);   // ← add
```

- [ ] **Step 6: Write a route-level regression test proving a Carrot purchase is refused**

```ts
// src/services/__tests__/purchaseExternalGuard.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketService } from '@services/ticket.service';

describe('purchase refuses external events', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('purchaseForCustomer throws for an external event', async () => {
    const e = await Event.create({ name: 'Ext', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketing: 'external', externalTicketUrl: 'https://x.tickets/e', ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    await expect(TicketService.purchaseForCustomer({ eventId: String(e._id), ticketTypeId: String(e.ticketTypes[0]!._id), quantity: 1, customerPhone: '+26878422613' } as any))
      .rejects.toThrow('externally');
  });
});
```
(Adjust the `purchaseForCustomer` arg object to its actual param shape — read its signature; the assertion on `.rejects.toThrow('externally')` is the invariant.)

- [ ] **Step 7: Run — expect PASS**, then commit

Run: `npx jest src/services/__tests__/purchaseExternalGuard.test.ts`
```bash
git add src/utils/ticketingGuard.util.ts src/utils/__tests__/ticketingGuard.util.test.ts src/services/ticket.service.ts src/services/__tests__/purchaseExternalGuard.test.ts
git commit -m "feat(api): refuse Carrot purchases for externally-sold events"
```

---

### Task 5: Expose ticketing + externalTicketUrl in public serialization

**Files:**
- Modify: `src/controllers/public.controller.ts` (list + detail mappers)
- Create: `src/routes/__tests__/publicEventTicketing.route.test.ts`

**Interfaces:**
- Produces: `GET /api/public/events` and `GET /api/public/events/:eventId` include `ticketing` + `externalTicketUrl`.

> **Coordination:** if the Phase-1 plan already landed `src/utils/eventCard.util.ts` (`toPublicEventCard`), add `ticketing: event.ticketing ?? 'carrot'` and `externalTicketUrl: event.externalTicketUrl ?? null` **there instead** (one place), and skip the inline edits below.

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/publicEventTicketing.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

describe('public events expose ticketing', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('detail includes ticketing + externalTicketUrl', async () => {
    const e = await Event.create({ name: 'Ext', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(Date.now() + 8.64e7), endTime: new Date(Date.now() + 9e7), status: EventStatus.PUBLISHED, ticketing: 'external', externalTicketUrl: 'https://x.tickets/e', ticketTypes: [] });
    const res = await request(app).get(`/api/public/events/${e._id}`).expect(200);
    expect(res.body.data.ticketing).toBe('external');
    expect(res.body.data.externalTicketUrl).toBe('https://x.tickets/e');
  });
});
```
(If `GET /api/public/events/:id` only returns published events with a stricter filter, confirm the fixture matches its query — status PUBLISHED + future date is used above.)

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/routes/__tests__/publicEventTicketing.route.test.ts`

- [ ] **Step 3: Add the two fields** to the list mapper (`getPublicEvents`) and detail mapper (`getPublicEvent`) object literals in `src/controllers/public.controller.ts`:

```ts
ticketing: (event as any).ticketing ?? 'carrot',
externalTicketUrl: (event as any).externalTicketUrl ?? null,
```

- [ ] **Step 4: Run — expect PASS**, then commit

Run: `npx jest src/routes/__tests__/publicEventTicketing.route.test.ts`
```bash
git add src/controllers/public.controller.ts src/routes/__tests__/publicEventTicketing.route.test.ts
git commit -m "feat(api): expose ticketing + externalTicketUrl in public event API"
```

---

### Task 6: Open community join for external events

**Files:**
- Modify: `src/services/communityMembership.service.ts` (`join`)
- Create: `src/services/__tests__/externalCommunityJoin.test.ts`

**Interfaces:**
- Produces: a buyer can join an `external` event's community without holding a Carrot ticket; `carrot` events keep their existing ticket-gated join.

> **Read first:** open `CommunityMembershipService.join(eventId, buyer)` and locate its ticket-verification block (the part that requires a valid ticket / sets `ticketVerifiedAt`). You will wrap that block in a `ticketing !== 'external'` guard.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/externalCommunityJoin.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { CommunityMembershipService } from '@services/communityMembership.service';

describe('external event community join', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('lets a buyer join an external event community with no ticket', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    const e = await Event.create({ name: 'Ext', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketing: 'external', externalTicketUrl: 'https://x.tickets/e', ticketTypes: [] });
    // community auto-creation may run on publish; if join() creates on demand this still works:
    const view = await CommunityMembershipService.join(String(e._id), buyer as any);
    expect(view.membership).not.toBeNull();
  });
});
```
(If `join` requires an existing `Community`, seed one first: `await Community.create({ eventId: e._id, vendorId: e.vendorId })` — match how the current tests set communities up.)

- [ ] **Step 2: Run — expect FAIL** (join throws "ticket required" for the ticketless buyer)

Run: `npx jest src/services/__tests__/externalCommunityJoin.test.ts`

- [ ] **Step 3: Guard the ticket check in `join`**

Load the event's `ticketing`, and wrap the existing ticket-verification requirement so it only applies to Carrot-sold events. Concretely, around the current ticket check inside `join`:
```ts
const event = await Event.findById(eventId).select('ticketing');
const requiresTicket = !event || event.ticketing !== 'external';
if (requiresTicket) {
  // ...existing ticket-verification block stays here unchanged...
}
// members of external communities join open (no ticketVerifiedAt); everything below (membership upsert) unchanged
```

- [ ] **Step 4: Run — expect PASS**; run the existing community tests to confirm carrot gating still holds

Run: `npx jest src/services/__tests__/externalCommunityJoin.test.ts` then `npx jest -t "community"`
Expected: new test passes; existing ticket-gated community tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/communityMembership.service.ts src/services/__tests__/externalCommunityJoin.test.ts
git commit -m "feat(api): open community join for externally-sold events"
```

---

### Task 7: Backfill existing events to ticketing='carrot'

**Files:**
- Create: `src/scripts/backfillEventTicketing.ts`
- Create: `src/scripts/__tests__/backfillEventTicketing.test.ts`
- Modify: `package.json` (add `backfill:event-ticketing`)

- [ ] **Step 1: Write the failing test**

```ts
// src/scripts/__tests__/backfillEventTicketing.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { backfillEventTicketing } from '../backfillEventTicketing';

describe('backfillEventTicketing', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('sets ticketing=carrot on events missing the field', async () => {
    const e = await Event.create({ name: 'Legacy', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [] });
    await Event.collection.updateOne({ _id: e._id }, { $unset: { ticketing: '' } });
    const res = await backfillEventTicketing();
    expect(res.updated).toBe(1);
    const reloaded = await Event.findById(e._id);
    expect(reloaded!.ticketing).toBe('carrot');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/scripts/__tests__/backfillEventTicketing.test.ts`

- [ ] **Step 3: Implement the script (mirror `backfillOperatorType.ts`)**

```ts
// src/scripts/backfillEventTicketing.ts
import mongoose from 'mongoose';
import { Event } from '@models/event.model';

/** One-time, idempotent: every event written before `ticketing` existed sells
 *  via Carrot. Fills only missing fields. */
export async function backfillEventTicketing(): Promise<{ updated: number }> {
  const res = await Event.updateMany({ ticketing: { $exists: false } }, { $set: { ticketing: 'carrot' } });
  return { updated: res.modifiedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillEventTicketing] done:', await backfillEventTicketing());
    await mongoose.disconnect();
  })().catch((err) => { console.error('[backfillEventTicketing] failed:', err); process.exit(1); });
}
```

- [ ] **Step 4: Add the npm script** to `package.json` `scripts`:

```json
"backfill:event-ticketing": "ts-node -r tsconfig-paths/register src/scripts/backfillEventTicketing.ts",
```

- [ ] **Step 5: Run — expect PASS**, then commit

Run: `npx jest src/scripts/__tests__/backfillEventTicketing.test.ts`
```bash
git add src/scripts/backfillEventTicketing.ts src/scripts/__tests__/backfillEventTicketing.test.ts package.json
git commit -m "chore(api): backfill event ticketing=carrot for legacy events"
```

- [ ] **Step 6: Full-suite regression**

Run: `npm test` — expect all green.

---

### Task 8 (cross-repo: `carrot-tickets-dashboard`): event form ticketing toggle

> Executed in the **dashboard** repo, not this one. Consider a small standalone plan there. Concrete changes:

- In the event create/edit form: add a **"Who sells tickets?"** toggle — "Carrot sells (recommended)" vs "I sell them myself (external link)".
- When "external": show a required `externalTicketUrl` field (validate `https://`), and hide/disable the Carrot ticket-type + payout editors (keep an optional display-price field if the form has one).
- Submit `ticketing` + `externalTicketUrl` in the create/update payload (the API validators from Task 2 enforce the rules).
- Copy: never imply Carrot processes the sale for external events.

- [ ] Implement the toggle + conditional URL field.
- [ ] Verify create + edit round-trip an external event (mode persists on reload).
- [ ] Commit in the dashboard repo.

---

### Task 9 (cross-repo: `landing/`): event detail external CTA

> Executed in the **landing** repo. Concrete changes:

- In `EventPage` / `EventQuickView` / `PurchaseModal` gating: read `event.ticketing`.
  - `carrot` → existing checkout (unchanged).
  - `external` → primary CTA **"Get Tickets"** links to `event.externalTicketUrl` with `target="_blank" rel="noopener noreferrer"`; do NOT render `PurchaseModal`.
- On `EventCard` / feed / quick-view, show an "External" affordance (e.g. a small "Buy on organizer's site" hint) for `ticketing === 'external'`.
- Community/"I'm Here" stays available (Task 6 opened join server-side) — no ticket needed.

- [ ] Branch the CTA on `ticketing`.
- [ ] Verify an external event shows the outbound link and never opens the purchase modal.
- [ ] Commit in the landing repo.

---

## Self-Review (completed)

- **Spec coverage:** roadmap Slice A items all mapped — model (T1), validation (T2), persistence (T3), fail-loud guard rails (T4), public serialization (T5), relaxed community join (T6), backfill (T7), dashboard form (T8), landing CTA (T9).
- **Backward-compat:** guard + reads treat missing `ticketing` as `'carrot'` (T4 test asserts the legacy `{}` case); default is `'carrot'`; backfill is additive. No breaking change to existing events.
- **Placeholder scan:** none — real code/tests throughout. The "read `join()` first" and "adjust `purchaseForCustomer` arg shape" notes are precise verification instructions with the invariant (`.rejects.toThrow('externally')`) pinned.
- **Type consistency:** `assertCarrotTicketing(event)`, `EventTicketing`, `ticketing`/`externalTicketUrl` used consistently across model, validator, service, guard, serialization, backfill.
- **Cross-repo tasks (T8/T9)** are flagged as separate repos and can graduate to their own plans; the API contract they depend on (Tasks 1–7) is complete and testable on its own.
