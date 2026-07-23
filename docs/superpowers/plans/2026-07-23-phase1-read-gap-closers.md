# Phase 1 — Consumer Read Gap-Closers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the read-only buyer endpoints the redesigned consumer UI needs (Saved, Going, Calendar, Following-events, People/Organizer suggestions, Recommendations) so `SuggestedPage`, `CalendarPage`, the desktop Sidebar lists, the Profile Saved/Going tabs, and the Home Following/Favorites tabs stop rendering `demoData`.

**Architecture:** All new endpoints are buyer-authed GETs under the existing `/api/social` router. They read existing collections (`UpdateReaction`, `EventReaction`, `Follow`, `Membership`, `Ticket`, `Event`, `Buyer`, `Vendor`) — no new models, no migrations. To avoid duplicating the frontend-facing DTO shapes, Tasks 1–2 first extract the currently-inline `EventCard` and `UpdateSlide` serializers into shared utils, then every list endpoint reuses them.

**Tech Stack:** Express + TypeScript, Mongoose (MongoDB), Jest + ts-jest, supertest, mongodb-memory-server.

## Global Constraints

- **No fake data (CLAUDE.md):** every endpoint returns real data or an empty list — never canned/placeholder items. Empty is `{ success:true, data:[] }` (or `{updates:[],events:[]}`), not a stub.
- **Auth:** buyer routes use `authenticateBuyer` from `@middleware/ticketsAuth.middleware`; it attaches the raw JWT to `(req as any).ticketsUser` (`{ app:'tickets', userType:'buyer', userPhone }`). Resolve the buyer with `resolveBuyerFromRequest(req)` from `@/utils/buyerRequest.util` (returns `IBuyer | null`). There is **no** typed `req.buyer`/`req.user`.
- **Response envelope:** controllers use `ApiResponseUtil` from `@utils/apiResponse.util` — body is `{ success, message, data, timestamp, path }`. Success = `ApiResponseUtil.success(res, data)`; anon = `ApiResponseUtil.unauthorized(res, 'Please sign in first')`.
- **Errors:** services `throw new HttpError(status, msg)` from `@utils/httpError.util`; controllers wrap handlers in `try/catch` and map with `failWithHttpError(res, error, fallback)` from `@utils/controllerHelpers.util`. Do **not** use `AppError`/`asyncHandler`.
- **Actor discriminator:** reaction/follow rows store the actor id in a `buyerId`/`followerId` column disambiguated by `actorType`/`followerType`. Every query MUST filter `actorType:'buyer'` (or `followerType:'buyer'`).
- **Lean reads:** `event.likeCount`/`shareCount` need `?? 0`.
- **Route order:** register `/me/*` and `/suggestions/*` and `/recommendations` **before** the existing `/users/:username` param route in `social.route.ts`.
- **Deploy prereq (already exists):** `npm run backfill:social-actor-types` must have run in the target env before these ship (they query `Follow`/`UpdateReaction` by `*Type`).
- Test commands: one file `npx jest <path>`; one test `npx jest <path> -t "<name>"`; suite `npm test`.

---

## File Structure

**Create:**
- `src/utils/eventCard.util.ts` — `toPublicEventCard(event, extras)` pure serializer (extracted from `public.controller`).
- `src/services/eventCards.service.ts` — `buildEventCards(eventIds, actor)` (load events in order + organizer map + viewer-like flags → cards).
- `src/services/savedContent.service.ts` — saved update/event id lists + visible saved updates.
- `src/services/going.service.ts` — a buyer's going/attended event ids.
- `src/services/calendar.service.ts` — month-grouped calendar payload.
- `src/services/suggestions.service.ts` — people-you-may-know + organizers-to-follow.
- `src/services/recommendations.service.ts` — "because you saved X" basis + event ids.
- `src/controllers/consumerReads.controller.ts` — thin controllers for all Phase-1 endpoints.
- Test files under `src/routes/__tests__/` and `src/services/__tests__/` (one per task).

**Modify:**
- `src/services/update.service.ts` — add `buildUpdateSlides(updates, actor)`.
- `src/controllers/public.controller.ts` — use `toPublicEventCard` in `getPublicEvents`/`getPublicEvent`.
- `src/routes/social.route.ts` — register the 7 new routes.

---

### Task 1: Extract `toPublicEventCard` serializer

**Files:**
- Create: `src/utils/eventCard.util.ts`
- Create: `src/utils/__tests__/eventCard.util.test.ts`
- Modify: `src/controllers/public.controller.ts` (`getPublicEvents`, `getPublicEvent` mappers)

**Interfaces:**
- Produces: `toPublicEventCard(event: any, extras?: PublicEventCardExtras) => PublicEventCard` where `PublicEventCardExtras = { recentSales?: number; trending?: boolean; viewerHasLiked?: boolean; likeCount?: number; organizer?: { id:string; businessName:string; logoUrl:string|null } | null }`.
- **Each extra is emitted ONLY when its key is present in `extras`** (via `'k' in extras`), so the two existing call sites reproduce their exact prior response shapes: the LIST mapper (`getPublicEvents`, currently lines ~286–316) emits `recentSales`+`trending`+`organizer`+`likeCount`+`viewerHasLiked`; the DETAIL mapper (`getPublicEvent`, currently lines ~417–443) emits only `organizer` (+ its own `isMultiDay`/`galleryImages`). Neither endpoint's JSON keys change.

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/__tests__/eventCard.util.test.ts
import { toPublicEventCard } from '@/utils/eventCard.util';

const baseEvent = {
  _id: 'e1', name: 'Bushfire', description: 'd', venue: 'House on Fire',
  eventDate: new Date('2026-08-01'), startTime: new Date(), endTime: new Date(),
  posterUrl: 'p', thumbnailUrl: 't', likeCount: 4,
  ticketTypes: [
    { _id: 'tt1', name: 'GA', description: '', price: 100, available: 5, isSoldOut: false },
    { _id: 'tt2', name: 'VIP', description: '', price: 300, available: 0, isSoldOut: true },
  ],
};

it('maps ticketTypes to a priceRange and marks sold-out tiers', () => {
  const card = toPublicEventCard(baseEvent);
  expect(card.priceRange).toEqual({ min: 100, max: 300 });
  expect(card.ticketTypes[1]?.isSoldOut).toBe(true);
});

it('emits ONLY base fields when no extras are given (no shape widening)', () => {
  const card = toPublicEventCard(baseEvent);
  expect('organizer' in card).toBe(false);
  expect('recentSales' in card).toBe(false);
  expect('trending' in card).toBe(false);
  expect('likeCount' in card).toBe(false);
  expect('viewerHasLiked' in card).toBe(false);
});

it('includes only the extras it is given', () => {
  const card = toPublicEventCard(baseEvent, {
    organizer: { id: 'v1', businessName: 'MTN Bushfire', logoUrl: null },
    recentSales: 12, trending: true, likeCount: 4, viewerHasLiked: true,
  });
  expect(card.organizer?.businessName).toBe('MTN Bushfire');
  expect(card.recentSales).toBe(12);
  expect(card.trending).toBe(true);
  expect(card.likeCount).toBe(4);
  expect(card.viewerHasLiked).toBe(true);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '@/utils/eventCard.util'`)

Run: `npx jest src/utils/__tests__/eventCard.util.test.ts`

- [ ] **Step 3: Implement the serializer** (reproduce `public.controller`'s current fields EXACTLY so the refactor is behavior-preserving)

```ts
// src/utils/eventCard.util.ts
export interface PublicEventCardExtras {
  recentSales?: number;
  trending?: boolean;
  viewerHasLiked?: boolean;
  likeCount?: number;
  organizer?: { id: string; businessName: string; logoUrl: string | null } | null;
}

/** THE public "event card" DTO. Base fields are always emitted; the optional
 *  extras are emitted ONLY when the caller passes the key, so each existing
 *  call site reproduces its exact prior response shape (no silent widening). */
export function toPublicEventCard(event: any, extras: PublicEventCardExtras = {}) {
  const tts: any[] = event.ticketTypes ?? [];
  const card: Record<string, any> = {
    _id: event._id,
    name: event.name,
    description: event.description,
    venue: event.venue,
    eventDate: event.eventDate,
    startTime: event.startTime,
    endTime: event.endTime,
    posterUrl: event.posterUrl,
    thumbnailUrl: event.thumbnailUrl,
    ticketTypes: tts.map((tt) => ({
      _id: tt._id, name: tt.name, description: tt.description, price: tt.price,
      available: tt.available, isSoldOut: tt.isSoldOut || tt.available === 0,
    })),
    isSoldOut: tts.every((tt) => tt.isSoldOut || tt.available === 0),
    priceRange: {
      min: Math.min(...tts.map((tt) => tt.price)),
      max: Math.max(...tts.map((tt) => tt.price)),
    },
  };
  if ('organizer' in extras) card.organizer = extras.organizer ?? null;
  if ('recentSales' in extras) card.recentSales = extras.recentSales;
  if ('trending' in extras) card.trending = extras.trending;
  if ('likeCount' in extras) card.likeCount = extras.likeCount;
  if ('viewerHasLiked' in extras) card.viewerHasLiked = extras.viewerHasLiked;
  return card;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx jest src/utils/__tests__/eventCard.util.test.ts`

- [ ] **Step 5: Refactor `public.controller.ts` to use it (behavior-preserving)**

The LIST mapper is the `events.map(event => ({ ... }))` in `getPublicEvents` (lines ~286–316); the DETAIL mapper is the `const publicEvent = { ... }` in `getPublicEvent` (lines ~417–443). Pass EXACTLY the extras each endpoint already emits, so neither response shape changes.

Add the import: `import { toPublicEventCard } from '@/utils/eventCard.util';`

`getPublicEvents` — replace the `.map` object literal with:
```ts
const publicEvents = events.map((event: any) => toPublicEventCard(event, {
  recentSales: recentMap.get(String(event._id)) || 0,
  trending: trendingIds.has(String(event._id)),
  organizer: event.vendorId ? (organizerMap.get(String(event.vendorId)) ?? null) : null,
  likeCount: (event as any).likeCount ?? 0,
  viewerHasLiked: likedMap[String(event._id)]?.liked ?? false,
}));
```
`getPublicEvent` — it already resolves `const organizer = await PublicController.resolveOrganizer(event.vendorId)`. Replace the `const publicEvent = { ... }` literal with (detail passes only `organizer`, then keeps its own two fields):
```ts
const publicEvent = {
  ...toPublicEventCard(event, { organizer }),
  isMultiDay: event.isMultiDay,
  galleryImages: event.galleryImages,
};
```
The two safety-net tests to keep green: `publicEventsList.organizer.route.test.ts` and `publicEvent.organizer.route.test.ts`.

- [ ] **Step 6: Run the existing public route tests — expect PASS (no behavior change)**

Run: `npx jest src/routes/__tests__ -t "public"` then `npx jest src/controllers`
Expected: all previously-passing event tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/eventCard.util.ts src/utils/__tests__/eventCard.util.test.ts src/controllers/public.controller.ts
git commit -m "refactor(api): extract toPublicEventCard serializer, reuse in public controller"
```

---

### Task 2: `buildEventCards` + `buildUpdateSlides` shared loaders

**Files:**
- Create: `src/services/eventCards.service.ts`
- Create: `src/services/__tests__/eventCards.service.test.ts`
- Modify: `src/services/update.service.ts` (add `buildUpdateSlides`)
- Create: `src/services/__tests__/buildUpdateSlides.test.ts`

**Interfaces:**
- Consumes: `toPublicEventCard` (Task 1); `SocialActor` from `@/utils/socialActor.util`; `getViewerEventReactions` from `@services/eventReaction.service`; `UpdateService.getViewerReactions` from `@services/update.service`.
- Produces:
  - `buildEventCards(eventIds: string[], actor: SocialActor | null) => Promise<any[]>` — events in the given id order, published-or-not (caller decides the id set), each as a `toPublicEventCard` with organizer + viewerHasLiked.
  - `UpdateService.buildUpdateSlides(updates: IUpdate[], actor: SocialActor | null) => Promise<any[]>` — feed-slide DTOs with author + viewerReactions + viewerIsAuthor.

- [ ] **Step 1: Write the failing test for `buildEventCards`**

```ts
// src/services/__tests__/eventCards.service.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { buildEventCards } from '@services/eventCards.service';

describe('buildEventCards', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns cards in the requested id order with organizer attached', async () => {
    const v = await Vendor.create({ businessName: 'MTN Bushfire' });
    const e1 = await Event.create({ vendorId: v._id, name: 'A', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const e2 = await Event.create({ vendorId: v._id, name: 'B', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 50, quantity: 10, available: 10 }] });
    const cards = await buildEventCards([String(e2._id), String(e1._id)], null);
    expect(cards.map((c) => c.name)).toEqual(['B', 'A']);
    expect(cards[0].organizer.businessName).toBe('MTN Bushfire');
  });

  it('returns [] for no ids', async () => {
    expect(await buildEventCards([], null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/services/__tests__/eventCards.service.test.ts`

- [ ] **Step 3: Implement `buildEventCards`**

```ts
// src/services/eventCards.service.ts
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { toPublicEventCard } from '@/utils/eventCard.util';
import { getViewerEventReactions } from '@services/eventReaction.service';
import type { SocialActor } from '@/utils/socialActor.util';

/** Load events by id (preserving the given order) and serialize each to the
 *  public event-card DTO with organizer + per-viewer like flag. */
export async function buildEventCards(eventIds: string[], actor: SocialActor | null): Promise<any[]> {
  if (eventIds.length === 0) return [];
  const events = await Event.find({ _id: { $in: eventIds } });
  const byId = new Map(events.map((e) => [String(e._id), e]));
  const ordered = eventIds.map((id) => byId.get(id)).filter(Boolean) as any[];

  const vendorIds = [...new Set(ordered.map((e) => String(e.vendorId)).filter(Boolean))];
  const vendors = vendorIds.length ? await Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl') : [];
  const vMap = new Map(vendors.map((v: any) => [String(v._id), { id: String(v._id), businessName: v.businessName, logoUrl: v.logoUrl ?? null }]));

  const liked = actor ? await getViewerEventReactions(ordered.map((e) => String(e._id)), actor) : {};
  return ordered.map((e) => toPublicEventCard(e, {
    organizer: e.vendorId ? (vMap.get(String(e.vendorId)) ?? null) : null,
    viewerHasLiked: liked[String(e._id)]?.liked ?? false,
  }));
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/services/__tests__/eventCards.service.test.ts`

- [ ] **Step 5: Write the failing test for `buildUpdateSlides`**

```ts
// src/services/__tests__/buildUpdateSlides.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Update } from '@models/update.model';
import { UpdateService } from '@services/update.service';

describe('UpdateService.buildUpdateSlides', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('hydrates buyer author + defaults viewer flags when no actor', async () => {
    const author = await Buyer.create({ phone: '+26878000001', password: 'secret1', name: 'Sipho', username: 'sipho' });
    const u = await Update.create({ authorType: 'buyer', authorId: author._id, kind: 'image', caption: 'hi', media: { rawKey: 'k', status: 'ready', image: { url: 'https://cdn/i.jpg', width: 1, height: 1 } } });
    const [slide] = await UpdateService.buildUpdateSlides([u], null);
    expect(slide.type).toBe('update');
    expect(slide.author).toMatchObject({ type: 'buyer', name: 'Sipho', username: 'sipho' });
    expect(slide.viewerReactions).toEqual({ liked: false, saved: false });
    expect(slide.viewerIsAuthor).toBe(false);
  });
});
```

- [ ] **Step 6: Run — expect FAIL** (`buildUpdateSlides is not a function`)

Run: `npx jest src/services/__tests__/buildUpdateSlides.test.ts`

- [ ] **Step 7: Implement `buildUpdateSlides` in `update.service.ts`**

Add these imports if absent (`Vendor`, `Buyer`, `SocialActor`) and the static method:
```ts
// inside class UpdateService
static async buildUpdateSlides(updates: any[], actor: SocialActor | null): Promise<any[]> {
  if (updates.length === 0) return [];
  const vendorIds = updates.filter((u) => u.authorType === 'vendor').map((u) => String(u.authorId));
  const buyerIds = updates.filter((u) => u.authorType === 'buyer').map((u) => String(u.authorId));
  const vendors = vendorIds.length ? await Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl slug') : [];
  const buyers = buyerIds.length ? await Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : [];
  const vMap = new Map(vendors.map((v: any) => [String(v._id), v]));
  const bMap = new Map(buyers.map((b: any) => [String(b._id), b]));
  const reactions = actor ? await UpdateService.getViewerReactions(updates.map((u) => String(u._id)), actor) : {};

  return updates.map((u) => {
    const author = u.authorType === 'vendor'
      ? { type: 'organizer', id: String(u.authorId), name: vMap.get(String(u.authorId))?.businessName ?? 'Organizer', avatarUrl: vMap.get(String(u.authorId))?.logoUrl ?? null, slug: vMap.get(String(u.authorId))?.slug ?? null }
      : { type: 'buyer', id: String(u.authorId), name: bMap.get(String(u.authorId))?.name ?? null, username: bMap.get(String(u.authorId))?.username ?? null, avatarUrl: bMap.get(String(u.authorId))?.avatarUrl ?? null };
    const actorMatchesAuthor = !!actor && ((u.authorType === 'vendor' && actor.type === 'vendor') || (u.authorType === 'buyer' && actor.type === 'buyer')) && String(u.authorId) === actor.id;
    return {
      type: 'update', id: String(u._id), sortAt: u.createdAt.toISOString(),
      kind: u.kind, caption: u.caption, media: u.media,
      likeCount: u.likeCount, saveCount: u.saveCount, shareCount: u.shareCount, viewCount: u.viewCount ?? 0,
      eventId: u.eventId ? String(u.eventId) : null, author,
      viewerReactions: reactions[String(u._id)] ?? { liked: false, saved: false },
      viewerIsAuthor: actorMatchesAuthor,
    };
  });
}
```

- [ ] **Step 8: Run — expect PASS**

Run: `npx jest src/services/__tests__/buildUpdateSlides.test.ts`

- [ ] **Step 9: Commit**

```bash
git add src/services/eventCards.service.ts src/services/update.service.ts src/services/__tests__/eventCards.service.test.ts src/services/__tests__/buildUpdateSlides.test.ts
git commit -m "feat(api): shared buildEventCards + buildUpdateSlides loaders"
```

---

### Task 3: `GET /api/social/me/saved`

**Files:**
- Create: `src/services/savedContent.service.ts`
- Create: `src/controllers/consumerReads.controller.ts` (add `mySaved`)
- Modify: `src/routes/social.route.ts`
- Create: `src/routes/__tests__/consumerSaved.route.test.ts`

**Interfaces:**
- Consumes: `buildEventCards` (Task 2), `UpdateService.buildUpdateSlides` (Task 2), `resolveBuyerFromRequest`.
- Produces: `SavedContentService.savedEventIds(buyerId)`, `.listSavedUpdates(buyerId)`; `GET /api/social/me/saved` → `{ updates: Slide[], events: Card[] }`.

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/consumerSaved.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { EventReaction } from '@models/eventReaction.model';

const PHONE = '+26878422613';

describe('GET /api/social/me/saved', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns the buyer\'s saved updates and saved (liked) events', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    const author = await Buyer.create({ phone: '+26878000009', password: 'secret1', name: 'Author', username: 'author9' });
    const u = await Update.create({ authorType: 'buyer', authorId: author._id, kind: 'image', caption: 'saved post', media: { rawKey: 'k', status: 'ready', image: { url: 'https://cdn/i.jpg', width: 1, height: 1 } } });
    await UpdateReaction.create({ updateId: u._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });
    const e = await Event.create({ name: 'Saved Event', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    await EventReaction.create({ eventId: e._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const res = await request(app).get('/api/social/me/saved').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.updates.map((s: any) => s.caption)).toEqual(['saved post']);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Saved Event']);
  });

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/me/saved').expect(401);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (404/route missing)

Run: `npx jest src/routes/__tests__/consumerSaved.route.test.ts`

- [ ] **Step 3: Implement `savedContent.service.ts`**

```ts
// src/services/savedContent.service.ts
import { UpdateReaction } from '@models/updateReaction.model';
import { EventReaction } from '@models/eventReaction.model';
import { Update } from '@models/update.model';

export class SavedContentService {
  /** Event ids the buyer saved (= liked), newest-first. */
  static async savedEventIds(buyerId: string): Promise<string[]> {
    const rows = await EventReaction.find({ actorType: 'buyer', buyerId, type: 'like' }).sort({ createdAt: -1 }).select('eventId');
    return rows.map((r) => String(r.eventId));
  }
  /** Update ids the buyer saved, newest-first. */
  static async savedUpdateIds(buyerId: string): Promise<string[]> {
    const rows = await UpdateReaction.find({ actorType: 'buyer', buyerId, type: 'save' }).sort({ createdAt: -1 }).select('updateId');
    return rows.map((r) => String(r.updateId));
  }
  /** Visible saved updates (active + media ready) in saved order. */
  static async listSavedUpdates(buyerId: string): Promise<any[]> {
    const ids = await SavedContentService.savedUpdateIds(buyerId);
    if (ids.length === 0) return [];
    const docs = await Update.find({ _id: { $in: ids }, status: 'active', 'media.status': 'ready' });
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return ids.map((id) => byId.get(id)).filter(Boolean) as any[];
  }
}
```

- [ ] **Step 4: Implement the controller** `src/controllers/consumerReads.controller.ts`

```ts
// src/controllers/consumerReads.controller.ts
import { Request, Response } from 'express';
import { resolveBuyerFromRequest } from '@/utils/buyerRequest.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { SavedContentService } from '@services/savedContent.service';
import { UpdateService } from '@services/update.service';
import { buildEventCards } from '@services/eventCards.service';

export class ConsumerReadsController {
  /** GET /api/social/me/saved */
  static async mySaved(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const actor = { type: 'buyer' as const, id: String(buyer._id) };
      const [savedUpdateDocs, savedEventIds] = await Promise.all([
        SavedContentService.listSavedUpdates(actor.id),
        SavedContentService.savedEventIds(actor.id),
      ]);
      const [updates, events] = await Promise.all([
        UpdateService.buildUpdateSlides(savedUpdateDocs, actor),
        buildEventCards(savedEventIds, actor),
      ]);
      return ApiResponseUtil.success(res, { updates, events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load saved items');
    }
  }
}
```

- [ ] **Step 5: Register the route** in `src/routes/social.route.ts` (add ABOVE `/users/:username`)

```ts
import { ConsumerReadsController } from '@controllers/consumerReads.controller';
// ...
router.get('/me/saved', authenticateBuyer, ConsumerReadsController.mySaved);
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx jest src/routes/__tests__/consumerSaved.route.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/services/savedContent.service.ts src/controllers/consumerReads.controller.ts src/routes/social.route.ts src/routes/__tests__/consumerSaved.route.test.ts
git commit -m "feat(api): GET /social/me/saved (saved posts + saved events)"
```

---

### Task 4: `GET /api/social/me/going`

**Files:**
- Create: `src/services/going.service.ts`
- Create: `src/services/__tests__/going.service.test.ts`
- Modify: `src/controllers/consumerReads.controller.ts` (add `myGoing`)
- Modify: `src/routes/social.route.ts`
- Create: `src/routes/__tests__/consumerGoing.route.test.ts`

**Interfaces:**
- Consumes: `Ticket`/`TicketStatus`, `Community`/`Membership`, `buildEventCards`.
- Produces: `GoingService.goingEventIds(buyer) => Promise<string[]>` — union of events the buyer holds a CHECKED_IN or valid ticket for and events whose community they joined; `GET /api/social/me/going` → `{ events: Card[] }`.

- [ ] **Step 1: Write the failing service test**

```ts
// src/services/__tests__/going.service.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { GoingService } from '@services/going.service';

describe('GoingService.goingEventIds', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('includes events whose community the buyer joined', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    const e = await Event.create({ name: 'Joined', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });
    const community = await Community.create({ eventId: e._id, vendorId: e._id }); // vendorId placeholder for test
    await Membership.create({ buyerId: buyer._id, communityId: community._id, role: 'member' });
    const ids = await GoingService.goingEventIds(buyer as any);
    expect(ids).toContain(String(e._id));
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/services/__tests__/going.service.test.ts`

- [ ] **Step 3: Implement `going.service.ts`**

```ts
// src/services/going.service.ts
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import type { IBuyer } from '@interfaces/buyer.interface';

export class GoingService {
  /** Events the buyer is "going" to: any event whose community they joined,
   *  plus any event they hold a (valid or checked-in) ticket for. Newest event first. */
  static async goingEventIds(buyer: IBuyer): Promise<string[]> {
    const memberships = await Membership.find({ buyerId: buyer._id, bannedAt: { $exists: false } }).select('communityId');
    const communityIds = memberships.map((m) => m.communityId);
    const communities = communityIds.length ? await Community.find({ _id: { $in: communityIds } }).select('eventId') : [];
    const joinedEventIds = communities.map((c) => String(c.eventId));

    const ticketEventIds = (await Ticket.distinct('eventId', {
      customerPhone: buyer.phone,
      status: { $in: [TicketStatus.VALID, TicketStatus.CHECKED_IN] },
    })).map((id: any) => String(id));

    return [...new Set([...joinedEventIds, ...ticketEventIds])];
  }
}
```
(If `TicketStatus.VALID` isn't a member of the enum, use only `TicketStatus.CHECKED_IN` — check `src/interfaces/ticket.interface.ts` and keep whichever statuses represent a live ticket.)

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/services/__tests__/going.service.test.ts`

- [ ] **Step 5: Add controller `myGoing`** to `consumerReads.controller.ts`

```ts
import { GoingService } from '@services/going.service';
// ...
/** GET /api/social/me/going */
static async myGoing(req: Request, res: Response): Promise<any> {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const ids = await GoingService.goingEventIds(buyer);
    const events = await buildEventCards(ids, { type: 'buyer', id: String(buyer._id) });
    return ApiResponseUtil.success(res, { events });
  } catch (error: any) {
    return failWithHttpError(res, error, 'Failed to load your events');
  }
}
```

- [ ] **Step 6: Register route** in `social.route.ts` (above `/users/:username`)

```ts
router.get('/me/going', authenticateBuyer, ConsumerReadsController.myGoing);
```

- [ ] **Step 7: Write + run the route test**

```ts
// src/routes/__tests__/consumerGoing.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';

it('GET /api/social/me/going returns joined events', async () => {
  const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
  const e = await Event.create({ name: 'Joined', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });
  const c = await Community.create({ eventId: e._id, vendorId: e._id });
  await Membership.create({ buyerId: buyer._id, communityId: c._id, role: 'member' });
  const res = await request(app).get('/api/social/me/going').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
  expect(res.body.data.events.map((c: any) => c.name)).toContain('Joined');
});
```
Wrap with the standard `describe/beforeAll(connectTestDb)/afterEach(clearTestDb)/afterAll(disconnectTestDb)` lifecycle.
Run: `npx jest src/routes/__tests__/consumerGoing.route.test.ts` — expect PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/going.service.ts src/services/__tests__/going.service.test.ts src/controllers/consumerReads.controller.ts src/routes/social.route.ts src/routes/__tests__/consumerGoing.route.test.ts
git commit -m "feat(api): GET /social/me/going (going/attended events)"
```

---

### Task 5: `GET /api/social/me/calendar?year=` and `GET /api/social/me/following/events`

**Files:**
- Create: `src/services/calendar.service.ts`
- Modify: `src/controllers/consumerReads.controller.ts` (`myCalendar`, `myFollowingEvents`)
- Modify: `src/routes/social.route.ts`
- Create: `src/routes/__tests__/consumerCalendar.route.test.ts`

**Interfaces:**
- Consumes: `GoingService.goingEventIds`, `SavedContentService.savedEventIds`, `FollowService.followingIds`, `buildEventCards`, `Event`, `EventStatus`.
- Produces:
  - `GET /me/calendar?year=YYYY` → `{ monthCounts: Record<string, number>, events: Card[] }` (union of going + saved, whose `eventDate` is in `year`, grouped by short month name).
  - `GET /me/following/events` → `{ events: Card[] }` (upcoming published events by organizers the buyer follows).

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/consumerCalendar.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventReaction } from '@models/eventReaction.model';

describe('GET /api/social/me/calendar', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('groups the buyer\'s saved events into month counts for the year', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    const e = await Event.create({ name: 'Aug Event', venue: 'V', eventDate: new Date('2026-08-10'), startTime: new Date('2026-08-10'), endTime: new Date('2026-08-10'), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    await EventReaction.create({ eventId: e._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    const res = await request(app).get('/api/social/me/calendar?year=2026').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    expect(res.body.data.monthCounts.Aug).toBe(1);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Aug Event']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/routes/__tests__/consumerCalendar.route.test.ts`

- [ ] **Step 3: Implement `calendar.service.ts`**

```ts
// src/services/calendar.service.ts
import { Event } from '@models/event.model';
import { GoingService } from '@services/going.service';
import { SavedContentService } from '@services/savedContent.service';
import type { IBuyer } from '@interfaces/buyer.interface';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export class CalendarService {
  /** Union of going + saved events in `year`, grouped by short month name. */
  static async forYear(buyer: IBuyer, year: number): Promise<{ monthCounts: Record<string, number>; eventIds: string[] }> {
    const [going, saved] = await Promise.all([
      GoingService.goingEventIds(buyer),
      SavedContentService.savedEventIds(String(buyer._id)),
    ]);
    const ids = [...new Set([...going, ...saved])];
    if (ids.length === 0) return { monthCounts: {}, eventIds: [] };
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    const events = await Event.find({ _id: { $in: ids }, eventDate: { $gte: start, $lt: end } }).sort({ eventDate: 1 }).select('eventDate');
    const monthCounts: Record<string, number> = {};
    for (const e of events) {
      const m = MONTHS[new Date(e.eventDate).getUTCMonth()]!;
      monthCounts[m] = (monthCounts[m] ?? 0) + 1;
    }
    return { monthCounts, eventIds: events.map((e) => String(e._id)) };
  }
}
```

- [ ] **Step 4: Implement `following.service`-style query inline + controllers**

Add to `consumerReads.controller.ts`:
```ts
import { CalendarService } from '@services/calendar.service';
import { FollowService } from '@services/follow.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
// ...
/** GET /api/social/me/calendar?year= */
static async myCalendar(req: Request, res: Response): Promise<any> {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const year = Number(req.query['year']) || new Date().getUTCFullYear();
    const { monthCounts, eventIds } = await CalendarService.forYear(buyer, year);
    const events = await buildEventCards(eventIds, { type: 'buyer', id: String(buyer._id) });
    return ApiResponseUtil.success(res, { monthCounts, events });
  } catch (error: any) {
    return failWithHttpError(res, error, 'Failed to load your calendar');
  }
}

/** GET /api/social/me/following/events */
static async myFollowingEvents(req: Request, res: Response): Promise<any> {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const vendorIds = await FollowService.followingIds(String(buyer._id), 'organizer');
    let events: any[] = [];
    if (vendorIds.length) {
      const rows = await Event.find({ vendorId: { $in: vendorIds }, status: EventStatus.PUBLISHED, eventDate: { $gte: new Date() } }).sort({ eventDate: 1 }).select('_id');
      events = await buildEventCards(rows.map((e) => String(e._id)), { type: 'buyer', id: String(buyer._id) });
    }
    return ApiResponseUtil.success(res, { events });
  } catch (error: any) {
    return failWithHttpError(res, error, 'Failed to load followed events');
  }
}
```

- [ ] **Step 5: Register both routes** in `social.route.ts` (above `/users/:username`)

```ts
router.get('/me/calendar', authenticateBuyer, ConsumerReadsController.myCalendar);
router.get('/me/following/events', authenticateBuyer, ConsumerReadsController.myFollowingEvents);
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx jest src/routes/__tests__/consumerCalendar.route.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/services/calendar.service.ts src/controllers/consumerReads.controller.ts src/routes/social.route.ts src/routes/__tests__/consumerCalendar.route.test.ts
git commit -m "feat(api): GET /social/me/calendar + /me/following/events"
```

---

### Task 6: `GET /api/social/suggestions/people`

**Files:**
- Create: `src/services/suggestions.service.ts`
- Modify: `src/controllers/consumerReads.controller.ts` (`suggestedPeople`)
- Modify: `src/routes/social.route.ts`
- Create: `src/routes/__tests__/suggestionsPeople.route.test.ts`

**Interfaces:**
- Consumes: `Follow`, `Buyer`, `FollowService.followingIds`.
- Produces: `SuggestionsService.peopleYouMayKnow(buyerId, limit?) => Promise<Array<{ buyer:IBuyer; mutualCount:number }>>`; `GET /api/social/suggestions/people` → `[{ id, name, username, avatarUrl, bio, city:null, mutualCount, isFollowing:false }]`.

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/suggestionsPeople.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';

describe('GET /api/social/suggestions/people', () => {
  beforeAll(async () => { await connectTestDb(); await Follow.init(); });
  afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('surfaces friends-of-friends I do not already follow, ranked by mutual count', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
    const suggestion = await Buyer.create({ phone: '+26878000022', password: 'secret1', name: 'Suggested', username: 'sugg_b' });
    // me -> friend, friend -> suggestion
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friend._id });
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: suggestion._id });

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const usernames = res.body.data.map((p: any) => p.username);
    expect(usernames).toContain('sugg_b');
    expect(usernames).not.toContain('friend_a'); // already followed
    expect(usernames).not.toContain('me_one');   // never suggest self
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/routes/__tests__/suggestionsPeople.route.test.ts`

- [ ] **Step 3: Implement `suggestions.service.ts` (people)**

```ts
// src/services/suggestions.service.ts
import { Follow } from '@models/follow.model';
import { Buyer } from '@models/buyer.model';
import { FollowService } from '@services/follow.service';

export class SuggestionsService {
  /** Friends-of-friends the buyer doesn't already follow, ranked by shared
   *  connections. Falls back to recently-active handled buyers when the buyer
   *  follows no one yet (mutualCount 0). */
  static async peopleYouMayKnow(buyerId: string, limit = 20): Promise<Array<{ buyer: any; mutualCount: number }>> {
    const iFollow = await FollowService.followingIds(buyerId, 'buyer');
    const exclude = new Set<string>([buyerId, ...iFollow]);

    if (iFollow.length === 0) {
      const recent = await Buyer.find({ _id: { $nin: [...exclude] }, username: { $exists: true, $ne: null }, socialSuspendedAt: null })
        .sort({ lastLoginAt: -1 }).limit(limit);
      return recent.map((b) => ({ buyer: b, mutualCount: 0 }));
    }

    const secondDegree = await Follow.find({ followerType: 'buyer', followerId: { $in: iFollow }, targetType: 'buyer' }).select('targetId');
    const counts = new Map<string, number>();
    for (const r of secondDegree) {
      const id = String(r.targetId);
      if (!exclude.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const ids = ranked.map(([id]) => id);
    const buyers = await Buyer.find({ _id: { $in: ids }, socialSuspendedAt: null });
    const bMap = new Map(buyers.map((b) => [String(b._id), b]));
    return ranked.map(([id, mutualCount]) => ({ buyer: bMap.get(id), mutualCount })).filter((x) => x.buyer) as any[];
  }
}
```

- [ ] **Step 4: Add controller `suggestedPeople`**

```ts
import { SuggestionsService } from '@services/suggestions.service';
// ...
/** GET /api/social/suggestions/people */
static async suggestedPeople(req: Request, res: Response): Promise<any> {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const rows = await SuggestionsService.peopleYouMayKnow(String(buyer._id));
    const data = rows.map(({ buyer: b, mutualCount }) => ({
      id: String(b._id), name: b.name ?? null, username: b.username ?? null,
      avatarUrl: b.avatarUrl ?? null, bio: b.bio ?? null, city: null,
      mutualCount, isFollowing: false,
    }));
    return ApiResponseUtil.success(res, data);
  } catch (error: any) {
    return failWithHttpError(res, error, 'Failed to load suggestions');
  }
}
```

- [ ] **Step 5: Register route** in `social.route.ts` (above `/users/:username`)

```ts
router.get('/suggestions/people', authenticateBuyer, ConsumerReadsController.suggestedPeople);
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx jest src/routes/__tests__/suggestionsPeople.route.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/services/suggestions.service.ts src/controllers/consumerReads.controller.ts src/routes/social.route.ts src/routes/__tests__/suggestionsPeople.route.test.ts
git commit -m "feat(api): GET /social/suggestions/people"
```

---

### Task 7: `GET /api/social/suggestions/organizers`

**Files:**
- Modify: `src/services/suggestions.service.ts` (add `organizersToFollow`)
- Modify: `src/controllers/consumerReads.controller.ts` (`suggestedOrganizers`)
- Modify: `src/routes/social.route.ts`
- Create: `src/routes/__tests__/suggestionsOrganizers.route.test.ts`

**Interfaces:**
- Consumes: `Vendor`, `VerificationStatus` from `@interfaces/vendor.interface`, `Event`, `EventStatus`, `FollowService.followerCount`, `FollowService.followingIds`.
- Produces: `SuggestionsService.organizersToFollow(buyerId, limit?) => Promise<Array<{ vendor:any; eventCount:number; followerCount:number; isFollowing:boolean }>>`; `GET /api/social/suggestions/organizers` → `[{ id, businessName, logoUrl, location, eventCount, followerCount, isFollowing }]`.

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/suggestionsOrganizers.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { VerificationStatus } from '@interfaces/vendor.interface';

describe('GET /api/social/suggestions/organizers', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('lists active verified organizers with follower/event counts and isFollowing', async () => {
    await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    await Vendor.create({ businessName: 'MTN Bushfire', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    expect(res.body.data[0]).toMatchObject({ businessName: 'MTN Bushfire', followerCount: 0, eventCount: 0, isFollowing: false });
  });
});
```
(Confirm the enum member name: `VerificationStatus.VERIFIED` — check `src/interfaces/vendor.interface.ts`; adjust to the actual "approved/verified" member.)

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/routes/__tests__/suggestionsOrganizers.route.test.ts`

- [ ] **Step 3: Implement `organizersToFollow`**

```ts
// add to src/services/suggestions.service.ts
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { VerificationStatus } from '@interfaces/vendor.interface';
// ...
static async organizersToFollow(buyerId: string, limit = 20): Promise<Array<{ vendor: any; eventCount: number; followerCount: number; isFollowing: boolean }>> {
  const iFollow = new Set(await FollowService.followingIds(buyerId, 'organizer'));
  const vendors = await Vendor.find({ isActive: true, verificationStatus: VerificationStatus.VERIFIED }).limit(100).select('businessName logoUrl address');
  const enriched = await Promise.all(vendors.map(async (v) => ({
    vendor: v,
    followerCount: await FollowService.followerCount('organizer', String(v._id)),
    eventCount: await Event.countDocuments({ vendorId: v._id, status: EventStatus.PUBLISHED }),
    isFollowing: iFollow.has(String(v._id)),
  })));
  return enriched.sort((a, b) => b.followerCount - a.followerCount).slice(0, limit);
}
```

- [ ] **Step 4: Add controller `suggestedOrganizers`**

```ts
/** GET /api/social/suggestions/organizers */
static async suggestedOrganizers(req: Request, res: Response): Promise<any> {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const rows = await SuggestionsService.organizersToFollow(String(buyer._id));
    const data = rows.map(({ vendor: v, eventCount, followerCount, isFollowing }) => ({
      id: String(v._id), businessName: v.businessName, logoUrl: v.logoUrl ?? null,
      location: v.address?.city ?? null, eventCount, followerCount, isFollowing,
    }));
    return ApiResponseUtil.success(res, data);
  } catch (error: any) {
    return failWithHttpError(res, error, 'Failed to load organizer suggestions');
  }
}
```

- [ ] **Step 5: Register route** in `social.route.ts` (above `/users/:username`)

```ts
router.get('/suggestions/organizers', authenticateBuyer, ConsumerReadsController.suggestedOrganizers);
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx jest src/routes/__tests__/suggestionsOrganizers.route.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/services/suggestions.service.ts src/controllers/consumerReads.controller.ts src/routes/social.route.ts src/routes/__tests__/suggestionsOrganizers.route.test.ts
git commit -m "feat(api): GET /social/suggestions/organizers"
```

---

### Task 8: `GET /api/social/recommendations`

**Files:**
- Create: `src/services/recommendations.service.ts`
- Modify: `src/controllers/consumerReads.controller.ts` (`recommendations`)
- Modify: `src/routes/social.route.ts`
- Create: `src/routes/__tests__/recommendations.route.test.ts`

**Interfaces:**
- Consumes: `SavedContentService.savedEventIds`, `Event`, `EventStatus`, `buildEventCards`.
- Produces: `RecommendationsService.forBuyer(buyerId) => Promise<{ basisEvent: {id,name}|null; eventIds: string[] }>`; `GET /api/social/recommendations` → `{ basisEvent, events: Card[] }`. **v1 = same-organizer + soonest-upcoming, excluding already-saved. Category-aware after Phase 2.**

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/recommendations.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventReaction } from '@models/eventReaction.model';
import { EventStatus } from '@interfaces/event.interface';

describe('GET /api/social/recommendations', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('recommends other upcoming events by the organizer of a saved event', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    const v = await Vendor.create({ businessName: 'MTN Bushfire' });
    const saved = await Event.create({ vendorId: v._id, name: 'Saved', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const rec = await Event.create({ vendorId: v._id, name: 'Recommended', venue: 'V', eventDate: new Date(Date.now() + 1.7e8), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    await EventReaction.create({ eventId: saved._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const res = await request(app).get('/api/social/recommendations').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    expect(res.body.data.basisEvent.name).toBe('Saved');
    const names = res.body.data.events.map((c: any) => c.name);
    expect(names).toContain('Recommended');
    expect(names).not.toContain('Saved'); // never recommend the basis itself
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/routes/__tests__/recommendations.route.test.ts`

- [ ] **Step 3: Implement `recommendations.service.ts`**

```ts
// src/services/recommendations.service.ts
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { SavedContentService } from '@services/savedContent.service';

const TARGET = 8;

export class RecommendationsService {
  /** v1: basis = most-recently-saved event; recommend that organizer's other
   *  upcoming events first, then top up with soonest-upcoming, excluding saved.
   *  (Phase 2 adds same-category matching.) */
  static async forBuyer(buyerId: string): Promise<{ basisEvent: { id: string; name: string } | null; eventIds: string[] }> {
    const savedIds = await SavedContentService.savedEventIds(buyerId);
    const exclude = new Set(savedIds);
    const now = new Date();
    const base = { status: EventStatus.PUBLISHED, eventDate: { $gte: now } };

    let basisEvent: { id: string; name: string } | null = null;
    const picked: string[] = [];

    if (savedIds.length) {
      const basis = await Event.findById(savedIds[0]).select('name vendorId');
      if (basis) {
        basisEvent = { id: String(basis._id), name: basis.name };
        const sameOrg = await Event.find({ ...base, vendorId: basis.vendorId, _id: { $nin: [...exclude] } }).sort({ eventDate: 1 }).limit(TARGET).select('_id');
        for (const e of sameOrg) { picked.push(String(e._id)); exclude.add(String(e._id)); }
      }
    }
    if (picked.length < TARGET) {
      const more = await Event.find({ ...base, _id: { $nin: [...exclude] } }).sort({ eventDate: 1 }).limit(TARGET - picked.length).select('_id');
      for (const e of more) picked.push(String(e._id));
    }
    return { basisEvent, eventIds: picked };
  }
}
```

- [ ] **Step 4: Add controller `recommendations`**

```ts
import { RecommendationsService } from '@services/recommendations.service';
// ...
/** GET /api/social/recommendations */
static async recommendations(req: Request, res: Response): Promise<any> {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const { basisEvent, eventIds } = await RecommendationsService.forBuyer(String(buyer._id));
    const events = await buildEventCards(eventIds, { type: 'buyer', id: String(buyer._id) });
    return ApiResponseUtil.success(res, { basisEvent, events });
  } catch (error: any) {
    return failWithHttpError(res, error, 'Failed to load recommendations');
  }
}
```

- [ ] **Step 5: Register route** in `social.route.ts` (above `/users/:username`)

```ts
router.get('/recommendations', authenticateBuyer, ConsumerReadsController.recommendations);
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx jest src/routes/__tests__/recommendations.route.test.ts`

- [ ] **Step 7: Full-suite regression + commit**

```bash
npm test
git add src/services/recommendations.service.ts src/controllers/consumerReads.controller.ts src/routes/social.route.ts src/routes/__tests__/recommendations.route.test.ts
git commit -m "feat(api): GET /social/recommendations (because you saved X)"
```

---

## Frontend wiring (landing/ repo — separate, one-liner per page, NOT in this repo)

Once the endpoints are live, in `landing/`: point `SuggestedPage`, `CalendarPage`, `Sidebar` follow-lists, `BuyerProfilePage` (Saved/Going tabs), and `AppHomePage` (Following → `/me/following/events`, Favorites → `/me/saved` events) at the new endpoints and **delete the `demoData` imports**. Add `socialApi` methods: `getSaved()`, `getGoing()`, `getCalendar(year)`, `getFollowingEvents()`, `getSuggestedPeople()`, `getSuggestedOrganizers()`, `getRecommendations()`. Tracked in a follow-up landing task, not here.

## Self-Review (completed)

- **Spec coverage:** roadmap Phase-1 items 1a–1g all mapped — 1a→T3, 1b→T4, 1c→T5, 1d→T5(following)+T3(favorites), 1e→T6, 1f→T7, 1g→T8. Serializer extraction (T1–T2) supports all.
- **Placeholder scan:** none — every step has real code/tests/commands. The two "confirm the enum member" notes (TicketStatus, VerificationStatus) are verification instructions with a concrete fallback, not placeholders.
- **Type consistency:** `buildEventCards(ids, actor|null)`, `UpdateService.buildUpdateSlides(updates, actor|null)`, `toPublicEventCard(event, extras)`, `SavedContentService.savedEventIds/savedUpdateIds/listSavedUpdates`, `GoingService.goingEventIds(buyer)`, `CalendarService.forYear(buyer, year)`, `SuggestionsService.peopleYouMayKnow/organizersToFollow`, `RecommendationsService.forBuyer(buyerId)` — used consistently across tasks.
- **Deferred to execution:** verify `TicketStatus` live-ticket members and `VerificationStatus.VERIFIED` member name against the interface files (both flagged inline).
