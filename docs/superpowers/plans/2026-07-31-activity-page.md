# Activity Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public `/activity` page showing the live pulse of Carrot Tickets — who liked what, who followed who, who is going to what events, and what organisers just posted or announced.

**Architecture:** Read-time merge. Six existing collections are queried directly, interleaved by timestamp with a per-source watermark cursor (the `feed.service.ts` idiom), and hydrated in batch. No new model, no writes to instrument, no backfill — all history is available from day one. The frontend is one page plus two nav entry points.

**Tech Stack:** API — Node/TypeScript, Express, Mongoose, Jest (`npm test`). Website — React 18, React Router, Tailwind, lucide-react, Vitest (`npm test`).

**Spec:** `api/docs/superpowers/specs/2026-07-31-activity-page-design.md`

## Global Constraints

- **Both repos are ALREADY on branch `feat/activity-page`** — created before execution. `api/`'s default branch `main` auto-deploys to prod on push and `landing/`'s is `master`, so never `git checkout` back to either, and never commit to them. Do **not** run `git checkout -b` — the branch exists.
- **Stage only the files each task names.** Never `git add -A` or `git commit -a`: both repos carry untracked scratch (`.playwright-mcp/`, `.claude/`, other plans' docs) that must stay untracked.
- **No silent fallbacks.** A failed dependency call must surface through the normal error channel (thrown `HttpError`, 5xx, visible UI error state). Never substitute canned data for a failed call.
- **Real rows only.** Every row is a real edge with a real actor. Do not import, call or imitate `generateFakeActivity` from `public.controller.ts`.
- **Do not modify `GET /api/public/activity`** (the homepage ticker with its approved synthetic blend) or its `generateFakeActivity` helper. The new endpoint is `GET /api/public/activity-feed` and shares no code with it.
- **Ended events are NOT filtered out.** Do not import or call `notEndedFilter` anywhere in this feature — it is a discovery-window filter and would gut the deep-history requirement. Only `status !== EventStatus.PUBLISHED` excludes an event.
- **Saves are excluded.** Only `type: 'like'` reaction rows appear. Never `type: 'save'`.
- **Path aliases:** API uses `@models/…`, `@services/…`, `@utils/…`, `@interfaces/…`, `@/…` (see `jest.config.js` `moduleNameMapper`). Website uses `@/…`.
- **Copy, verbatim:** empty state `Nothing yet — be the first`; end-of-history `You're all caught up`; new-rows pill `{n} new`. Going rows read `is going to`, never `bought a ticket`.

## File Structure

**API — new**

| File | Responsibility |
|---|---|
| `api/src/services/activityFeed/types.ts` | Shared types: `ActivityItem`, `ActivityCandidate`, `ActivityCursor`, opts |
| `api/src/services/activityFeed/going.ts` | The going union (`Membership` ∪ `Ticket`) and its dedupe rule — the subtlest logic, isolated so it can be tested alone |
| `api/src/services/activityFeed/sources.ts` | The other five source queries |
| `api/src/services/activityFeed/hydrate.ts` | Batch actor/target hydration; drops suspended actors and unresolvable targets |
| `api/src/services/activityFeed/index.ts` | `getActivityFeed()` — cursor decode/encode, merge, limit |

**API — modified:** six model files (index lines only), `public.controller.ts` (one method), `public.route.ts` (one route).

**Website — new:** `landing/src/types/activity.ts`, `landing/src/services/activityApi.ts`, `landing/src/components/activity/ActivityRow.tsx`, `landing/src/pages/ActivityPage.tsx`.
**Website — modified:** `App.tsx` (route), `Sidebar.tsx` (nav item), `Navbar.tsx` (pulse icon), `socialApi.ts` (`myBlocks`).

---

### Task 1: Recency indexes on the six source collections

Every existing index on these collections serves point lookups. A global newest-first scan is a new access pattern with nothing behind it, and would silently collection-scan.

**Files:**
- Modify: `api/src/models/ticket.model.ts:115` (after the existing indexes)
- Modify: `api/src/models/membership.model.ts:36`
- Modify: `api/src/models/follow.model.ts:45`
- Modify: `api/src/models/eventReaction.model.ts:32`
- Modify: `api/src/models/updateReaction.model.ts:37`
- Modify: `api/src/models/event.model.ts:264`
- Test: `api/src/services/__tests__/activityIndexes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Later tasks depend on these indexes existing for performance only; correctness does not depend on them.

- [ ] **Step 1: Write the failing test**

Create `api/src/services/__tests__/activityIndexes.test.ts`:

```typescript
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Ticket } from '@models/ticket.model';
import { Membership } from '@models/membership.model';
import { Follow } from '@models/follow.model';
import { EventReaction } from '@models/eventReaction.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Event } from '@models/event.model';

/** Mongoose exposes declared indexes as [keySpec, options] tuples. */
function hasIndex(model: any, key: Record<string, number>): boolean {
  return model.schema.indexes().some(([spec]: [Record<string, number>]) =>
    JSON.stringify(spec) === JSON.stringify(key)
  );
}

describe('activity feed recency indexes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('declares a newest-first index on every source the activity feed scans', () => {
    expect(hasIndex(Ticket, { status: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(Membership, { createdAt: -1 })).toBe(true);
    expect(hasIndex(Follow, { createdAt: -1 })).toBe(true);
    expect(hasIndex(EventReaction, { type: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(UpdateReaction, { type: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(Event, { status: 1, publishedAt: -1 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/__tests__/activityIndexes.test.ts`
Expected: FAIL — the first `expect(...).toBe(true)` receives `false`.

- [ ] **Step 3: Add the six index declarations**

In `api/src/models/ticket.model.ts`, after `ticketSchema.index({ ticketId: 1 }, { unique: true });`:

```typescript
// Activity feed: global newest-first scan of live tickets (the "is going"
// source). Every other Ticket index is a point lookup — none serves recency.
ticketSchema.index({ status: 1, createdAt: -1 });
```

In `api/src/models/membership.model.ts`, after the unique index:

```typescript
// Activity feed: global newest-first scan of community joins ("is going").
membershipSchema.index({ createdAt: -1 });
```

In `api/src/models/follow.model.ts`, after `followSchema.index({ targetType: 1, targetId: 1 });`:

```typescript
// Activity feed: global newest-first scan of follow edges.
followSchema.index({ createdAt: -1 });
```

In `api/src/models/eventReaction.model.ts`, after the unique index:

```typescript
// Activity feed: global newest-first scan of likes (saves are never shown).
schema.index({ type: 1, createdAt: -1 });
```

In `api/src/models/updateReaction.model.ts`, after the "my saved updates" index:

```typescript
// Activity feed: global newest-first scan of likes across ALL actors. The
// index above is actor-scoped and cannot serve this.
schema.index({ type: 1, createdAt: -1 });
```

In `api/src/models/event.model.ts`, after `eventSchema.index({ vendorId: 1, eventDate: -1 });`:

```typescript
// Activity feed: newest-first scan of published events ("announced").
eventSchema.index({ status: 1, publishedAt: -1 });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/services/__tests__/activityIndexes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd api
git add src/models/ticket.model.ts src/models/membership.model.ts src/models/follow.model.ts src/models/eventReaction.model.ts src/models/updateReaction.model.ts src/models/event.model.ts src/services/__tests__/activityIndexes.test.ts
git commit -m "perf: add recency indexes for the activity feed's global scans"
```

---

### Task 2: Shared types

**Files:**
- Create: `api/src/services/activityFeed/types.ts`

**Interfaces:**
- Consumes: `SocialActor` from `@utils/socialActor.util`.
- Produces: `ActivityType`, `ActivityActor`, `ActivityTarget`, `ActivityItem`, `ActivityCandidate`, `ActivityCursor`, `ActivityTab`, `ActivityFeedOpts`, `SOURCE_KEYS`. Every later API task imports from here.

- [ ] **Step 1: Write the file**

Create `api/src/services/activityFeed/types.ts`:

```typescript
import type { SocialActor } from '@utils/socialActor.util';

/** One row kind. The client renders the sentence from this — the server never
 *  builds prose, so copy changes ship without an API deploy. */
export type ActivityType =
  | 'like_event'
  | 'like_post'
  | 'follow'
  | 'going'
  | 'post'
  | 'event';

/** Cursor keys, one watermark per source. Short to keep the base64 small. */
export const SOURCE_KEYS = {
  like_event: 'le',
  like_post: 'lp',
  follow: 'f',
  going: 'g',
  post: 'p',
  event: 'e',
} as const;

export interface ActivityActor {
  kind: 'buyer' | 'organizer';
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  href: string;
}

export interface ActivityTarget {
  kind: 'event' | 'post' | 'buyer' | 'organizer';
  id: string;
  name: string | null;
  imageUrl: string | null;
  href: string;
}

/** A fully hydrated, client-ready row. */
export interface ActivityItem {
  type: ActivityType;
  /** Stable row id, `"<type>:<sourceId>"`. Used as the React key. */
  id: string;
  sortAt: string; // ISO
  actor: ActivityActor;
  target: ActivityTarget;
}

/** A pre-hydration row: identifiers only, no names or images yet. */
export interface ActivityCandidate {
  type: ActivityType;
  sourceId: string;
  sortAt: Date;
  actor: { kind: 'buyer' | 'organizer'; id: string };
  target: { kind: 'event' | 'post' | 'buyer' | 'organizer'; id: string };
}

/** One ISO watermark per source key. Absent key = start from newest. */
export interface ActivityCursor {
  le?: string;
  lp?: string;
  f?: string;
  g?: string;
  p?: string;
  e?: string;
}

export type ActivityTab = 'everyone' | 'following';

export interface ActivityFeedOpts {
  tab: ActivityTab;
  cursor?: string;
  limit?: number;
  /** Required when tab === 'following'; the caller enforces that. */
  viewer?: SocialActor;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd api && npx tsc --noEmit`
Expected: no errors referencing `activityFeed/types.ts`.

- [ ] **Step 3: Commit**

```bash
cd api
git add src/services/activityFeed/types.ts
git commit -m "feat: add activity feed shared types"
```

---

### Task 3: The going union and its dedupe rule

The subtlest piece. A person who both joined an event's community and holds a ticket produces two rows for one (buyer, event) pair. Deduping "within the current page" leaves duplicates across pages, because the twin row may sit hundreds of rows deeper.

**The rule, which is page-independent:** a going row's `sortAt` is `min(membership.createdAt, earliest live ticket.createdAt)` for the pair, emitted **once**, by the row that produced that minimum. A row from the other source fails the `===` check and is suppressed — on any page. The minimum is computed from **unwindowed** lookups (no `before` filter), which is exactly what makes it global and therefore page-independent.

**Files:**
- Create: `api/src/services/activityFeed/going.ts`
- Test: `api/src/services/activityFeed/__tests__/going.test.ts`

**Interfaces:**
- Consumes: `ActivityCandidate` from `./types`.
- Produces: `goingCandidates(opts: { before?: Date; limit: number; actorIds?: string[] | null }): Promise<ActivityCandidate[]>` — returns `type: 'going'` candidates sorted `sortAt` desc.

- [ ] **Step 1: Write the failing test**

Create `api/src/services/activityFeed/__tests__/going.test.ts`:

```typescript
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { goingCandidates } from '../going';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketStatus } from '@interfaces/ticket.interface';

const DAY = 86400000;

async function seedEvent(name: string, status: EventStatus = EventStatus.PUBLISHED) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  const event = await Event.create({
    vendorId: vendor._id, name, venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status, ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
  const community = await Community.create({ eventId: event._id, vendorId: vendor._id });
  return { vendor, event, community };
}

async function seedBuyer(phone: string) {
  return Buyer.create({ phone, password: 'password123', name: 'B' + phone });
}

/** createdAt is set by timestamps, so override it explicitly after insert. */
async function joinAt(buyerId: any, communityId: any, at: Date) {
  const m = await Membership.create({ buyerId, communityId });
  await Membership.updateOne({ _id: m._id }, { $set: { createdAt: at } }, { timestamps: false });
  return m;
}

async function ticketAt(eventId: any, vendorId: any, phone: string, at: Date, status = TicketStatus.SOLD) {
  const t = await Ticket.create({
    eventId, vendorId, ticketId: 'T' + Math.random().toString(36).slice(2, 10),
    customerPhone: phone, customerName: 'B', ticketType: 'GA', price: 100, status,
  });
  await Ticket.updateOne({ _id: t._id }, { $set: { createdAt: at } }, { timestamps: false });
  return t;
}

describe('goingCandidates', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns a going row for a community join', async () => {
    const { event, community } = await seedEvent('E1');
    const buyer = await seedBuyer('+26878000001');
    await joinAt(buyer._id, community._id, new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('going');
    expect(rows[0]!.actor).toEqual({ kind: 'buyer', id: String(buyer._id) });
    expect(rows[0]!.target).toEqual({ kind: 'event', id: String(event._id) });
  });

  it('returns a going row for a live ticket with no community join', async () => {
    const { vendor, event } = await seedEvent('E2');
    const buyer = await seedBuyer('+26878000002');
    await ticketAt(event._id, vendor._id, buyer.phone, new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor.id).toBe(String(buyer._id));
  });

  it('emits ONE row at the earlier timestamp when the buyer both joined and holds a ticket', async () => {
    const { vendor, event, community } = await seedEvent('E3');
    const buyer = await seedBuyer('+26878000003');
    const ticketTime = new Date(Date.now() - 5 * DAY); // earlier — owns the pair
    const joinTime = new Date(Date.now() - 1 * DAY);
    await ticketAt(event._id, vendor._id, buyer.phone, ticketTime);
    await joinAt(buyer._id, community._id, joinTime);

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sortAt.getTime()).toBe(ticketTime.getTime());
  });

  it('does not re-emit the pair on a later page (cross-page dedupe)', async () => {
    const { vendor, event, community } = await seedEvent('E4');
    const buyer = await seedBuyer('+26878000004');
    const ticketTime = new Date(Date.now() - 5 * DAY);
    const joinTime = new Date(Date.now() - 1 * DAY);
    await ticketAt(event._id, vendor._id, buyer.phone, ticketTime);
    await joinAt(buyer._id, community._id, joinTime);

    // Page 2: window starts strictly before the join, so the join row is the
    // only candidate in range. It must still be suppressed by the older ticket.
    const rows = await goingCandidates({ limit: 20, before: new Date(joinTime.getTime() + 1) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sortAt.getTime()).toBe(ticketTime.getTime());

    const deeper = await goingCandidates({ limit: 20, before: ticketTime });
    expect(deeper).toHaveLength(0);
  });

  it('skips a ticket whose phone matches no Carrot account (POS walk-up)', async () => {
    const { vendor, event } = await seedEvent('E5');
    await ticketAt(event._id, vendor._id, '+26878999999', new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(0);
  });

  it('excludes banned memberships and non-live tickets', async () => {
    const { vendor, event, community } = await seedEvent('E6');
    const banned = await seedBuyer('+26878000006');
    const refunded = await seedBuyer('+26878000007');
    const m = await joinAt(banned._id, community._id, new Date(Date.now() - DAY));
    await Membership.updateOne({ _id: m._id }, { $set: { bannedAt: new Date() } });
    await ticketAt(event._id, vendor._id, refunded.phone, new Date(Date.now() - DAY), TicketStatus.REFUNDED);

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(0);
  });

  it('excludes unpublished events but KEEPS ended ones', async () => {
    const draft = await seedEvent('E7', EventStatus.DRAFT);
    const ended = await seedEvent('E8');
    await Event.updateOne(
      { _id: ended.event._id },
      { $set: { endTime: new Date(Date.now() - 30 * DAY), eventDate: new Date(Date.now() - 30 * DAY) } }
    );
    const b1 = await seedBuyer('+26878000008');
    const b2 = await seedBuyer('+26878000009');
    await joinAt(b1._id, draft.community._id, new Date(Date.now() - DAY));
    await joinAt(b2._id, ended.community._id, new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target.id).toBe(String(ended.event._id));
  });

  it('restricts to actorIds when the following tab passes them', async () => {
    const { community } = await seedEvent('E9');
    const followed = await seedBuyer('+26878000010');
    const stranger = await seedBuyer('+26878000011');
    await joinAt(followed._id, community._id, new Date(Date.now() - DAY));
    await joinAt(stranger._id, community._id, new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20, actorIds: [String(followed._id)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor.id).toBe(String(followed._id));
  });

  it('returns rows newest-first', async () => {
    const a = await seedEvent('EA');
    const b = await seedEvent('EB');
    const buyer = await seedBuyer('+26878000012');
    await joinAt(buyer._id, a.community._id, new Date(Date.now() - 5 * DAY));
    await joinAt(buyer._id, b.community._id, new Date(Date.now() - 1 * DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows.map((r) => r.target.id)).toEqual([String(b.event._id), String(a.event._id)]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/activityFeed/__tests__/going.test.ts`
Expected: FAIL — `Cannot find module '../going'`.

- [ ] **Step 3: Write the implementation**

Create `api/src/services/activityFeed/going.ts`:

```typescript
import { Membership } from '@models/membership.model';
import { Community } from '@models/community.model';
import { Ticket } from '@models/ticket.model';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { EventStatus } from '@interfaces/event.interface';
import type { ActivityCandidate } from './types';

/** Live-ticket contract, identical to GoingService's. Do not diverge. */
const LIVE = [TicketStatus.SOLD, TicketStatus.CHECKED_IN];

interface Row {
  buyerId: string;
  eventId: string;
  at: Date;
  sourceId: string;
}

const pairKey = (buyerId: string, eventId: string) => `${buyerId}|${eventId}`;

/**
 * "Going" candidates: the union of community joins and live tickets, matching
 * GoingService's definition exactly.
 *
 * A buyer who both joined and holds a ticket would yield two rows for one
 * (buyer, event) pair. The dedupe rule is page-INDEPENDENT: the pair's
 * timestamp is min(joinedAt, earliest live ticketAt), and only the row that
 * produced that minimum is emitted. The minimum comes from UNWINDOWED lookups
 * (no `before`), so a twin row surfacing on a much later page still fails the
 * check and stays suppressed. Deduping only within a page would leak
 * duplicates across pages.
 *
 * Suspension is NOT filtered here — hydrate() drops suspended actors centrally
 * for all six sources.
 */
export async function goingCandidates(opts: {
  before?: Date;
  limit: number;
  actorIds?: string[] | null;
}): Promise<ActivityCandidate[]> {
  const { before, limit, actorIds } = opts;

  // ---- 1. window: newest rows from each source ----
  const membershipQuery: any = { bannedAt: { $exists: false } };
  if (before) membershipQuery.createdAt = { $lt: before };
  if (actorIds) membershipQuery.buyerId = { $in: actorIds };
  const memberships = await Membership.find(membershipQuery)
    .sort({ createdAt: -1 }).limit(limit).select('buyerId communityId createdAt').lean();

  const ticketQuery: any = { status: { $in: LIVE } };
  if (before) ticketQuery.createdAt = { $lt: before };
  const tickets = await Ticket.find(ticketQuery)
    .sort({ createdAt: -1 }).limit(limit).select('customerPhone eventId createdAt').lean();

  // ---- 2. resolve every windowed row to a (buyerId, eventId) pair ----
  const windowCommunities = memberships.length
    ? await Community.find({ _id: { $in: memberships.map((m) => m.communityId) } }).select('eventId').lean()
    : [];
  const eventIdByCommunity = new Map(windowCommunities.map((c) => [String(c._id), String(c.eventId)]));

  const windowPhones = [...new Set(tickets.map((t) => t.customerPhone).filter(Boolean))] as string[];
  const windowBuyers = windowPhones.length
    ? await Buyer.find({ phone: { $in: windowPhones } }).select('phone').lean()
    : [];
  const buyerIdByPhone = new Map(windowBuyers.map((b) => [b.phone, String(b._id)]));

  const rows: Row[] = [];
  for (const m of memberships) {
    const eventId = eventIdByCommunity.get(String(m.communityId));
    if (!eventId) continue;
    rows.push({ buyerId: String(m.buyerId), eventId, at: m.createdAt as Date, sourceId: String(m._id) });
  }
  for (const t of tickets) {
    // A POS walk-up sale has no Carrot account behind the phone — no actor,
    // no row. Never invent one.
    const buyerId = t.customerPhone ? buyerIdByPhone.get(t.customerPhone) : undefined;
    if (!buyerId) continue;
    if (actorIds && !actorIds.includes(buyerId)) continue;
    rows.push({ buyerId, eventId: String(t.eventId), at: t.createdAt as Date, sourceId: String(t._id) });
  }
  if (rows.length === 0) return [];

  const buyerIds = [...new Set(rows.map((r) => r.buyerId))];
  const eventIds = [...new Set(rows.map((r) => r.eventId))];

  // ---- 3. published filter. Ended events are KEPT: this is history, not
  //         discovery, so notEndedFilter must NOT be used here. ----
  const publishedDocs = await Event.find({ _id: { $in: eventIds }, status: EventStatus.PUBLISHED }).select('_id').lean();
  const published = new Set(publishedDocs.map((e) => String(e._id)));

  // ---- 4. unwindowed minimums, per pair ----
  const allCommunities = await Community.find({ eventId: { $in: eventIds } }).select('eventId').lean();
  const eventIdByCommunityAll = new Map(allCommunities.map((c) => [String(c._id), String(c.eventId)]));
  const allMemberships = allCommunities.length
    ? await Membership.find({
        buyerId: { $in: buyerIds },
        communityId: { $in: allCommunities.map((c) => c._id) },
        bannedAt: { $exists: false },
      }).select('buyerId communityId createdAt').lean()
    : [];

  const allBuyers = await Buyer.find({ _id: { $in: buyerIds } }).select('phone').lean();
  const buyerIdByPhoneAll = new Map(allBuyers.map((b) => [b.phone, String(b._id)]));
  const allPhones = allBuyers.map((b) => b.phone);
  const allTickets = allPhones.length
    ? await Ticket.find({
        customerPhone: { $in: allPhones },
        eventId: { $in: eventIds },
        status: { $in: LIVE },
      }).select('customerPhone eventId createdAt').lean()
    : [];

  const earliest = new Map<string, number>();
  const note = (buyerId: string, eventId: string, at: Date) => {
    const key = pairKey(buyerId, eventId);
    const ms = at.getTime();
    const seen = earliest.get(key);
    if (seen === undefined || ms < seen) earliest.set(key, ms);
  };
  for (const m of allMemberships) {
    const eventId = eventIdByCommunityAll.get(String(m.communityId));
    if (eventId) note(String(m.buyerId), eventId, m.createdAt as Date);
  }
  for (const t of allTickets) {
    const buyerId = t.customerPhone ? buyerIdByPhoneAll.get(t.customerPhone) : undefined;
    if (buyerId) note(buyerId, String(t.eventId), t.createdAt as Date);
  }

  // ---- 5. emit ----
  const emitted = new Set<string>();
  const out: ActivityCandidate[] = [];
  for (const r of rows) {
    if (!published.has(r.eventId)) continue;
    const key = pairKey(r.buyerId, r.eventId);
    if (emitted.has(key)) continue;
    // A twin row is strictly older — it owns this pair, on every page.
    if (earliest.get(key) !== r.at.getTime()) continue;
    emitted.add(key);
    out.push({
      type: 'going',
      sourceId: r.sourceId,
      sortAt: r.at,
      actor: { kind: 'buyer', id: r.buyerId },
      target: { kind: 'event', id: r.eventId },
    });
  }
  return out.sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/services/activityFeed/__tests__/going.test.ts`
Expected: PASS — all 9 tests.

If the cross-page test fails, the bug is almost certainly a `before` filter leaking into the step-4 lookups. Those must be unwindowed.

- [ ] **Step 5: Commit**

```bash
cd api
git add src/services/activityFeed/going.ts src/services/activityFeed/__tests__/going.test.ts
git commit -m "feat: add going candidates with page-independent dedupe"
```

---

### Task 4: The other five sources

**Files:**
- Create: `api/src/services/activityFeed/sources.ts`
- Test: `api/src/services/activityFeed/__tests__/sources.test.ts`

**Interfaces:**
- Consumes: `ActivityCandidate` from `./types`.
- Produces: five functions, each `(opts: { before?: Date; limit: number; actorIds?: string[] | null }) => Promise<ActivityCandidate[]>`:
  `likeEventCandidates`, `likePostCandidates`, `followCandidates`, `postCandidates`, `eventCandidates`.
  `actorIds` for `followCandidates`/`postCandidates`/`eventCandidates` matches either a buyer or a vendor id, since both act socially.

- [ ] **Step 1: Write the failing test**

Create `api/src/services/activityFeed/__tests__/sources.test.ts`:

```typescript
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { likeEventCandidates, likePostCandidates, followCandidates, postCandidates, eventCandidates } from '../sources';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import { EventReaction } from '@models/eventReaction.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Follow } from '@models/follow.model';
import { EventStatus } from '@interfaces/event.interface';
import mongoose from 'mongoose';

const DAY = 86400000;

async function seedEvent(name: string, status: EventStatus = EventStatus.PUBLISHED) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  const event = await Event.create({
    vendorId: vendor._id, name, venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status, publishedAt: new Date(Date.now() - DAY), ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
  return { vendor, event };
}

async function seedPost(authorId: any, authorType: 'buyer' | 'vendor' = 'vendor') {
  return Update.create({
    authorType, authorId, kind: 'image', caption: 'hi',
    media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } },
  });
}

describe('activity feed sources', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('likeEventCandidates returns likes and never saves', async () => {
    const { event } = await seedEvent('E1');
    const buyer = await Buyer.create({ phone: '+26878100001', password: 'password123' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });

    const rows = await likeEventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('like_event');
    expect(rows[0]!.target).toEqual({ kind: 'event', id: String(event._id) });
    expect(rows[0]!.actor).toEqual({ kind: 'buyer', id: String(buyer._id) });
  });

  it('likeEventCandidates excludes unpublished events but keeps ended ones', async () => {
    const draft = await seedEvent('E2', EventStatus.DRAFT);
    const ended = await seedEvent('E3');
    await Event.updateOne({ _id: ended.event._id }, { $set: { endTime: new Date(Date.now() - 30 * DAY) } });
    const buyer = await Buyer.create({ phone: '+26878100002', password: 'password123' });
    await EventReaction.create({ eventId: draft.event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: ended.event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const rows = await likeEventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target.id).toBe(String(ended.event._id));
  });

  it('likePostCandidates maps a vendor actor and drops removed posts', async () => {
    const { vendor } = await seedEvent('E4');
    const live = await seedPost(vendor._id);
    const removed = await seedPost(vendor._id);
    await Update.updateOne({ _id: removed._id }, { $set: { status: 'removed' } });
    await UpdateReaction.create({ updateId: live._id, buyerId: vendor._id, actorType: 'vendor', type: 'like' });
    await UpdateReaction.create({ updateId: removed._id, buyerId: vendor._id, actorType: 'vendor', type: 'like' });

    const rows = await likePostCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('like_post');
    expect(rows[0]!.actor).toEqual({ kind: 'organizer', id: String(vendor._id) });
    expect(rows[0]!.target).toEqual({ kind: 'post', id: String(live._id) });
  });

  it('followCandidates maps buyer and organizer targets', async () => {
    const buyer = await Buyer.create({ phone: '+26878100003', password: 'password123' });
    const other = await Buyer.create({ phone: '+26878100004', password: 'password123' });
    const { vendor } = await seedEvent('E5');
    await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'buyer', targetId: other._id });
    await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'organizer', targetId: vendor._id });

    const rows = await followCandidates({ limit: 20 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target.kind).sort()).toEqual(['buyer', 'organizer']);
    expect(rows.every((r) => r.type === 'follow')).toBe(true);
  });

  it('postCandidates returns ready active posts only', async () => {
    const { vendor } = await seedEvent('E6');
    const ok = await seedPost(vendor._id);
    const pending = await Update.create({
      authorType: 'vendor', authorId: vendor._id, kind: 'video', caption: '',
      media: { rawKey: 'k2', status: 'processing' },
    });

    const rows = await postCandidates({ limit: 20 });
    // The processing post is excluded: its media is not ready, so it would
    // render as a broken thumbnail in the feed.
    expect(rows.map((r) => r.target.id)).toEqual([String(ok._id)]);
    expect(rows.map((r) => r.target.id)).not.toContain(String(pending._id));
    expect(rows[0]!.actor).toEqual({ kind: 'organizer', id: String(vendor._id) });
  });

  it('eventCandidates returns published events with the vendor as actor', async () => {
    const { vendor, event } = await seedEvent('E7');
    await seedEvent('E8', EventStatus.DRAFT);

    const rows = await eventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('event');
    expect(rows[0]!.actor).toEqual({ kind: 'organizer', id: String(vendor._id) });
    expect(rows[0]!.target).toEqual({ kind: 'event', id: String(event._id) });
  });

  it('honours the before watermark', async () => {
    const buyer = await Buyer.create({ phone: '+26878100005', password: 'password123' });
    const a = await Buyer.create({ phone: '+26878100006', password: 'password123' });
    const b = await Buyer.create({ phone: '+26878100007', password: 'password123' });
    const older = await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'buyer', targetId: a._id });
    // Backdate through the raw driver: Mongoose 7 marks createdAt immutable under
    // `timestamps: true` and strips it from a $set, so Model.updateOne(..., {timestamps:false})
    // silently no-ops. Confirmed the hard way in Task 3.
    await Follow.collection.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 5 * DAY) } });
    const newer = await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'buyer', targetId: b._id });

    const rows = await followCandidates({ limit: 20, before: newer.createdAt as Date });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target.id).toBe(String(a._id));
  });

  it('restricts to actorIds for the following tab', async () => {
    const { event } = await seedEvent('E9');
    const followed = await Buyer.create({ phone: '+26878100008', password: 'password123' });
    const stranger = await Buyer.create({ phone: '+26878100009', password: 'password123' });
    await EventReaction.create({ eventId: event._id, buyerId: followed._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: event._id, buyerId: stranger._id, actorType: 'buyer', type: 'like' });

    const rows = await likeEventCandidates({ limit: 20, actorIds: [String(followed._id)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor.id).toBe(String(followed._id));
    expect(mongoose.isValidObjectId(rows[0]!.actor.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/activityFeed/__tests__/sources.test.ts`
Expected: FAIL — `Cannot find module '../sources'`.

- [ ] **Step 3: Write the implementation**

Create `api/src/services/activityFeed/sources.ts`:

```typescript
import { EventReaction } from '@models/eventReaction.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Follow } from '@models/follow.model';
import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import type { ActivityCandidate } from './types';

export interface SourceOpts {
  before?: Date;
  limit: number;
  actorIds?: string[] | null;
}

/** An actorType of 'vendor' means an organizer brand acting socially. */
const actorKind = (actorType: string): 'buyer' | 'organizer' =>
  actorType === 'vendor' ? 'organizer' : 'buyer';

/**
 * Ids of events that are PUBLISHED, among the given candidates.
 *
 * Ended events are deliberately included — this is history, not discovery, so
 * notEndedFilter must NOT be used. Filtering ended events here would empty the
 * feed as soon as a reader pages past the current season.
 */
async function publishedEventIds(ids: any[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const docs = await Event.find({ _id: { $in: ids }, status: EventStatus.PUBLISHED }).select('_id').lean();
  return new Set(docs.map((e) => String(e._id)));
}

/** Ids of posts that are still visible, among the given candidates. */
async function livePostIds(ids: any[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const docs = await Update.find({ _id: { $in: ids }, status: 'active', 'media.status': 'ready' }).select('_id').lean();
  return new Set(docs.map((u) => String(u._id)));
}

function windowed(base: any, opts: SourceOpts): any {
  const query = { ...base };
  if (opts.before) query.createdAt = { $lt: opts.before };
  return query;
}

export async function likeEventCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  const query = windowed({ type: 'like' }, opts);
  if (opts.actorIds) query.buyerId = { $in: opts.actorIds };
  const rows = await EventReaction.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  const published = await publishedEventIds(rows.map((r) => r.eventId));
  return rows
    .filter((r) => published.has(String(r.eventId)))
    .map((r) => ({
      type: 'like_event' as const,
      sourceId: String(r._id),
      sortAt: r.createdAt as Date,
      actor: { kind: actorKind(r.actorType), id: String(r.buyerId) },
      target: { kind: 'event' as const, id: String(r.eventId) },
    }));
}

export async function likePostCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  const query = windowed({ type: 'like' }, opts);
  if (opts.actorIds) query.buyerId = { $in: opts.actorIds };
  const rows = await UpdateReaction.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  const live = await livePostIds(rows.map((r) => r.updateId));
  return rows
    .filter((r) => live.has(String(r.updateId)))
    .map((r) => ({
      type: 'like_post' as const,
      sourceId: String(r._id),
      sortAt: r.createdAt as Date,
      actor: { kind: actorKind(r.actorType), id: String(r.buyerId) },
      target: { kind: 'post' as const, id: String(r.updateId) },
    }));
}

export async function followCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  const query = windowed({}, opts);
  if (opts.actorIds) query.followerId = { $in: opts.actorIds };
  const rows = await Follow.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  return rows.map((r) => ({
    type: 'follow' as const,
    sourceId: String(r._id),
    sortAt: r.createdAt as Date,
    actor: { kind: actorKind(r.followerType), id: String(r.followerId) },
    target: { kind: r.targetType === 'organizer' ? ('organizer' as const) : ('buyer' as const), id: String(r.targetId) },
  }));
}

export async function postCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  const query = windowed({ status: 'active', 'media.status': 'ready' }, opts);
  if (opts.actorIds) query.authorId = { $in: opts.actorIds };
  const rows = await Update.find(query).sort({ createdAt: -1 }).limit(opts.limit).select('authorType authorId createdAt').lean();
  return rows.map((r) => ({
    type: 'post' as const,
    sourceId: String(r._id),
    sortAt: r.createdAt as Date,
    actor: { kind: actorKind(r.authorType), id: String(r.authorId) },
    target: { kind: 'post' as const, id: String(r._id) },
  }));
}

export async function eventCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  // publishedAt is optional on older rows; createdAt is the fallback, which is
  // why the window predicate is an $or rather than a single field.
  const query: any = { status: EventStatus.PUBLISHED };
  if (opts.before) {
    query.$or = [
      { publishedAt: { $lt: opts.before } },
      { publishedAt: { $exists: false }, createdAt: { $lt: opts.before } },
    ];
  }
  if (opts.actorIds) query.vendorId = { $in: opts.actorIds };
  const rows = await Event.find(query).sort({ publishedAt: -1, createdAt: -1 }).limit(opts.limit)
    .select('vendorId publishedAt createdAt').lean();
  return rows.map((r) => ({
    type: 'event' as const,
    sourceId: String(r._id),
    sortAt: (r.publishedAt ?? r.createdAt) as Date,
    actor: { kind: 'organizer' as const, id: String(r.vendorId) },
    target: { kind: 'event' as const, id: String(r._id) },
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/services/activityFeed/__tests__/sources.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```bash
cd api
git add src/services/activityFeed/sources.ts src/services/activityFeed/__tests__/sources.test.ts
git commit -m "feat: add the five simple activity feed sources"
```

---

### Task 5: Batch hydration

Turns identifier-only candidates into client-ready rows. This is the single place suspended actors and unresolvable targets are dropped, so no source has to repeat that logic.

**Files:**
- Create: `api/src/services/activityFeed/hydrate.ts`
- Test: `api/src/services/activityFeed/__tests__/hydrate.test.ts`

**Interfaces:**
- Consumes: `ActivityCandidate`, `ActivityItem` from `./types`.
- Produces: `hydrate(candidates: ActivityCandidate[]): Promise<ActivityItem[]>` — preserves input order, drops rows whose actor or target does not resolve.

- [ ] **Step 1: Write the failing test**

Create `api/src/services/activityFeed/__tests__/hydrate.test.ts`:

```typescript
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { hydrate } from '../hydrate';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import { EventStatus } from '@interfaces/event.interface';
import type { ActivityCandidate } from '../types';
import mongoose from 'mongoose';

const DAY = 86400000;
const at = new Date('2026-07-30T10:00:00.000Z');

describe('hydrate', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('hydrates a buyer actor and an event target with hrefs', async () => {
    const buyer = await Buyer.create({ phone: '+26878200001', password: 'password123', name: 'Sipho', username: 'sipho' });
    const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org' });
    const event = await Event.create({
      vendorId: vendor._id, name: 'Winter Fest', venue: 'V', posterUrl: 'https://cdn/p.jpg',
      eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
      status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 10 }],
    });

    const candidates: ActivityCandidate[] = [{
      type: 'like_event', sourceId: 'src1', sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      target: { kind: 'event', id: String(event._id) },
    }];

    const [item] = await hydrate(candidates);
    expect(item!.id).toBe('like_event:src1');
    expect(item!.sortAt).toBe(at.toISOString());
    expect(item!.actor).toEqual({
      kind: 'buyer', id: String(buyer._id), name: 'Sipho', username: 'sipho', avatarUrl: null, href: '/u/sipho',
    });
    expect(item!.target.name).toBe('Winter Fest');
    expect(item!.target.imageUrl).toBe('https://cdn/p.jpg');
    expect(item!.target.href).toBe(`/event/winter-fest-${String(event._id)}`);
  });

  it('hydrates an organizer actor', async () => {
    const vendor = await Vendor.create({ businessName: 'King Derby', password: 'password123', slug: 'king-derby', logoUrl: 'https://cdn/l.png' });
    const post = await Update.create({
      authorType: 'vendor', authorId: vendor._id, kind: 'image', caption: '',
      media: { rawKey: 'k', status: 'ready', image: { url: 'https://cdn/i.jpg', width: 1, height: 1 } },
    });

    const [item] = await hydrate([{
      type: 'post', sourceId: String(post._id), sortAt: at,
      actor: { kind: 'organizer', id: String(vendor._id) },
      target: { kind: 'post', id: String(post._id) },
    }]);
    expect(item!.actor).toEqual({
      kind: 'organizer', id: String(vendor._id), name: 'King Derby', username: 'king-derby',
      avatarUrl: 'https://cdn/l.png', href: `/o/${String(vendor._id)}`,
    });
    expect(item!.target.imageUrl).toBe('https://cdn/i.jpg');
    expect(item!.target.href).toBe(`/post/${String(post._id)}`);
  });

  it('drops a row whose actor is socially suspended', async () => {
    const buyer = await Buyer.create({
      phone: '+26878200002', password: 'password123', username: 'banned', socialSuspendedAt: new Date(),
    });
    const other = await Buyer.create({ phone: '+26878200003', password: 'password123', username: 'ok' });

    const items = await hydrate([{
      type: 'follow', sourceId: 's', sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      target: { kind: 'buyer', id: String(other._id) },
    }]);
    expect(items).toHaveLength(0);
  });

  it('drops a row whose target no longer resolves', async () => {
    const buyer = await Buyer.create({ phone: '+26878200004', password: 'password123', username: 'sipho2' });
    const items = await hydrate([{
      type: 'like_event', sourceId: 's', sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      target: { kind: 'event', id: String(new mongoose.Types.ObjectId()) },
    }]);
    expect(items).toHaveLength(0);
  });

  it('falls back to the id-based profile href when a buyer has no username', async () => {
    const buyer = await Buyer.create({ phone: '+26878200005', password: 'password123', name: 'No Handle' });
    const other = await Buyer.create({ phone: '+26878200006', password: 'password123', username: 'target' });
    const [item] = await hydrate([{
      type: 'follow', sourceId: 's', sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      target: { kind: 'buyer', id: String(other._id) },
    }]);
    expect(item!.actor.username).toBeNull();
    expect(item!.actor.href).toBe(`/u/${String(buyer._id)}`);
  });

  it('preserves input order', async () => {
    const b1 = await Buyer.create({ phone: '+26878200007', password: 'password123', username: 'a1' });
    const b2 = await Buyer.create({ phone: '+26878200008', password: 'password123', username: 'a2' });
    const t = await Buyer.create({ phone: '+26878200009', password: 'password123', username: 't' });
    const mk = (id: string, sourceId: string): ActivityCandidate => ({
      type: 'follow', sourceId, sortAt: at,
      actor: { kind: 'buyer', id }, target: { kind: 'buyer', id: String(t._id) },
    });

    const items = await hydrate([mk(String(b2._id), 's2'), mk(String(b1._id), 's1')]);
    expect(items.map((i) => i.id)).toEqual(['follow:s2', 'follow:s1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/activityFeed/__tests__/hydrate.test.ts`
Expected: FAIL — `Cannot find module '../hydrate'`.

- [ ] **Step 3: Write the implementation**

Create `api/src/services/activityFeed/hydrate.ts`:

```typescript
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import type { ActivityCandidate, ActivityItem, ActivityActor, ActivityTarget } from './types';

/** Mirrors landing/src/lib/eventUrl.ts slugifyEventName. Keep in sync — the
 *  client resolves an event by the trailing 24-hex id, so a drifting slug is
 *  cosmetic, not fatal. */
function slugifyEventName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export async function hydrate(candidates: ActivityCandidate[]): Promise<ActivityItem[]> {
  if (candidates.length === 0) return [];

  const buyerIds = new Set<string>();
  const vendorIds = new Set<string>();
  const eventIds = new Set<string>();
  const postIds = new Set<string>();
  for (const c of candidates) {
    (c.actor.kind === 'buyer' ? buyerIds : vendorIds).add(c.actor.id);
    if (c.target.kind === 'buyer') buyerIds.add(c.target.id);
    if (c.target.kind === 'organizer') vendorIds.add(c.target.id);
    if (c.target.kind === 'event') eventIds.add(c.target.id);
    if (c.target.kind === 'post') postIds.add(c.target.id);
  }

  // Suspended actors are excluded HERE, once, for all six sources. A suspended
  // buyer can still be a follow TARGET (they are not erased), but never an actor.
  const [buyers, vendors, events, posts] = await Promise.all([
    buyerIds.size ? Buyer.find({ _id: { $in: [...buyerIds] } }).select('name username avatarUrl socialSuspendedAt').lean() : [],
    vendorIds.size ? Vendor.find({ _id: { $in: [...vendorIds] } }).select('businessName slug logoUrl').lean() : [],
    eventIds.size ? Event.find({ _id: { $in: [...eventIds] } }).select('name posterUrl').lean() : [],
    postIds.size ? Update.find({ _id: { $in: [...postIds] } }).select('media').lean() : [],
  ]);

  const buyerById = new Map(buyers.map((b) => [String(b._id), b]));
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
  const eventById = new Map(events.map((e) => [String(e._id), e]));
  const postById = new Map(posts.map((p) => [String(p._id), p]));

  const buildActor = (ref: ActivityCandidate['actor']): ActivityActor | null => {
    if (ref.kind === 'buyer') {
      const b = buyerById.get(ref.id);
      if (!b || b.socialSuspendedAt) return null;
      return {
        kind: 'buyer', id: ref.id,
        name: b.name ?? null,
        username: b.username ?? null,
        avatarUrl: b.avatarUrl ?? null,
        href: b.username ? `/u/${b.username}` : `/u/${ref.id}`,
      };
    }
    const v = vendorById.get(ref.id);
    if (!v) return null;
    return {
      kind: 'organizer', id: ref.id,
      name: v.businessName ?? null,
      username: v.slug ?? null,
      avatarUrl: v.logoUrl ?? null,
      href: `/o/${ref.id}`,
    };
  };

  const buildTarget = (ref: ActivityCandidate['target']): ActivityTarget | null => {
    switch (ref.kind) {
      case 'event': {
        const e = eventById.get(ref.id);
        if (!e) return null;
        return {
          kind: 'event', id: ref.id, name: e.name ?? null,
          imageUrl: (e as any).posterUrl ?? null,
          href: `/event/${slugifyEventName(e.name ?? '')}-${ref.id}`,
        };
      }
      case 'post': {
        const p = postById.get(ref.id);
        if (!p) return null;
        const media: any = (p as any).media ?? {};
        return {
          kind: 'post', id: ref.id, name: null,
          imageUrl: media.image?.url ?? media.video?.thumbnailUrl ?? null,
          href: `/post/${ref.id}`,
        };
      }
      case 'buyer': {
        const b = buyerById.get(ref.id);
        if (!b) return null;
        return {
          kind: 'buyer', id: ref.id, name: b.name ?? b.username ?? null,
          imageUrl: b.avatarUrl ?? null,
          href: b.username ? `/u/${b.username}` : `/u/${ref.id}`,
        };
      }
      case 'organizer': {
        const v = vendorById.get(ref.id);
        if (!v) return null;
        return { kind: 'organizer', id: ref.id, name: v.businessName ?? null, imageUrl: v.logoUrl ?? null, href: `/o/${ref.id}` };
      }
    }
  };

  const items: ActivityItem[] = [];
  for (const c of candidates) {
    const actor = buildActor(c.actor);
    if (!actor) continue;
    const target = buildTarget(c.target);
    if (!target) continue;
    items.push({ type: c.type, id: `${c.type}:${c.sourceId}`, sortAt: c.sortAt.toISOString(), actor, target });
  }
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/services/activityFeed/__tests__/hydrate.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
cd api
git add src/services/activityFeed/hydrate.ts src/services/activityFeed/__tests__/hydrate.test.ts
git commit -m "feat: add batch hydration for activity feed rows"
```

---

### Task 6: Merge, cursor and the following filter

**Files:**
- Create: `api/src/services/activityFeed/index.ts`
- Test: `api/src/services/activityFeed/__tests__/activityFeed.test.ts`

**Interfaces:**
- Consumes: `goingCandidates` (Task 3), the five source functions (Task 4), `hydrate` (Task 5), all types (Task 2).
- **`goingCandidates` returns `{ candidates: ActivityCandidate[]; nextBefore: Date | null }`, NOT a bare array** — it merges two collections under one watermark and publishes the floor below which it could not guarantee completeness. The other five sources return bare arrays.
- Produces: `getActivityFeed(opts: ActivityFeedOpts): Promise<{ items: ActivityItem[]; nextCursor: string | null }>`.

- [ ] **Step 1: Write the failing test**

Create `api/src/services/activityFeed/__tests__/activityFeed.test.ts`:

```typescript
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { getActivityFeed } from '../index';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Follow } from '@models/follow.model';
import { EventReaction } from '@models/eventReaction.model';
import { EventStatus } from '@interfaces/event.interface';

const DAY = 86400000;

async function seedVendorEvent(name: string) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  const event = await Event.create({
    vendorId: vendor._id, name, venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED, publishedAt: new Date(Date.now() - DAY),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
  return { vendor, event };
}

describe('getActivityFeed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns rows newest-first across sources', async () => {
    const { event } = await seedVendorEvent('E1');
    const a = await Buyer.create({ phone: '+26878300001', password: 'password123', username: 'a' });
    const b = await Buyer.create({ phone: '+26878300002', password: 'password123', username: 'b' });
    await EventReaction.create({ eventId: event._id, buyerId: a._id, actorType: 'buyer', type: 'like' });
    await Follow.create({ followerType: 'buyer', followerId: b._id, targetType: 'buyer', targetId: a._id });

    const { items } = await getActivityFeed({ tab: 'everyone', limit: 30 });
    const types = items.map((i) => i.type);
    expect(types).toContain('like_event');
    expect(types).toContain('follow');
    expect(types).toContain('event');
    const stamps = items.map((i) => Date.parse(i.sortAt));
    expect([...stamps].sort((x, y) => y - x)).toEqual(stamps);
  });

  it('pages without duplicates or gaps', async () => {
    const { event } = await seedVendorEvent('E2');
    for (let i = 0; i < 12; i++) {
      const buyer = await Buyer.create({ phone: `+2687840${String(i).padStart(4, '0')}`, password: 'password123', username: `u${i}` });
      await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res: any = await getActivityFeed({ tab: 'everyone', limit: 5, cursor });
      seen.push(...res.items.map((i: any) => i.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);            // no duplicates
    expect(seen.filter((id) => id.startsWith('like_event:'))).toHaveLength(12); // no gaps
  });

  it('treats a malformed cursor as "start from newest"', async () => {
    const { event } = await seedVendorEvent('E3');
    const buyer = await Buyer.create({ phone: '+26878300003', password: 'password123', username: 'm' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const { items } = await getActivityFeed({ tab: 'everyone', limit: 30, cursor: 'not-base64-json' });
    expect(items.length).toBeGreaterThan(0);
  });

  it('clamps limit to 50', async () => {
    const res = await getActivityFeed({ tab: 'everyone', limit: 5000 });
    expect(res.items.length).toBeLessThanOrEqual(50);
  });

  it('following tab returns only followed actors, buyers AND organizers', async () => {
    const { vendor, event } = await seedVendorEvent('E4');
    const viewer = await Buyer.create({ phone: '+26878300004', password: 'password123', username: 'v' });
    const friend = await Buyer.create({ phone: '+26878300005', password: 'password123', username: 'f' });
    const stranger = await Buyer.create({ phone: '+26878300006', password: 'password123', username: 's' });
    await Follow.create({ followerType: 'buyer', followerId: viewer._id, targetType: 'buyer', targetId: friend._id });
    await Follow.create({ followerType: 'buyer', followerId: viewer._id, targetType: 'organizer', targetId: vendor._id });
    await EventReaction.create({ eventId: event._id, buyerId: friend._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: event._id, buyerId: stranger._id, actorType: 'buyer', type: 'like' });

    const { items } = await getActivityFeed({
      tab: 'following', limit: 30, viewer: { type: 'buyer', id: String(viewer._id) },
    });
    const actorIds = items.map((i) => i.actor.id);
    expect(actorIds).toContain(String(friend._id));
    expect(actorIds).toContain(String(vendor._id)); // the organizer's own "announced" row
    expect(actorIds).not.toContain(String(stranger._id));
  });

  it('nextCursor is null when history is exhausted', async () => {
    const { event } = await seedVendorEvent('E5');
    const buyer = await Buyer.create({ phone: '+26878300007', password: 'password123', username: 'x' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    let cursor: string | undefined;
    let last: any;
    for (let page = 0; page < 10; page++) {
      last = await getActivityFeed({ tab: 'everyone', limit: 30, cursor });
      if (!last.nextCursor) break;
      cursor = last.nextCursor;
    }
    expect(last.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/activityFeed/__tests__/activityFeed.test.ts`
Expected: FAIL — `Cannot find module '../index'`.

- [ ] **Step 3: Write the implementation**

Create `api/src/services/activityFeed/index.ts`:

```typescript
import { Follow } from '@models/follow.model';
import { goingCandidates } from './going';
import { likeEventCandidates, likePostCandidates, followCandidates, postCandidates, eventCandidates } from './sources';
import { hydrate } from './hydrate';
import { SOURCE_KEYS } from './types';
import type { ActivityCandidate, ActivityCursor, ActivityFeedOpts, ActivityItem, ActivityType } from './types';

const MAX_LIMIT = 50;

/** A malformed cursor starts from newest rather than throwing — same
 *  contract as feed.service.ts's decode(). */
function decode(cursor?: string): ActivityCursor {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function encode(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

const watermark = (cursor: ActivityCursor, type: ActivityType): Date | undefined => {
  const raw = cursor[SOURCE_KEYS[type]];
  return raw ? new Date(raw) : undefined;
};

/**
 * The activity feed: six sources merged newest-first, with one cursor
 * watermark per source so heterogeneous collections page without an offset.
 *
 * There is NO time cutoff — paging continues until every source is exhausted,
 * so the feed reads full on a quiet day without any fabricated rows.
 */
export async function getActivityFeed(
  opts: ActivityFeedOpts
): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), MAX_LIMIT);
  const cursor = decode(opts.cursor);

  // Following: the viewer's followed buyers AND organizers, both of which act
  // socially. Callers guarantee `viewer` is present for this tab.
  let actorIds: string[] | null = null;
  if (opts.tab === 'following') {
    const follows = await Follow.find({
      followerType: opts.viewer?.type === 'vendor' ? 'vendor' : 'buyer',
      followerId: opts.viewer?.id,
    }).select('targetId').lean();
    actorIds = follows.map((f) => String(f.targetId));
    if (actorIds.length === 0) return { items: [], nextCursor: null };
  }

  const per = (type: ActivityType) => ({ before: watermark(cursor, type), limit, actorIds });

  const [likeEvents, likePosts, follows, goingResult, posts, events] = await Promise.all([
    likeEventCandidates(per('like_event')),
    likePostCandidates(per('like_post')),
    followCandidates(per('follow')),
    goingCandidates(per('going')),
    postCandidates(per('post')),
    eventCandidates(per('event')),
  ]);

  // `going` is the only source that merges TWO collections (Membership and
  // Ticket) under one watermark. Their sub-windows are limited independently,
  // so it publishes `nextBefore`: the floor below which THIS call could not
  // guarantee completeness. Two rules follow, and both are load-bearing:
  //   1. `g` must never advance PAST nextBefore, or a pair whose twin row sat
  //      below the shallower sub-window is skipped on every subsequent page.
  //   2. When no going candidate is consumed, `g` must advance TO nextBefore
  //      anyway — otherwise a clamped-to-empty page re-issues the identical
  //      query forever and the source wedges permanently.
  const going = goingResult.candidates;
  const goingFloor = goingResult.nextBefore;

  const all: ActivityCandidate[] = [...likeEvents, ...likePosts, ...follows, ...going, ...posts, ...events]
    .sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime());

  const page = all.slice(0, limit);
  const items = await hydrate(page);

  // The next cursor records the last consumed position PER SOURCE. A source
  // with nothing consumed on this page keeps its previous watermark, so it is
  // not re-read from the top on the next page.
  const next: ActivityCursor = { ...cursor };
  let advanced = false;
  for (const candidate of page) {
    next[SOURCE_KEYS[candidate.type]] = candidate.sortAt.toISOString();
    advanced = true;
  }

  // Apply going's two rules (see the comment above goingFloor).
  if (goingFloor) {
    const floorIso = goingFloor.toISOString();
    const consumed = next[SOURCE_KEYS.going];
    // Rule 1 + 2 collapse to: take whichever is NEWER — the floor, or the last
    // consumed going row. `undefined` (nothing consumed) falls through to the
    // floor, which is what un-wedges a clamped-to-empty page.
    if (!consumed || Date.parse(consumed) < goingFloor.getTime()) {
      next[SOURCE_KEYS.going] = floorIso;
    }
    advanced = true; // a published floor is real progress even with zero rows
  }

  // Exhausted when every source returned less than a full window AND the page
  // consumed everything they gave us — there is nothing left behind. `going`
  // additionally must have published no floor: a non-null floor means it
  // deliberately withheld rows below it, so there IS more to come.
  const exhausted = all.length <= limit
    && !goingFloor
    && [likeEvents, likePosts, follows, going, posts, events].every((rows) => rows.length < limit);

  return { items, nextCursor: exhausted || !advanced ? null : encode(next) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/services/activityFeed/__tests__/activityFeed.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Run the whole activity suite**

Run: `cd api && npx jest src/services/activityFeed src/services/__tests__/activityIndexes.test.ts`
Expected: PASS — every test from Tasks 1, 3, 4, 5, 6.

- [ ] **Step 6: Commit**

```bash
cd api
git add src/services/activityFeed/index.ts src/services/activityFeed/__tests__/activityFeed.test.ts
git commit -m "feat: merge activity sources with per-source cursor paging"
```

---

### Task 7: Public endpoint

**Files:**
- Modify: `api/src/controllers/public.controller.ts` (add one method; leave `getActivity` and `generateFakeActivity` untouched)
- Modify: `api/src/routes/public.route.ts` (add one route near the existing `/activity` route at line 46)
- Test: `api/src/routes/__tests__/activityFeed.route.test.ts`

**Interfaces:**
- Consumes: `getActivityFeed` from `@services/activityFeed`.
- Produces: `GET /api/public/activity-feed?tab=&cursor=&limit=` returning `{ success, data: { items, nextCursor } }`.

- [ ] **Step 1: Write the failing test**

Create `api/src/routes/__tests__/activityFeed.route.test.ts`. Match the app-bootstrapping style of the neighbouring `trending.route.test.ts` — read it first and mirror how it builds the Express app and signs a buyer token.

```typescript
import request from 'supertest';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import app from '@/app';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventReaction } from '@models/eventReaction.model';
import { EventStatus } from '@interfaces/event.interface';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';

const DAY = 86400000;

async function seedLike() {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org' });
  const event = await Event.create({
    vendorId: vendor._id, name: 'Winter Fest', venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED, publishedAt: new Date(Date.now() - DAY),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10 }],
  });
  const buyer = await Buyer.create({ phone: '+26878500001', password: 'password123', username: 'sipho', name: 'Sipho' });
  await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
  return { buyer, event };
}

describe('GET /api/public/activity-feed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('serves the everyone tab to an anonymous visitor', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity-feed');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.items[0]).toHaveProperty('actor.href');
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('401s on the following tab without a session', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity-feed?tab=following');
    expect(res.status).toBe(401);
  });

  it('serves the following tab with a session', async () => {
    const { buyer } = await seedLike();
    const token = jwt.sign({ userPhone: buyer.phone, buyerId: String(buyer._id) }, JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app).get('/api/public/activity-feed?tab=following').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('rejects an unknown tab value', async () => {
    const res = await request(app).get('/api/public/activity-feed?tab=nonsense');
    expect(res.status).toBe(400);
  });

  it('does not touch the legacy ticker endpoint', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('activity');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/routes/__tests__/activityFeed.route.test.ts`
Expected: FAIL — the first test gets 404.

- [ ] **Step 3: Add the controller method**

In `api/src/controllers/public.controller.ts`, add to `PublicController` (place it directly after the existing `getActivity`, so the two are visibly distinct):

```typescript
  /**
   * GET /api/public/activity-feed
   * The Activity page: real social activity across the platform — likes,
   * follows, going, posts and event announcements — newest first.
   *
   * NOT to be confused with getActivity above, which powers the homepage
   * ticker and deliberately blends synthetic purchases. This endpoint is
   * real-only and shares no code with it.
   */
  static async getActivityFeed(req: Request, res: Response): Promise<any> {
    try {
      const tabParam = String(req.query['tab'] ?? 'everyone');
      if (tabParam !== 'everyone' && tabParam !== 'following') {
        return ApiResponseUtil.error(res, 'tab must be "everyone" or "following"', 400);
      }

      let viewer: { type: 'buyer' | 'vendor'; id: string } | undefined;
      if (tabParam === 'following') {
        const buyer = await resolveBuyerFromRequest(req);
        // The following tab cannot be answered without a viewer — say so
        // loudly rather than silently degrading to the everyone tab.
        if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to see who you follow');
        viewer = { type: 'buyer', id: String(buyer._id) };
      }

      const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
      const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;

      const result = await getActivityFeed({ tab: tabParam, cursor, limit, viewer });
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get activity feed error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch activity');
    }
  }
```

Add these imports at the top of the file if not already present:

```typescript
import { getActivityFeed } from '@services/activityFeed';
import { resolveBuyerFromRequest } from '@/utils/buyerRequest.util';
```

- [ ] **Step 4: Add the route**

In `api/src/routes/public.route.ts`, immediately after the existing `router.get('/activity', PublicController.getActivity);` (line 46):

```typescript
/**
 * @route   GET /api/public/activity-feed
 * @desc    The Activity page feed — real likes, follows, going, posts and
 *          event announcements across the platform, newest first. Public;
 *          ?tab=following requires a buyer session.
 * @access  Public
 */
router.get('/activity-feed', optionalTicketsAuth, PublicController.getActivityFeed);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && npx jest src/routes/__tests__/activityFeed.route.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 6: Run the full API suite and typecheck**

Run: `cd api && npx tsc --noEmit && npm test`
Expected: typecheck clean; no test that passed before this branch now fails.

- [ ] **Step 7: Commit**

```bash
cd api
git add src/controllers/public.controller.ts src/routes/public.route.ts src/routes/__tests__/activityFeed.route.test.ts
git commit -m "feat: expose GET /api/public/activity-feed"
```

---

### Task 8: Website API client and types

**Files:**
- Create: `landing/src/types/activity.ts`
- Create: `landing/src/services/activityApi.ts`
- Modify: `landing/src/services/socialApi.ts` (add `myBlocks`)

**Interfaces:**
- Consumes: `fetchApi`, `authHeaders`, `getSessionType` from `@/services/api`.
- Produces: `ActivityItem`, `ActivityActor`, `ActivityTarget`, `ActivityType`, `ActivityTab`, `ActivityPage` types; `activityApi.list({ tab, cursor, limit })`; `socialApi.myBlocks()`.

- [ ] **Step 1: Write the types**

Create `landing/src/types/activity.ts`:

```typescript
export type ActivityType = 'like_event' | 'like_post' | 'follow' | 'going' | 'post' | 'event';
export type ActivityTab = 'everyone' | 'following';

export interface ActivityActor {
  kind: 'buyer' | 'organizer';
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  href: string;
}

export interface ActivityTarget {
  kind: 'event' | 'post' | 'buyer' | 'organizer';
  id: string;
  name: string | null;
  imageUrl: string | null;
  href: string;
}

export interface ActivityItem {
  type: ActivityType;
  id: string;
  sortAt: string;
  actor: ActivityActor;
  target: ActivityTarget;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}
```

- [ ] **Step 2: Write the client**

Create `landing/src/services/activityApi.ts`:

```typescript
import { fetchApi, authHeaders, getSessionType } from '@/services/api';
import type { ActivityPage, ActivityTab } from '@/types/activity';

interface Envelope<T> {
  success: boolean;
  data: T;
  message?: string;
}

export const activityApi = {
  /**
   * The Activity feed. Public — an anonymous visitor gets the everyone tab.
   * Auth headers are attached when a session exists so ?tab=following works;
   * a 401 propagates so the page can prompt sign-in rather than showing an
   * empty list that looks like "nothing is happening".
   */
  list: async (opts: { tab: ActivityTab; cursor?: string; limit?: number }): Promise<ActivityPage> => {
    const params = new URLSearchParams({ tab: opts.tab });
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.limit) params.set('limit', String(opts.limit));
    const res = await fetchApi<Envelope<ActivityPage>>(
      `/api/public/activity-feed?${params.toString()}`,
      getSessionType() ? { headers: authHeaders() } : undefined
    );
    return res.data;
  },
};
```

Check `@/services/api`'s exports before writing this — if `getSessionType` or `authHeaders` have different names in that module, use the actual ones (`socialApi.ts` imports both at its line 1, so they exist).

- [ ] **Step 3: Add `myBlocks` to socialApi**

In `landing/src/services/socialApi.ts`, add next to the existing `blockUser`/`unblockUser` methods (around line 159):

```typescript
  /** Buyer ids the viewer has blocked. Used to hide their rows client-side —
   *  the convention this codebase already uses for channel messages. */
  myBlocks: async (): Promise<string[]> => {
    const res = await authed<{ userIds: string[] }>(`${socialBase()}/me/blocks`);
    return res.userIds ?? [];
  },
```

Read the surrounding methods first: `authed` and `socialBase` are local helpers in that file, and the exact call shape must match how its neighbours use them.

- [ ] **Step 4: Verify it compiles**

Run: `cd landing && npm run build`
Expected: build succeeds. Use `npm run build`, not `tsc --noEmit` — `tsc --noEmit` misses `noUnusedLocals`, which is what actually fails the Cloudflare Pages build.

- [ ] **Step 5: Commit**

```bash
cd landing
git add src/types/activity.ts src/services/activityApi.ts src/services/socialApi.ts
git commit -m "feat: add activity feed API client and types"
```

---

### Task 9: ActivityRow component

**Files:**
- Create: `landing/src/components/activity/ActivityRow.tsx`
- Test: `landing/src/components/activity/__tests__/ActivityRow.test.tsx`

**Interfaces:**
- Consumes: `ActivityItem` from `@/types/activity`; `DemoAvatar` from `@/components/social/DemoAvatar`.
- Produces: named export `ActivityRow`, used as `<ActivityRow item={item} />`. It renders an `<li>`, so callers must wrap it in a `<ul>`.

- [ ] **Step 1: Write the failing test**

Create `landing/src/components/activity/__tests__/ActivityRow.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { ActivityRow } from '../ActivityRow';
import type { ActivityItem } from '@/types/activity';

const buyerActor = {
  kind: 'buyer' as const, id: 'b1', name: 'Sipho', username: 'sipho', avatarUrl: null, href: '/u/sipho',
};
const eventTarget = {
  kind: 'event' as const, id: 'e1', name: 'Winter Fest', imageUrl: null, href: '/event/winter-fest-e1',
};

function row(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    type: 'like_event', id: 'like_event:1', sortAt: new Date().toISOString(),
    actor: buyerActor, target: eventTarget, ...overrides,
  } as ActivityItem;
}

const renderRow = (item: ActivityItem) =>
  render(<MemoryRouter><ActivityRow item={item} /></MemoryRouter>);

describe('ActivityRow', () => {
  it('renders a like_event sentence with both links', () => {
    renderRow(row({}));
    expect(screen.getByText('Sipho')).toHaveAttribute('href', '/u/sipho');
    expect(screen.getByText('Winter Fest')).toHaveAttribute('href', '/event/winter-fest-e1');
    expect(screen.getByText(/liked/)).toBeInTheDocument();
  });

  it('phrases going as "is going to", never as a purchase', () => {
    renderRow(row({ type: 'going', id: 'going:1' }));
    expect(screen.getByText(/is going to/)).toBeInTheDocument();
    expect(screen.queryByText(/bought/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ticket/i)).not.toBeInTheDocument();
  });

  it('renders a follow between two people', () => {
    renderRow(row({
      type: 'follow', id: 'follow:1',
      target: { kind: 'organizer', id: 'v1', name: 'King Derby', imageUrl: null, href: '/o/v1' },
    }));
    expect(screen.getByText(/followed/)).toBeInTheDocument();
    expect(screen.getByText('King Derby')).toHaveAttribute('href', '/o/v1');
  });

  it('renders an event announcement by an organizer', () => {
    renderRow(row({
      type: 'event', id: 'event:1',
      actor: { kind: 'organizer', id: 'v1', name: 'King Derby', username: 'king-derby', avatarUrl: null, href: '/o/v1' },
    }));
    expect(screen.getByText(/announced/)).toBeInTheDocument();
  });

  it('falls back to the handle when the actor has no display name', () => {
    renderRow(row({ actor: { ...buyerActor, name: null } }));
    expect(screen.getByText('@sipho')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd landing && npx vitest run src/components/activity/__tests__/ActivityRow.test.tsx`
Expected: FAIL — cannot resolve `../ActivityRow`.

- [ ] **Step 3: Write the component**

Create `landing/src/components/activity/ActivityRow.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { DemoAvatar } from '@/components/social/DemoAvatar';
import type { ActivityItem } from '@/types/activity';

/** "3m", "5h", "2d" — compact enough for a dense feed row. */
function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

const displayName = (a: ActivityItem['actor']) => a.name || (a.username ? `@${a.username}` : 'Carrot user');

/** Verb phrase between the actor link and the target link. The server never
 *  builds prose, so copy lives here and ships without an API deploy. */
function verb(type: ActivityItem['type']): string {
  switch (type) {
    case 'like_event': return 'liked';
    case 'like_post':  return 'liked a post by';
    case 'follow':     return 'followed';
    case 'going':      return 'is going to';
    case 'post':       return 'posted';
    case 'event':      return 'announced';
  }
}

/** Label for the target link. A post has no name of its own. */
const targetLabel = (item: ActivityItem): string =>
  item.target.name || (item.target.kind === 'post' ? 'a post' : 'Carrot user');

export function ActivityRow({ item }: { item: ActivityItem }) {
  const { actor, target } = item;
  // "posted" reads as a complete sentence — the target IS the post, so
  // repeating it as a trailing link would be noise.
  const showTargetLink = item.type !== 'post';

  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
      <Link to={actor.href} className="shrink-0" aria-label={displayName(actor)}>
        {actor.avatarUrl ? (
          <img src={actor.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <DemoAvatar name={displayName(actor)} size={32} />
        )}
      </Link>

      <p className="min-w-0 flex-1 text-sm leading-snug">
        <Link to={actor.href} className="font-semibold hover:underline">{displayName(actor)}</Link>
        <span className="text-muted-foreground"> {verb(item.type)} </span>
        {showTargetLink && (
          <Link to={target.href} className="font-semibold hover:underline">{targetLabel(item)}</Link>
        )}
        <span className="ml-1.5 whitespace-nowrap text-xs text-muted-foreground">{relativeTime(item.sortAt)}</span>
      </p>

      {target.imageUrl && (
        <Link to={target.href} className="shrink-0" aria-hidden="true" tabIndex={-1}>
          <img src={target.imageUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
        </Link>
      )}
    </li>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd landing && npx vitest run src/components/activity/__tests__/ActivityRow.test.tsx`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
cd landing
git add src/components/activity/ActivityRow.tsx src/components/activity/__tests__/ActivityRow.test.tsx
git commit -m "feat: add ActivityRow component"
```

---

### Task 10: ActivityPage — tabs, infinite scroll, states

**Files:**
- Create: `landing/src/pages/ActivityPage.tsx`
- Modify: `landing/src/App.tsx` (import + one `<Route>` beside `/discover` at line 92)
- Test: `landing/src/pages/__tests__/ActivityPage.test.tsx`

**Interfaces:**
- Consumes: `activityApi.list` (Task 8), `ActivityRow` (Task 9), `useSession` from `@/contexts/SessionContext`.
- Produces: named export `ActivityPage`, routed at `/activity`.

- [ ] **Step 1: Write the failing test**

Create `landing/src/pages/__tests__/ActivityPage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityPage } from '../ActivityPage';
import type { ActivityItem } from '@/types/activity';

const listMock = vi.fn();
vi.mock('@/services/activityApi', () => ({ activityApi: { list: (...a: any[]) => listMock(...a) } }));
vi.mock('@/services/socialApi', () => ({ socialApi: { myBlocks: vi.fn().mockResolvedValue([]) } }));

const sessionMock = vi.fn(() => ({ type: null as string | null, phone: null }));
vi.mock('@/contexts/SessionContext', () => ({ useSession: () => sessionMock() }));

function item(id: string, actorId = 'b1'): ActivityItem {
  return {
    type: 'like_event', id, sortAt: new Date().toISOString(),
    actor: { kind: 'buyer', id: actorId, name: 'Sipho', username: 'sipho', avatarUrl: null, href: '/u/sipho' },
    target: { kind: 'event', id: 'e1', name: 'Winter Fest', imageUrl: null, href: '/event/winter-fest-e1' },
  };
}

const renderPage = () => render(<MemoryRouter><ActivityPage /></MemoryRouter>);

describe('ActivityPage', () => {
  beforeEach(() => {
    listMock.mockReset();
    sessionMock.mockReturnValue({ type: null, phone: null });
  });

  it('renders rows from the everyone tab', async () => {
    listMock.mockResolvedValue({ items: [item('like_event:1')], nextCursor: null });
    renderPage();
    expect(await screen.findByText('Winter Fest')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ tab: 'everyone' }));
  });

  it('shows a LOUD error, not an empty list, when the fetch fails', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/nothing yet/i)).not.toBeInTheDocument();
  });

  it('shows the honest empty state when there is genuinely nothing', async () => {
    listMock.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    expect(await screen.findByText(/nothing yet — be the first/i)).toBeInTheDocument();
  });

  it('prompts sign-in on the following tab when signed out', async () => {
    listMock.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    await screen.findByText(/nothing yet/i);
    await userEvent.click(screen.getByRole('tab', { name: /following/i }));
    expect(await screen.findByRole('link', { name: /sign in/i })).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalledWith(expect.objectContaining({ tab: 'following' }));
  });

  it('fetches the following tab when signed in', async () => {
    sessionMock.mockReturnValue({ type: 'buyer', phone: '+26878422613' });
    listMock.mockResolvedValue({ items: [item('like_event:2')], nextCursor: null });
    renderPage();
    await screen.findByText('Winter Fest');
    await userEvent.click(screen.getByRole('tab', { name: /following/i }));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ tab: 'following' })));
  });

  it('shows the end-of-history terminator when nextCursor is null', async () => {
    listMock.mockResolvedValue({ items: [item('like_event:3')], nextCursor: null });
    renderPage();
    expect(await screen.findByText(/you're all caught up/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd landing && npx vitest run src/pages/__tests__/ActivityPage.test.tsx`
Expected: FAIL — cannot resolve `../ActivityPage`.

- [ ] **Step 3: Write the page**

Create `landing/src/pages/ActivityPage.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { activityApi } from '@/services/activityApi';
import { ActivityRow } from '@/components/activity/ActivityRow';
import { useSession } from '@/contexts/SessionContext';
import type { ActivityItem, ActivityTab } from '@/types/activity';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

function RowSkeleton() {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
      <span className="h-3 flex-1 animate-pulse rounded bg-muted" />
      <span className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-muted" />
    </li>
  );
}

/**
 * The Activity page: the live pulse of the platform. Public — an anonymous
 * visitor sees the Everyone tab in full, and the Following tab advertises
 * itself with a sign-in prompt rather than hiding.
 *
 * Every row is real. There is no time window: paging continues into history
 * until the sources are exhausted, so a quiet day reads as a full page without
 * anything being fabricated.
 */
export function ActivityPage() {
  const { type } = useSession();
  const signedIn = type !== null;

  const [tab, setTab] = useState<ActivityTab>('everyone');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const gated = tab === 'following' && !signedIn;

  const load = useCallback(async (which: ActivityTab, append: string | null) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const page = await activityApi.list({ tab: which, limit: PAGE_SIZE, ...(append ? { cursor: append } : {}) });
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      // Loud, never silent: an empty list here would read as "nothing is
      // happening", which is the opposite of what actually went wrong.
      setError(err instanceof Error ? err.message : 'Could not load activity');
      if (!append) setItems([]);
    } finally {
      append ? setLoadingMore(false) : setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (gated) { setItems([]); setCursor(null); setLoading(false); setError(null); return; }
    void load(tab, null);
  }, [tab, gated, load]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !cursor || loading || loadingMore || gated) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void load(tab, cursor);
    }, { rootMargin: '400px' });
    io.observe(node);
    return () => io.disconnect();
  }, [cursor, loading, loadingMore, gated, tab, load]);

  const tabButton = (value: ActivityTab, label: string) => (
    <button
      key={value}
      type="button"
      role="tab"
      aria-selected={tab === value}
      onClick={() => setTab(value)}
      className={cn(
        'flex-1 border-b-2 px-4 py-3 text-sm font-semibold transition-colors',
        tab === value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-2xl pb-24">
      <header className="px-4 pt-6">
        <h1 className="text-2xl font-extrabold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">What's happening on Carrot right now.</p>
      </header>

      <div role="tablist" className="mt-4 flex border-b border-border">
        {tabButton('everyone', 'Everyone')}
        {tabButton('following', 'Following')}
      </div>

      {gated ? (
        <div className="px-4 py-16 text-center">
          <p className="text-sm text-muted-foreground">See what the people and organisers you follow are up to.</p>
          <Link
            to="/my-tickets/login"
            className="mt-4 inline-flex rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
          >
            Sign in
          </Link>
        </div>
      ) : error ? (
        <div className="px-4 py-16 text-center">
          <p className="text-sm font-semibold text-destructive">Couldn't load activity</p>
          <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => void load(tab, null)}
            className="mt-4 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <ul className="divide-y divide-border">{[...Array(8)].map((_, i) => <RowSkeleton key={i} />)}</ul>
      ) : items.length === 0 ? (
        <div className="px-4 py-16 text-center">
          <p className="text-sm font-semibold">Nothing yet — be the first</p>
          <Link to="/discover" className="mt-3 inline-block text-sm font-semibold text-primary hover:underline">
            Explore events
          </Link>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {items.map((it) => <ActivityRow key={it.id} item={it} />)}
          </ul>
          <div ref={sentinel} aria-hidden="true" />
          {loadingMore && <ul className="divide-y divide-border">{[...Array(3)].map((_, i) => <RowSkeleton key={i} />)}</ul>}
          {!cursor && !loadingMore && (
            <p className="py-8 text-center text-xs text-muted-foreground">You're all caught up</p>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the route**

In `landing/src/App.tsx`, add the import beside the other page imports:

```typescript
import { ActivityPage } from '@/pages/ActivityPage';
```

and the route immediately after `<Route path="/discover" element={<DiscoverPage />} />` (line 92):

```tsx
            <Route path="/activity" element={<ActivityPage />} />
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd landing && npx vitest run src/pages/__tests__/ActivityPage.test.tsx`
Expected: PASS — all 6 tests.

- [ ] **Step 6: Verify the build**

Run: `cd landing && npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
cd landing
git add src/pages/ActivityPage.tsx src/pages/__tests__/ActivityPage.test.tsx src/App.tsx
git commit -m "feat: add the Activity page with Everyone and Following tabs"
```

---

### Task 11: Block filtering and the live "N new" pill

**Files:**
- Modify: `landing/src/pages/ActivityPage.tsx`
- Test: `landing/src/pages/__tests__/ActivityPage.live.test.tsx`

**Interfaces:**
- Consumes: `socialApi.myBlocks` (Task 8).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `landing/src/pages/__tests__/ActivityPage.live.test.tsx`:

```tsx
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityPage } from '../ActivityPage';
import type { ActivityItem } from '@/types/activity';

const listMock = vi.fn();
const blocksMock = vi.fn();
vi.mock('@/services/activityApi', () => ({ activityApi: { list: (...a: any[]) => listMock(...a) } }));
vi.mock('@/services/socialApi', () => ({ socialApi: { myBlocks: () => blocksMock() } }));
vi.mock('@/contexts/SessionContext', () => ({ useSession: () => ({ type: 'buyer', phone: '+26878422613' }) }));

function item(id: string, actorId: string, name: string): ActivityItem {
  return {
    type: 'like_event', id, sortAt: new Date().toISOString(),
    actor: { kind: 'buyer', id: actorId, name, username: name.toLowerCase(), avatarUrl: null, href: `/u/${name.toLowerCase()}` },
    target: { kind: 'event', id: 'e1', name: 'Winter Fest', imageUrl: null, href: '/event/winter-fest-e1' },
  };
}

const renderPage = () => render(<MemoryRouter><ActivityPage /></MemoryRouter>);

describe('ActivityPage live behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listMock.mockReset();
    blocksMock.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it('hides rows whose actor the viewer has blocked', async () => {
    blocksMock.mockResolvedValue(['blocked1']);
    listMock.mockResolvedValue({
      items: [item('a', 'ok1', 'Sipho'), item('b', 'blocked1', 'Troll')],
      nextCursor: null,
    });
    renderPage();
    expect(await screen.findByText('Sipho')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Troll')).not.toBeInTheDocument());
  });

  it('surfaces new rows behind a pill instead of shifting content', async () => {
    listMock.mockResolvedValueOnce({ items: [item('a', 'ok1', 'Sipho')], nextCursor: null });
    renderPage();
    await screen.findByText('Sipho');

    listMock.mockResolvedValueOnce({
      items: [item('new1', 'ok2', 'Thabo'), item('a', 'ok1', 'Sipho')],
      nextCursor: null,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    const pill = await screen.findByRole('button', { name: /1 new/i });
    expect(screen.queryByText('Thabo')).not.toBeInTheDocument(); // not spliced in yet
    await userEvent.click(pill);
    expect(await screen.findByText('Thabo')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd landing && npx vitest run src/pages/__tests__/ActivityPage.live.test.tsx`
Expected: FAIL — the blocked actor is still rendered; no pill exists.

- [ ] **Step 3: Add block filtering**

In `landing/src/pages/ActivityPage.tsx`, add the import:

```typescript
import { socialApi } from '@/services/socialApi';
```

Add state and a loader alongside the existing state:

```typescript
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  // Blocked actors are hidden client-side from GET /api/social/me/blocks —
  // the convention this codebase already uses for channel messages. A failure
  // here must not blank the feed: worst case a blocked actor stays visible,
  // which is strictly better than showing nothing.
  useEffect(() => {
    if (!signedIn) { setBlockedIds(new Set()); return; }
    let cancelled = false;
    socialApi.myBlocks()
      .then((ids) => { if (!cancelled) setBlockedIds(new Set(ids)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [signedIn]);
```

Derive the rendered list just above the `return`:

```typescript
  const visible = items.filter((it) => !blockedIds.has(it.actor.id));
```

Then replace every use of `items` **inside the JSX only** with `visible` — the empty-state check `items.length === 0` and the `.map` both become `visible`. Leave the `items` state itself alone; `visible` is a derived view.

- [ ] **Step 4: Add the polling pill**

Add state:

```typescript
  const [pending, setPending] = useState<ActivityItem[]>([]);
```

Add the poll effect after the infinite-scroll effect:

```typescript
  // Poll for newer rows while the tab is visible. New rows are NOT spliced in
  // under the reader — they queue behind a pill the reader chooses to open.
  useEffect(() => {
    if (gated || error) return;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const page = await activityApi.list({ tab, limit: PAGE_SIZE });
        const known = new Set(items.map((it) => it.id));
        const fresh = page.items.filter((it) => !known.has(it.id));
        if (fresh.length) setPending(fresh);
      } catch {
        // A failed poll is not a failed page — the rows already on screen are
        // still valid, so this stays quiet and retries on the next tick.
      }
    };
    const id = window.setInterval(() => void tick(), 30_000);
    return () => window.clearInterval(id);
  }, [tab, gated, error, items]);

  const showPending = () => {
    setItems((prev) => [...pending, ...prev]);
    setPending([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
```

Render the pill directly inside the top of the results branch, above the `<ul>`:

```tsx
          {pending.length > 0 && (
            <div className="sticky top-2 z-10 flex justify-center py-2">
              <button
                type="button"
                onClick={showPending}
                className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg"
              >
                {pending.length} new
              </button>
            </div>
          )}
```

Clear `pending` whenever the tab changes — add `setPending([])` to the existing tab-load effect, next to `setError(null)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd landing && npx vitest run src/pages/__tests__/`
Expected: PASS — both ActivityPage suites, all 8 tests.

- [ ] **Step 6: Commit**

```bash
cd landing
git add src/pages/ActivityPage.tsx src/pages/__tests__/ActivityPage.live.test.tsx
git commit -m "feat: filter blocked actors and queue new activity behind a pill"
```

---

### Task 12: Navigation entry points

The mobile header is already tight: `Navbar.tsx` carries a comment noting that a fourth control pushed the wordmark onto a second line at 390px, and the wordmark now truncates under pressure. This adds a fifth. Verify at 375px before committing.

**Files:**
- Modify: `landing/src/components/layout/Sidebar.tsx:70-79` (the `items` array) and its icon import at lines 2-11
- Modify: `landing/src/components/Navbar.tsx` (header cluster, ~line 75)
- Test: `landing/src/components/layout/__tests__/Sidebar.activity.test.tsx`

**Interfaces:**
- Consumes: the `/activity` route (Task 10).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `landing/src/components/layout/__tests__/Sidebar.activity.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { Sidebar } from '../Sidebar';

vi.mock('@/contexts/SessionContext', () => ({ useSession: () => ({ type: 'buyer', phone: '+26878422613' }) }));
vi.mock('@/hooks/useSuggestions', () => ({
  useSuggestions: () => ({ people: [], organizers: [], recommendedEvents: [], loading: false }),
}));

describe('Sidebar activity entry', () => {
  it('links to /activity in third position, after Discover', () => {
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    const link = screen.getByRole('link', { name: /^activity$/i });
    expect(link).toHaveAttribute('href', '/activity');

    const labels = screen.getAllByRole('link').map((a) => a.textContent?.trim());
    expect(labels.indexOf('Activity')).toBe(labels.indexOf('Discover') + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd landing && npx vitest run src/components/layout/__tests__/Sidebar.activity.test.tsx`
Expected: FAIL — no link named "Activity".

- [ ] **Step 3: Add the sidebar item**

In `landing/src/components/layout/Sidebar.tsx`, add `Activity` to the lucide import block (lines 2-11):

```typescript
  Activity,
```

Then insert into the `items` array, between the Discover and Topics entries:

```typescript
    { to: '/activity', label: 'Activity', icon: Activity, match: (p) => p.startsWith('/activity') },
```

- [ ] **Step 4: Add the mobile/anonymous header icon**

In `landing/src/components/Navbar.tsx`, add `Activity` to the existing `lucide-react` import, then add this link **inside the header cluster but outside the `isAuthenticated` ternary**, so anonymous visitors get it too — the page is public and this is its only mobile entry point:

```tsx
              {/* Activity — mobile AND anonymous desktop. This is the only
                  entry point to the public /activity page outside the
                  signed-in <Sidebar>, so it must NOT sit inside the
                  isAuthenticated branch. */}
              <Link to="/activity" aria-label="Activity">
                <Button variant="ghost" size="icon" className="transition-all hover:scale-105">
                  <Activity className="h-4 w-4" />
                </Button>
              </Link>
```

Place it as the first child of the `<div className="flex shrink-0 items-center space-x-2 sm:space-x-4">`, before the `{isAuthenticated ? (` ternary.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd landing && npx vitest run src/components/layout/__tests__/Sidebar.activity.test.tsx`
Expected: PASS

- [ ] **Step 6: Verify the crowded mobile header at 375px**

Start the dev server via the preview tooling (never `npm run dev` in a shell), open the site at 375px wide, and confirm on the signed-in mobile header that:
- five controls fit on one row,
- the wordmark truncates rather than wrapping to a second line,
- the page does not scroll horizontally.

If it wraps, drop the wordmark to `hidden min-[400px]:inline` rather than removing a control.

- [ ] **Step 7: Full verification**

Run: `cd landing && npm test && npm run build`
Expected: all suites pass; build succeeds. `npm run build` is required — `tsc --noEmit` misses `noUnusedLocals`, which is what actually fails the Cloudflare Pages build.

- [ ] **Step 8: Commit**

```bash
cd landing
git add src/components/layout/Sidebar.tsx src/components/Navbar.tsx src/components/layout/__tests__/Sidebar.activity.test.tsx
git commit -m "feat: add Activity entry points to the sidebar and header"
```

---

## Final verification

- [ ] `cd api && npx tsc --noEmit && npm test` — clean
- [ ] `cd landing && npm test && npm run build` — clean
- [ ] `cd api && git diff main --stat` and `cd landing && git diff master --stat` — touch only the files this plan names
- [ ] `GET /api/public/activity` still returns `{ activity: [...] }` (Task 7 test 5 covers this)
- [ ] `grep -rn "notEndedFilter" api/src/services/activityFeed/` returns nothing
- [ ] `grep -rn "generateFakeActivity" api/src/services/activityFeed/` returns nothing
- [ ] Manual: `/activity` loads signed-out, Everyone shows real rows, Following prompts sign-in, both nav entry points work
