# Phase 2 — Event Category + Live Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give events a first-class `category` (so the Home + Discover category chips filter and the poster/card category badge renders) and add a `GET /public/events/live` endpoint with a real `liveAttendees` count (so the Home "Live Now" rail drops its `DEMO_LIVE_EVENTS` fallback).

**Architecture:** Add an `Event.category` enum (organizer-set on create/edit, backfilled to `'Other'`, never inferred). Thread a `?category=` filter through `GET /public/events` and `GET /public/feed`, and surface `category` in the event serialization. Add a live-events read that selects events whose window contains "now" and counts active community members as attendees.

**Tech Stack:** Express + TypeScript, Mongoose (MongoDB), Jest + ts-jest, supertest, mongodb-memory-server.

## Global Constraints

- **No fake data / never infer (CLAUDE.md):** category is organizer-set; legacy events backfill to `'Other'`, never guessed from the name. `liveAttendees` is a real membership count, never fabricated.
- **Coordination with Phase 1:** the event-card serializer may be inline (`public.controller`) or already extracted to `src/utils/eventCard.util.ts` (`toPublicEventCard`). Each serialization task below says: add the field to `toPublicEventCard` **if it exists**, else to the inline mappers.
- **Category set (fixed):** `['Music','Art','Food','Tech','Sports','Theater','Comedy','Fashion','Film','Other']` — matches the frontend `CATEGORIES` + the tailwind `category.*` colors. Default `'Other'`. The chip value `'All'` means "no filter" (never sent as a category).
- Same envelope/error/auth conventions (`ApiResponseUtil`, services throw, controllers map).
- Test commands: one file `npx jest <path>`; suite `npm test`.

---

## File Structure

**Create:**
- `src/constants/eventCategories.ts` — the `EVENT_CATEGORIES` tuple + `EventCategory` type.
- `src/scripts/backfillEventCategory.ts` + test.
- Route tests under `src/routes/__tests__/`.

**Modify:**
- `src/interfaces/event.interface.ts`, `src/models/event.model.ts` — `category` field.
- `src/validators/tickets.validator.ts` — create/update schemas.
- `src/services/event.service.ts` — create/update passthrough.
- `src/controllers/public.controller.ts` — `?category=` on `getPublicEvents`, serialization, and a new `getLiveEvents`.
- `src/services/feed.service.ts` + `src/controllers/feed.controller.ts` — `?category=` on the feed.
- `src/routes/public.route.ts` — register `GET /events/live`.
- `package.json` — `backfill:event-category`.

---

### Task 1: `Event.category` model, interface, validator, service

**Files:**
- Create: `src/constants/eventCategories.ts`
- Modify: `src/interfaces/event.interface.ts`, `src/models/event.model.ts`, `src/validators/tickets.validator.ts`, `src/services/event.service.ts`
- Create: `src/models/__tests__/eventCategory.test.ts`, `src/validators/__tests__/eventCategory.validator.test.ts`

**Interfaces:**
- Produces: `EVENT_CATEGORIES` (readonly tuple), `EventCategory` type, `IEvent.category: EventCategory` (default `'Other'`), and create/update validation + persistence for `category`.

- [ ] **Step 1: Create the shared constant**

```ts
// src/constants/eventCategories.ts
export const EVENT_CATEGORIES = ['Music','Art','Food','Tech','Sports','Theater','Comedy','Fashion','Film','Other'] as const;
export type EventCategory = typeof EVENT_CATEGORIES[number];
```

- [ ] **Step 2: Write the failing model test**

```ts
// src/models/__tests__/eventCategory.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';

describe('Event.category', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('defaults to Other', async () => {
    const e = await Event.create({ name: 'A', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [] });
    expect(e.category).toBe('Other');
  });
  it('stores a valid category', async () => {
    const e = await Event.create({ name: 'B', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), category: 'Music', ticketTypes: [] });
    expect(e.category).toBe('Music');
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npx jest src/models/__tests__/eventCategory.test.ts`

- [ ] **Step 4: Add to interface + schema**

`src/interfaces/event.interface.ts`:
```ts
import type { EventCategory } from '@/constants/eventCategories';
// inside IEvent
category: EventCategory;
```
`src/models/event.model.ts` (alongside `status`):
```ts
import { EVENT_CATEGORIES } from '@/constants/eventCategories';
// field
category: { type: String, enum: EVENT_CATEGORIES, default: 'Other', index: true },
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx jest src/models/__tests__/eventCategory.test.ts`

- [ ] **Step 6: Write the failing validator test**

```ts
// src/validators/__tests__/eventCategory.validator.test.ts
import { createEventSchema } from '@validators/tickets.validator';
const base = { name: 'E', venue: 'V', eventDate: new Date(Date.now()+8.64e7), startTime: new Date(Date.now()+8.64e7), endTime: new Date(Date.now()+9e7), ticketTypes: [{ name: 'GA', price: 10, quantity: 5 }] };

it('defaults category to Other', () => {
  const { value } = createEventSchema.validate(base);
  expect(value.category).toBe('Other');
});
it('accepts a valid category', () => {
  const { error, value } = createEventSchema.validate({ ...base, category: 'Music' });
  expect(error).toBeUndefined();
  expect(value.category).toBe('Music');
});
it('rejects an unknown category', () => {
  const { error } = createEventSchema.validate({ ...base, category: 'Nonsense' });
  expect(error).toBeDefined();
});
```

- [ ] **Step 7: Run — expect FAIL**, then add to BOTH validator schemas

Run: `npx jest src/validators/__tests__/eventCategory.validator.test.ts`

`src/validators/tickets.validator.ts` — import + add to `createEventSchema` and `updateEventSchema`:
```ts
import { EVENT_CATEGORIES } from '@/constants/eventCategories';
// createEventSchema:
category: Joi.string().valid(...EVENT_CATEGORIES).default('Other'),
// updateEventSchema:
category: Joi.string().valid(...EVENT_CATEGORIES),
```

- [ ] **Step 8: Thread through `event.service.ts`**

Add `category?: EventCategory;` to `CreateEventParams` + `UpdateEventParams`; in `createEvent`'s `new Event({...})` add `category: params.category ?? 'Other',`; in `updateEvent` include `category` in the copied fields.

- [ ] **Step 9: Run both tests — expect PASS**, then commit

Run: `npx jest src/models/__tests__/eventCategory.test.ts src/validators/__tests__/eventCategory.validator.test.ts`
```bash
git add src/constants/eventCategories.ts src/interfaces/event.interface.ts src/models/event.model.ts src/validators/tickets.validator.ts src/services/event.service.ts src/models/__tests__/eventCategory.test.ts src/validators/__tests__/eventCategory.validator.test.ts
git commit -m "feat(api): Event.category field, validation, persistence"
```

---

### Task 2: Backfill category='Other'

**Files:**
- Create: `src/scripts/backfillEventCategory.ts`, `src/scripts/__tests__/backfillEventCategory.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

```ts
// src/scripts/__tests__/backfillEventCategory.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { backfillEventCategory } from '../backfillEventCategory';

describe('backfillEventCategory', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);
  it('sets category=Other on events missing the field', async () => {
    const e = await Event.create({ name: 'Legacy', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [] });
    await Event.collection.updateOne({ _id: e._id }, { $unset: { category: '' } });
    const res = await backfillEventCategory();
    expect(res.updated).toBe(1);
    expect((await Event.findById(e._id))!.category).toBe('Other');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/scripts/__tests__/backfillEventCategory.test.ts`

- [ ] **Step 3: Implement (mirror `backfillOperatorType.ts`)**

```ts
// src/scripts/backfillEventCategory.ts
import mongoose from 'mongoose';
import { Event } from '@models/event.model';

/** One-time, idempotent: events written before `category` existed become 'Other'
 *  (organizers re-tag from the dashboard). Never inferred from the name. */
export async function backfillEventCategory(): Promise<{ updated: number }> {
  const res = await Event.updateMany({ category: { $exists: false } }, { $set: { category: 'Other' } });
  return { updated: res.modifiedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillEventCategory] done:', await backfillEventCategory());
    await mongoose.disconnect();
  })().catch((err) => { console.error('[backfillEventCategory] failed:', err); process.exit(1); });
}
```

- [ ] **Step 4: Add npm script + run + commit**

`package.json`: `"backfill:event-category": "ts-node -r tsconfig-paths/register src/scripts/backfillEventCategory.ts",`
Run: `npx jest src/scripts/__tests__/backfillEventCategory.test.ts`
```bash
git add src/scripts/backfillEventCategory.ts src/scripts/__tests__/backfillEventCategory.test.ts package.json
git commit -m "chore(api): backfill event category=Other for legacy events"
```

---

### Task 3: Surface `category` in serialization + filter `GET /public/events?category=`

**Files:**
- Modify: `src/controllers/public.controller.ts` (`getPublicEvents`) and `src/utils/eventCard.util.ts` **if it exists** (Phase 1)
- Create: `src/routes/__tests__/publicEventsCategory.route.test.ts`

**Interfaces:**
- Produces: every public event card includes `category`; `GET /api/public/events?category=Music` returns only Music events (`category` absent or `'All'` → unfiltered).

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/publicEventsCategory.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

describe('GET /api/public/events?category=', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('filters to the requested category and includes category in the card', async () => {
    const common = { venue: 'V', eventDate: new Date(Date.now()+8.64e7), startTime: new Date(Date.now()+8.64e7), endTime: new Date(Date.now()+9e7), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }] };
    await Event.create({ ...common, name: 'Gig', category: 'Music' });
    await Event.create({ ...common, name: 'Expo', category: 'Tech' });
    const res = await request(app).get('/api/public/events?category=Music').expect(200);
    const names = res.body.data.events?.map((e: any) => e.name) ?? res.body.data.map((e: any) => e.name);
    expect(names).toContain('Gig');
    expect(names).not.toContain('Expo');
  });
});
```
(Match `res.body.data`'s actual shape — `getPublicEvents` may return `{ events, pagination }` or an array; the test tolerates both.)

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/routes/__tests__/publicEventsCategory.route.test.ts`

- [ ] **Step 3: Add the filter + serialization field**

In `getPublicEvents` (`src/controllers/public.controller.ts`), where the Mongo query object is built, add:
```ts
const category = req.query['category'] as string | undefined;
if (category && category !== 'All') query.category = category;
```
Add `category` to the card. If `src/utils/eventCard.util.ts` exists (Phase 1), add inside `toPublicEventCard`'s returned object: `category: event.category ?? 'Other',`. Otherwise add the same line to the inline `getPublicEvents`/`getPublicEvent` mappers.

- [ ] **Step 4: Run — expect PASS**, then commit

Run: `npx jest src/routes/__tests__/publicEventsCategory.route.test.ts`
```bash
git add src/controllers/public.controller.ts src/utils/eventCard.util.ts src/routes/__tests__/publicEventsCategory.route.test.ts
git commit -m "feat(api): category filter + field on public events"
```

---

### Task 4: `GET /public/feed?category=`

**Files:**
- Modify: `src/services/feed.service.ts` (`FeedOpts` + event-slide query + update filter), `src/controllers/feed.controller.ts` (pass `category` through)
- Create: `src/routes/__tests__/feedCategory.route.test.ts`

**Interfaces:**
- Consumes: `getFeed(opts)` — extend `FeedOpts` with `category?: string`.
- Produces: `GET /api/public/feed?tab=for-you&category=Music` returns only slides for Music events (event slides of that category; update slides whose linked event is that category). `category` absent or `'All'` → unchanged behavior.

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/feedCategory.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

describe('GET /api/public/feed?category=', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns only event slides of the requested category', async () => {
    const common = { venue: 'V', eventDate: new Date(Date.now()+8.64e7), startTime: new Date(Date.now()+8.64e7), endTime: new Date(Date.now()+9e7), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }] };
    await Event.create({ ...common, name: 'MusicEvt', category: 'Music' });
    await Event.create({ ...common, name: 'TechEvt', category: 'Tech' });
    const res = await request(app).get('/api/public/feed?tab=events&category=Music').expect(200);
    const eventNames = res.body.data.items.filter((s: any) => s.type === 'event').map((s: any) => s.name);
    expect(eventNames).toContain('MusicEvt');
    expect(eventNames).not.toContain('TechEvt');
  });
});
```
(Confirm the event-slide's name field key in `getFeed`'s event DTO — adjust `s.name` to the actual key if different.)

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/routes/__tests__/feedCategory.route.test.ts`

- [ ] **Step 3: Extend `FeedOpts` + apply the category filter in `getFeed`**

In `src/services/feed.service.ts`:
- Add `category?: string;` to `FeedOpts`.
- Where the event query object is built (the branch that fetches upcoming published events), apply:
  ```ts
  if (opts.category && opts.category !== 'All') eventQuery.category = opts.category;
  ```
- For update slides under a category filter, restrict to updates linked to an event of that category. After resolving the category's event ids (or reuse the events already fetched), filter the update query with `eventId: { $in: categoryEventIds }`. When `category` is set, updates with no `eventId` are dropped from the feed.

- [ ] **Step 4: Pass `category` through the controller**

In `src/controllers/feed.controller.ts` (`FeedController.get`), read `req.query.category` and include it in the `getFeed({ ... })` opts.

- [ ] **Step 5: Run — expect PASS**, then commit

Run: `npx jest src/routes/__tests__/feedCategory.route.test.ts`
```bash
git add src/services/feed.service.ts src/controllers/feed.controller.ts src/routes/__tests__/feedCategory.route.test.ts
git commit -m "feat(api): category filter on the discover feed"
```

---

### Task 5: `GET /api/public/events/live`

**Files:**
- Modify: `src/controllers/public.controller.ts` (add `getLiveEvents`), `src/routes/public.route.ts` (register route)
- Create: `src/routes/__tests__/liveEvents.route.test.ts`

**Interfaces:**
- Produces: `GET /api/public/events/live` → `{ events: [ Card & { liveAttendees: number } ] }` — published events whose `[startTime, endTime]` window contains "now", each with an active-community-member count.

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/liveEvents.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Buyer } from '@models/buyer.model';

describe('GET /api/public/events/live', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns in-progress events with a live attendee count', async () => {
    const now = Date.now();
    const live = await Event.create({ name: 'Live', venue: 'V', eventDate: new Date(now - 3.6e6), startTime: new Date(now - 3.6e6), endTime: new Date(now + 3.6e6), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }] });
    await Event.create({ name: 'Future', venue: 'V', eventDate: new Date(now + 8.64e7), startTime: new Date(now + 8.64e7), endTime: new Date(now + 9e7), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }] });
    const community = await Community.create({ eventId: live._id, vendorId: live._id });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    await Membership.create({ buyerId: buyer._id, communityId: community._id, role: 'member' });

    const res = await request(app).get('/api/public/events/live').expect(200);
    const names = res.body.data.events.map((e: any) => e.name);
    expect(names).toEqual(['Live']);
    expect(res.body.data.events[0].liveAttendees).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/routes/__tests__/liveEvents.route.test.ts`

- [ ] **Step 3: Implement `getLiveEvents`** in `src/controllers/public.controller.ts`

```ts
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
// (toPublicEventCard if Phase 1 is merged; else map inline like getPublicEvents)
import { toPublicEventCard } from '@/utils/eventCard.util';
// ...
/** GET /api/public/events/live */
static async getLiveEvents(req: Request, res: Response): Promise<any> {
  try {
    const now = new Date();
    const events = await Event.find({ status: EventStatus.PUBLISHED, startTime: { $lte: now }, endTime: { $gte: now } }).sort({ startTime: 1 });
    const communities = await Community.find({ eventId: { $in: events.map((e) => e._id) } }).select('_id eventId');
    const commByEvent = new Map(communities.map((c) => [String(c.eventId), c._id]));
    const cards = await Promise.all(events.map(async (event: any) => {
      const communityId = commByEvent.get(String(event._id));
      const liveAttendees = communityId ? await Membership.countDocuments({ communityId, bannedAt: { $exists: false } }) : 0;
      return { ...toPublicEventCard(event), liveAttendees };
    }));
    return ApiResponseUtil.success(res, { events: cards });
  } catch (error: any) {
    return failWithHttpError(res, error, 'Failed to load live events');
  }
}
```
(If `toPublicEventCard` / `failWithHttpError` aren't imported yet in this controller, add the imports. If Phase 1 hasn't landed, replace `toPublicEventCard(event)` with the same inline object used by `getPublicEvents`.)

- [ ] **Step 4: Register the route** in `src/routes/public.route.ts` — put it ABOVE any `/events/:eventId` param route:

```ts
router.get('/events/live', PublicController.getLiveEvents);
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx jest src/routes/__tests__/liveEvents.route.test.ts`

- [ ] **Step 6: Full-suite regression + commit**

```bash
npm test
git add src/controllers/public.controller.ts src/routes/public.route.ts src/routes/__tests__/liveEvents.route.test.ts
git commit -m "feat(api): GET /public/events/live with live attendee count"
```

---

## Frontend wiring (landing/ repo — separate)

- Home + Discover category chips: thread the selected chip into `getEvents({ category })` / `getFeed({ category })`; render the category badge on posters/cards from `event.category`. `'All'` sends no category.
- Home "Live Now": replace the `DEMO_LIVE_EVENTS` fallback with `GET /public/events/live`; show `liveAttendees`. Delete the demo fallback.
- Dashboard: add a category selector to the event create/edit form (submits `category`).

## Self-Review (completed)

- **Spec coverage:** roadmap Phase-2 items mapped — 2a category (T1 model/validator/service, T2 backfill, T3 filter+field+serialization, T4 feed filter); 2b live events (T5).
- **No-fake-data:** category backfills to `'Other'` (never inferred — T2 test/comment); `liveAttendees` is a real `Membership.countDocuments` (T5 asserts the count).
- **Placeholder scan:** none — real code/tests/commands. The "confirm response shape" / "confirm slide name key" notes are verification instructions with tolerant assertions, not placeholders.
- **Type consistency:** `EVENT_CATEGORIES`/`EventCategory`, `IEvent.category`, `FeedOpts.category`, `getLiveEvents` used consistently. Category default `'Other'` and the `'All'`-means-unfiltered rule are applied identically in events + feed.
- **Coordination:** serialization tasks (T3, T5) reuse `toPublicEventCard` when present (Phase 1) or the inline mapper otherwise — no hard dependency on Phase 1 ordering, but running Phase 1 first avoids a duplicated field add.
