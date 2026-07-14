# SP1a — Vendor Social-Actor Foundation (Reactions + Feed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the reusable **social actor** abstraction (buyer *or* vendor) and prove it end-to-end on the reactions vertical, so an organizer can like/save Discover posts *as their brand* and see their own reactions reflected in the feed — shipping "dark" (no UI depends on it yet).

**Architecture:** Add a single `SocialActor = { type: 'buyer' | 'vendor'; id }` identity resolved from the request token (`resolveActorFromRequest`). Generalize the reactions data path (`UpdateReaction` model, `toggleReaction`, `getViewerReactions`) to key on the actor instead of a hardcoded buyer. Mount vendor reaction endpoints alongside the existing vendor update routes, and teach the Discover feed to personalize for a vendor viewer. The existing buyer path is preserved byte-for-byte by having it pass `{ type: 'buyer', id }` through the same generalized functions.

**Tech Stack:** Node/TypeScript, Express, Mongoose 7 (MongoDB), Jest + supertest + mongodb-memory-server. Path aliases: `@models/*`, `@services/*`, `@controllers/*`, `@utils/*`, `@middleware/*`.

## Global Constraints

- **Umbrella spec:** `docs/superpowers/specs/2026-07-13-organizer-social-shell-design.md` (this is SP1a; SP1b = follow/block/me/notifications/push/search; SP2 = DMs + realtime).
- **Model changes must be additive & migration-safe.** Existing prod reaction rows must keep working with no data migration: new discriminator fields default to `'buyer'`. Do NOT rename `buyerId` → `actorId` in this plan (that needs a prod data migration; deferred).
- **Fail loud, no fake data.** Every failure surfaces through the normal error channel (`ApiResponseUtil.*`). Never substitute canned/default data for a failed call. (CLAUDE.md global rule.)
- **The actor = the brand.** For vendor/sub-user tokens the actor id is `req.ticketsUser.vendorId` (both `userType: 'vendor'` and `userType: 'sub-user'` carry it). Buyer tokens carry `userPhone` and resolve to the `Buyer` document id.
- **Auth middleware reuse:** vendor routes use `authenticateTickets` (validates an `app: 'tickets'` JWT; does NOT itself reject buyer tokens — the missing `vendorId` is what 401s a buyer, see existing `createAsVendor`). Buyer routes keep `authenticateBuyer`.
- **serviceAuth invariant:** never special-case `permissions: ['all']`; not touched here.
- **Test DB lifecycle:** `beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb)` from `../../__tests__/helpers/mongo`. Token helpers `signVendorToken(vendorId)` / `signBuyerToken(phone)` from `../../__tests__/helpers/auth`.
- **Commit after every task.** Run the full suite (`npm test`) before the final commit.

## File Structure

- **Create** `src/utils/socialActor.util.ts` — `SocialActor` type + `resolveActorFromRequest(req)`. One responsibility: turn a verified token into a `{ type, id }` actor.
- **Modify** `src/models/updateReaction.model.ts` — add `actorType` discriminator (default `'buyer'`), generalize the unique index.
- **Modify** `src/services/update.service.ts` — `toggleReaction` and `getViewerReactions` take a `SocialActor`.
- **Modify** `src/controllers/update.controller.ts` — add `reactAsVendor`, make `getOne` reaction-aware for a vendor viewer via the actor.
- **Modify** `src/routes/vendorUpdate.route.ts` — mount `POST /:id/like` and `POST /:id/save`.
- **Modify** `src/services/feed.service.ts` — `getFeed` accepts a `SocialActor` for the following-tab follow set.
- **Modify** `src/controllers/feed.controller.ts` — resolve the actor; attach viewer reactions for a vendor viewer too.
- **Tests** live next to their route/service under `src/**/__tests__/`.

---

### Task 1: `SocialActor` abstraction + `resolveActorFromRequest`

**Files:**
- Create: `src/utils/socialActor.util.ts`
- Test: `src/utils/__tests__/socialActor.util.test.ts`

**Interfaces:**
- Produces: `type SocialActorType = 'buyer' | 'vendor'`; `interface SocialActor { type: SocialActorType; id: string }`; `async function resolveActorFromRequest(req: Request): Promise<SocialActor | null>`.
- Consumes: existing `resolveBuyerFromRequest(req)` from `@utils/buyerRequest.util`.

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/__tests__/socialActor.util.test.ts
import mongoose from 'mongoose';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';

const reqWith = (ticketsUser: any) => ({ ticketsUser } as any);

describe('resolveActorFromRequest', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns a vendor actor from a vendor token (vendorId)', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const actor = await resolveActorFromRequest(reqWith({ app: 'tickets', userType: 'vendor', vendorId }));
    expect(actor).toEqual({ type: 'vendor', id: vendorId });
  });

  it('returns a vendor actor for a sub-user token (also carries vendorId)', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const actor = await resolveActorFromRequest(reqWith({ app: 'tickets', userType: 'sub-user', vendorId }));
    expect(actor).toEqual({ type: 'vendor', id: vendorId });
  });

  it('returns a buyer actor resolved from the token phone', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', name: 'Test' });
    const actor = await resolveActorFromRequest(reqWith({ app: 'tickets', userType: 'buyer', userPhone: '+26878422613' }));
    expect(actor).toEqual({ type: 'buyer', id: String(buyer._id) });
  });

  it('returns null for a buyer token with no matching Buyer document', async () => {
    const actor = await resolveActorFromRequest(reqWith({ app: 'tickets', userType: 'buyer', userPhone: '+26800000000' }));
    expect(actor).toBeNull();
  });

  it('returns null when there is no token', async () => {
    expect(await resolveActorFromRequest(reqWith(undefined))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- socialActor.util.test`
Expected: FAIL — `Cannot find module '@utils/socialActor.util'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/utils/socialActor.util.ts
import { Request } from 'express';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';

export type SocialActorType = 'buyer' | 'vendor';

/** The identity acting on the social graph — a ticket-buyer or an organizer brand (Vendor). */
export interface SocialActor {
  type: SocialActorType;
  id: string;
}

/**
 * Resolve the acting social identity from a verified tickets token.
 * Vendor and sub-user tokens both carry `vendorId` — the brand is the actor.
 * Buyer tokens carry `userPhone`, resolved to the Buyer document id.
 * Returns null when unauthenticated or when a buyer token has no Buyer row yet.
 */
export async function resolveActorFromRequest(req: Request): Promise<SocialActor | null> {
  const user = (req as any).ticketsUser;
  if (!user) return null;
  if (user.vendorId) return { type: 'vendor', id: String(user.vendorId) };
  if (user.userType === 'buyer' && user.userPhone) {
    const buyer = await resolveBuyerFromRequest(req);
    if (buyer) return { type: 'buyer', id: String(buyer._id) };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- socialActor.util.test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/socialActor.util.ts src/utils/__tests__/socialActor.util.test.ts
git commit -m "feat(social): add SocialActor abstraction + resolveActorFromRequest"
```

---

### Task 2: Generalize `UpdateReaction` to store the actor type

**Files:**
- Modify: `src/models/updateReaction.model.ts`
- Modify (test): `src/models/__tests__/updateReaction.model.test.ts` — **this file already exists** with a test `'enforces one reaction per (update, buyer, type)'`. Keep that test (it stays green: default `actorType='buyer'` means same-actor dups still collide) and ADD the two new cases below to the same `describe` block.

**Interfaces:**
- Produces: `IUpdateReaction` now has `actorType: 'buyer' | 'vendor'` (default `'buyer'`). `buyerId` continues to hold the actor's ObjectId (a buyer id or a vendor id). Unique key is `{ updateId, actorType, buyerId, type }`.

- [ ] **Step 1: Add the failing tests to the EXISTING describe block**

Append these two `it(...)` cases inside the existing `describe('UpdateReaction model', ...)` in `src/models/__tests__/updateReaction.model.test.ts`. Note `await UpdateReaction.init()` — mongodb-memory-server does not build indexes until the model is initialised, so the unique-index assertions are meaningless without it (the existing test already does this).

```ts
  it('allows a buyer and a vendor with the SAME id to react to the same update once each', async () => {
    await UpdateReaction.init();
    const updateId = new mongoose.Types.ObjectId();
    const sharedId = new mongoose.Types.ObjectId(); // astronomically unlikely IRL, but the unique key must permit it
    await UpdateReaction.create({ updateId, buyerId: sharedId, actorType: 'buyer', type: 'like' });
    await UpdateReaction.create({ updateId, buyerId: sharedId, actorType: 'vendor', type: 'like' });
    expect(await UpdateReaction.countDocuments({ updateId })).toBe(2);
  });

  it('rejects a duplicate reaction from the same actor', async () => {
    await UpdateReaction.init();
    const updateId = new mongoose.Types.ObjectId();
    const buyerId = new mongoose.Types.ObjectId();
    await UpdateReaction.create({ updateId, buyerId, actorType: 'vendor', type: 'like' });
    await expect(
      UpdateReaction.create({ updateId, buyerId, actorType: 'vendor', type: 'like' })
    ).rejects.toMatchObject({ code: 11000 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- updateReaction.model.test`
Expected: FAIL — the "buyer and a vendor with the SAME id" test creates only 1 doc (old unique index `{updateId, buyerId, type}` ignores `actorType`) so the second `create` throws 11000, or `actorType` is stripped as unknown.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/models/updateReaction.model.ts
import mongoose, { Schema, Document, Types } from 'mongoose';

export type ReactionActorType = 'buyer' | 'vendor';

export interface IUpdateReaction extends Document {
  updateId: Types.ObjectId;
  /** The reacting actor's id. Holds a Buyer _id when actorType='buyer', a Vendor _id when 'vendor'. */
  buyerId: Types.ObjectId;
  actorType: ReactionActorType;
  type: 'like' | 'save';
  createdAt: Date;
}

const schema = new Schema<IUpdateReaction>({
  updateId: { type: Schema.Types.ObjectId, ref: 'Update', required: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
  actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
  type: { type: String, enum: ['like', 'save'], required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One reaction of each type per (update, actor). actorType disambiguates the
// (theoretical) case of a Buyer and Vendor sharing an ObjectId value.
schema.index({ updateId: 1, actorType: 1, buyerId: 1, type: 1 }, { unique: true });
schema.index({ actorType: 1, buyerId: 1, type: 1, createdAt: -1 }); // "my saved updates"

export const UpdateReaction = mongoose.model<IUpdateReaction>('UpdateReaction', schema);
```

> **Prod deploy note (not a code step):** the old unique index `updateId_1_buyerId_1_type_1` remains on the prod collection until dropped. It is harmless (distinct actor ids never collide in practice), but for hygiene drop it after deploy: `db.updatereactions.dropIndex('updateId_1_buyerId_1_type_1')`. Fresh test DBs build only the new indexes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- updateReaction.model.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/models/updateReaction.model.ts src/models/__tests__/updateReaction.model.test.ts
git commit -m "feat(social): add actorType discriminator to UpdateReaction (migration-safe)"
```

---

### Task 3: Make `toggleReaction` / `getViewerReactions` actor-aware

**Files:**
- Modify: `src/services/update.service.ts`
- Modify (test): `src/services/__tests__/update.reactions.test.ts` — **this file already exists** and calls the OLD string-`buyerId` signature (e.g. `toggleReaction(u.id, buyerId, 'like')`, `getViewerReactions([u.id], buyerId)`). It MUST be updated to the actor signature or it fails to compile/pass after this task. Do NOT create a second reactions test file (DRY).

**Interfaces:**
- Consumes: `SocialActor` from `@utils/socialActor.util`.
- Produces:
  - `toggleReaction(updateId: string, actor: SocialActor, type: 'like' | 'save'): Promise<{ active: boolean; likeCount: number; saveCount: number }>`
  - `getViewerReactions(updateIds: string[], actor: SocialActor): Promise<Record<string, { liked: boolean; saved: boolean }>>`

- [ ] **Step 1: Update the EXISTING tests to the actor signature, then add vendor cases**

In `src/services/__tests__/update.reactions.test.ts`:
- add the import: `import type { SocialActor } from '@utils/socialActor.util';`
- in the existing `'toggles a like on then off…'` test, change both calls to pass an actor: `toggleReaction(u.id, { type: 'buyer', id: buyerId }, 'like')`.
- in the existing `'reports viewer reactions across updates'` test, change `toggleReaction(u.id, buyerId, 'save')` → `toggleReaction(u.id, { type: 'buyer', id: buyerId }, 'save')` and `getViewerReactions([u.id], buyerId)` → `getViewerReactions([u.id], { type: 'buyer', id: buyerId })`.
- leave `recordShare` / `recordView` tests untouched.

Then ADD these two vendor cases to the same `describe('update reactions', ...)` block:

```ts
  it('a vendor like toggles independently of a buyer like on the same update', async () => {
    const u = await seedUpdate();
    const vendor: SocialActor = { type: 'vendor', id: new mongoose.Types.ObjectId().toString() };
    const buyer: SocialActor = { type: 'buyer', id: new mongoose.Types.ObjectId().toString() };

    const first = await toggleReaction(u.id, vendor, 'like');
    expect(first).toMatchObject({ active: true, likeCount: 1 });

    const second = await toggleReaction(u.id, buyer, 'like');
    expect(second.likeCount).toBe(2);

    const off = await toggleReaction(u.id, vendor, 'like');
    expect(off).toMatchObject({ active: false, likeCount: 1 });
  });

  it('getViewerReactions returns the vendor viewer own flags only', async () => {
    const u = await seedUpdate();
    const vendor: SocialActor = { type: 'vendor', id: new mongoose.Types.ObjectId().toString() };
    const otherBuyer: SocialActor = { type: 'buyer', id: new mongoose.Types.ObjectId().toString() };
    await toggleReaction(u.id, otherBuyer, 'like');   // someone else liked
    await toggleReaction(u.id, vendor, 'save');       // this vendor saved

    const rx = await getViewerReactions([u.id], vendor);
    expect(rx[u.id]).toEqual({ liked: false, saved: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- update.reactions.test`
Expected: FAIL — the updated existing calls (and the new vendor cases) pass a `SocialActor`, but `toggleReaction`/`getViewerReactions` still take a `buyerId: string`, so the compile/behaviour is wrong.

- [ ] **Step 3: Write minimal implementation**

Replace the `toggleReaction` and `getViewerReactions` functions in `src/services/update.service.ts` with these (add the import at the top):

```ts
import type { SocialActor } from '@utils/socialActor.util';
```

```ts
export async function toggleReaction(updateId: string, actor: SocialActor, type: 'like' | 'save') {
  const key = { updateId, actorType: actor.type, buyerId: actor.id, type };
  const existing = await UpdateReaction.findOne(key);
  let active: boolean;
  if (existing) {
    await existing.deleteOne();
    await Update.updateOne({ _id: updateId }, { $inc: { [counterField(type)]: -1 } });
    active = false;
  } else {
    await UpdateReaction.create(key);
    await Update.updateOne({ _id: updateId }, { $inc: { [counterField(type)]: 1 } });
    active = true;
  }
  const u = await Update.findById(updateId).select('likeCount saveCount').lean();
  return { active, likeCount: u?.likeCount ?? 0, saveCount: u?.saveCount ?? 0 };
}

export async function getViewerReactions(updateIds: string[], actor: SocialActor): Promise<Record<string, { liked: boolean; saved: boolean }>> {
  const rows = await UpdateReaction.find({ updateId: { $in: updateIds }, actorType: actor.type, buyerId: actor.id }).lean();
  const map: Record<string, { liked: boolean; saved: boolean }> = {};
  for (const id of updateIds) map[String(id)] = { liked: false, saved: false };
  for (const r of rows) {
    const k = String(r.updateId);
    if (!map[k]) map[k] = { liked: false, saved: false };
    if (r.type === 'like') map[k].liked = true;
    if (r.type === 'save') map[k].saved = true;
  }
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- update.reactions.test`
Expected: PASS (existing buyer cases on the new signature + 2 new vendor cases). Note: `update.controller.ts` still calls the old signature until Task 4, and `feed.controller.ts` until Task 5 — a full `tsc`/whole-suite run will show type errors there; this targeted suite passes.

- [ ] **Step 5: Commit**

```bash
git add src/services/update.service.ts src/services/__tests__/update.reactions.test.ts
git commit -m "feat(social): make reactions actor-aware (toggleReaction/getViewerReactions take SocialActor)"
```

---

### Task 4: Vendor reaction endpoints + buyer/vendor caller updates

**Files:**
- Modify: `src/controllers/update.controller.ts`
- Modify: `src/routes/vendorUpdate.route.ts`
- Test: `src/routes/__tests__/vendorUpdateReactions.route.test.ts`

**Interfaces:**
- Consumes: `resolveActorFromRequest` (`@utils/socialActor.util`), `toggleReaction`/`getViewerReactions` (Task 3).
- Produces: `UpdateController.reactAsVendor(type)` → Express handler; routes `POST /api/tickets/updates/:id/like` and `POST /api/tickets/updates/:id/save`.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorUpdateReactions.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';

const seedReadyUpdate = () => Update.create({
  authorType: 'vendor', authorId: new mongoose.Types.ObjectId(),
  kind: 'image', caption: 'x', media: { rawKey: 'k', status: 'ready' }, status: 'active',
});

describe('POST /api/tickets/updates/:id/like|save (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets a vendor like and un-like an update', async () => {
    const u = await seedReadyUpdate();
    const token = signVendorToken(new mongoose.Types.ObjectId().toString());
    const on = await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(on.body.data).toMatchObject({ active: true, likeCount: 1 });
    const off = await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(off.body.data).toMatchObject({ active: false, likeCount: 0 });
  });

  it('lets a vendor save an update', async () => {
    const u = await seedReadyUpdate();
    const token = signVendorToken(new mongoose.Types.ObjectId().toString());
    const res = await request(app).post(`/api/tickets/updates/${u.id}/save`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.data).toMatchObject({ active: true, saveCount: 1 });
  });

  it('404s a removed update', async () => {
    const u = await seedReadyUpdate();
    u.status = 'removed'; await u.save();
    await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', `Bearer ${signVendorToken(new mongoose.Types.ObjectId().toString())}`).expect(404);
  });

  it('401s a buyer token (no vendorId → not a vendor actor on this route)', async () => {
    const u = await seedReadyUpdate();
    await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- vendorUpdateReactions.route.test`
Expected: FAIL — routes return 404 (not mounted).

- [ ] **Step 3: Write minimal implementation**

In `src/controllers/update.controller.ts`, update the import line and the buyer `react`/`getOne` callers to pass an actor, and add `reactAsVendor`.

Replace the import of `resolveBuyerFromRequest` region to also import the actor helper (top of file):

```ts
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
```

Replace the existing `react` and `getOne` reaction lines and add `reactAsVendor`:

```ts
  static async getOne(req: Request, res: Response): Promise<any> {
    const update = await getUpdate(req.params['id'] as string);
    if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
    let reactions: { liked: boolean; saved: boolean } | undefined;
    const actor = await resolveActorFromRequest(req).catch(() => null);
    if (actor) reactions = (await getViewerReactions([update.id], actor))[update.id];
    return ApiResponseUtil.success(res, UpdateController.dto(update, reactions));
  }

  static react(type: 'like' | 'save') {
    return async (req: Request, res: Response): Promise<any> => {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const update = await Update.findById(req.params['id'] as string).select('_id status');
      if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
      const r = await toggleReaction(req.params['id'] as string, { type: 'buyer', id: String(buyer._id) }, type);
      return ApiResponseUtil.success(res, r);
    };
  }

  /** Vendor (organizer) reaction — the brand likes/saves a post. */
  static reactAsVendor(type: 'like' | 'save') {
    return async (req: Request, res: Response): Promise<any> => {
      const vendorId = (req as any).ticketsUser?.vendorId;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const update = await Update.findById(req.params['id'] as string).select('_id status');
      if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
      const r = await toggleReaction(req.params['id'] as string, { type: 'vendor', id: String(vendorId) }, type);
      return ApiResponseUtil.success(res, r);
    };
  }
```

In `src/routes/vendorUpdate.route.ts`, add the two reaction routes:

```ts
import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { UpdateController } from '@controllers/update.controller';

const router = Router();

router.post('/', authenticateTickets, UpdateController.createAsVendor);
router.post('/:id/finalize', authenticateTickets, UpdateController.finalizeAsVendor);
router.post('/:id/like', authenticateTickets, UpdateController.reactAsVendor('like'));
router.post('/:id/save', authenticateTickets, UpdateController.reactAsVendor('save'));

export default router;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- vendorUpdateReactions.route.test`
Expected: PASS (4 tests). Also re-run the existing buyer reactions suite: `npm test -- update.route.test` → still PASS (buyer path unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/update.controller.ts src/routes/vendorUpdate.route.ts src/routes/__tests__/vendorUpdateReactions.route.test.ts
git commit -m "feat(social): vendor like/save endpoints; route buyer & vendor reactions through SocialActor"
```

---

### Task 5: Feed personalization + viewer reactions for a vendor viewer

**Files:**
- Modify: `src/services/feed.service.ts`
- Modify: `src/controllers/feed.controller.ts`
- Modify (test): `src/services/__tests__/feed.service.test.ts` — **existing**; two `getFeed({ tab: 'following', buyerId: String(buyer._id), … })` calls (currently ~lines 105 & 110) must change to `actor: { type: 'buyer', id: String(buyer._id) }` when the option is renamed.
- Test: `src/routes/__tests__/feedVendorViewer.route.test.ts` (new)

**Interfaces:**
- Consumes: `SocialActor`, `resolveActorFromRequest`, `getViewerReactions`.
- Produces: `getFeed(opts)` where `opts` gains `actor?: SocialActor` (replaces the internal use of `buyerId` for the following-tab follow set); `FeedController.get` attaches `viewerReactions` for buyer *and* vendor viewers.

> Note: the follow *set* still queries `Follow.find({ followerId: actor.id })` — SP1b generalizes `Follow` with a `followerType`. For SP1a the vendor's following-tab simply resolves against `followerId = vendorId`, which is correct once SP1b lands and harmless (empty) before then. The viewer-reactions personalization is the shipped behavior here.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/feedVendorViewer.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';
import { toggleReaction } from '@services/update.service';

describe('GET /api/public/feed — vendor viewer reactions', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('marks viewerReactions.liked=true for an update the viewing vendor liked', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const u = await Update.create({
      authorType: 'vendor', authorId: new mongoose.Types.ObjectId(),
      kind: 'image', caption: 'x', media: { rawKey: 'k', status: 'ready' }, status: 'active',
    });
    await toggleReaction(u.id, { type: 'vendor', id: vendorId }, 'like');

    const res = await request(app)
      .get('/api/public/feed?tab=for-you')
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(200);

    const slide = res.body.data.items.find((i: any) => i.type === 'update' && i.id === u.id);
    expect(slide).toBeTruthy();
    expect(slide.viewerReactions).toEqual({ liked: true, saved: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- feedVendorViewer.route.test`
Expected: FAIL — `viewerReactions` is `undefined`/absent for a vendor viewer (controller only resolves a buyer today).

- [ ] **Step 3: Write minimal implementation**

In `src/services/feed.service.ts`, change the `FeedOpts` interface and the follow-set resolution to use an actor:

```ts
import type { SocialActor } from '@utils/socialActor.util';
```

```ts
interface FeedOpts { tab: 'for-you' | 'following' | 'events'; cursor?: string; actor?: SocialActor; limit?: number; }
```

Replace the follow-set block near the top of `getFeed`:

```ts
  // resolve follow sets for personalization/following
  let followedAuthorIds: any[] = [];
  let followedOrgIds: any[] = [];
  if (opts.actor && opts.tab === 'following') {
    const follows = await Follow.find({ followerId: opts.actor.id }).lean();
    followedAuthorIds = follows.filter((f) => f.targetType === 'buyer').map((f) => f.targetId);
    followedOrgIds = follows.filter((f) => f.targetType === 'organizer').map((f) => f.targetId);
  }
```

Then update the existing `src/services/__tests__/feed.service.test.ts` — the two `getFeed({ tab: 'following', buyerId: String(buyer._id), limit: 8 })` calls become:

```ts
    const before = await getFeed({ tab: 'following', actor: { type: 'buyer', id: String(buyer._id) }, limit: 8 });
    // ...
    const after = await getFeed({ tab: 'following', actor: { type: 'buyer', id: String(buyer._id) }, limit: 8 });
```

In `src/controllers/feed.controller.ts`, resolve the actor and attach reactions for any actor:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { getFeed, FeedSlide } from '@services/feed.service';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { getViewerReactions } from '@services/update.service';

const TABS = ['for-you', 'following', 'events'] as const;
type Tab = (typeof TABS)[number];

function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value);
}

export class FeedController {
  static async get(req: Request, res: Response): Promise<any> {
    const tab = String(req.query['tab'] || 'for-you');
    if (!isTab(tab)) return ApiResponseUtil.validationError(res, 'Invalid tab');
    const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
    const actor = await resolveActorFromRequest(req).catch(() => null);
    try {
      const { items, nextCursor } = await getFeed({ tab, cursor, actor: actor ?? undefined });
      if (actor) {
        const updateIds = items.filter((i) => i.type === 'update').map((i) => i.id);
        if (updateIds.length) {
          const rx = await getViewerReactions(updateIds, actor);
          for (const i of items as FeedSlide[]) {
            if (i.type === 'update') i['viewerReactions'] = rx[i.id] ?? null;
          }
        }
      }
      return ApiResponseUtil.success(res, { items, nextCursor });
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to load feed', 500);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- feedVendorViewer.route.test`
Expected: PASS (1 test). Re-run the existing feed suites to confirm buyer behavior is unchanged and the renamed option compiles: `npm test -- feed` → PASS (includes the updated `feed.service.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/services/feed.service.ts src/controllers/feed.controller.ts src/services/__tests__/feed.service.test.ts src/routes/__tests__/feedVendorViewer.route.test.ts
git commit -m "feat(social): personalize Discover feed viewer-reactions for a vendor viewer via SocialActor"
```

---

### Task 6: Full-suite green + integration sweep

**Files:**
- Test: `src/routes/__tests__/vendorReactions.integration.test.ts` (new, end-to-end sanity)

**Interfaces:**
- Consumes: everything above. No new production code — this task guards the whole vertical.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorReactions.integration.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';

describe('vendor reactions end-to-end via feed + getOne', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('like via API is visible in getOne and the feed for that vendor', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const token = `Bearer ${signVendorToken(vendorId)}`;
    const u = await Update.create({
      authorType: 'vendor', authorId: new mongoose.Types.ObjectId(),
      kind: 'image', caption: 'x', media: { rawKey: 'k', status: 'ready' }, status: 'active',
    });

    await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', token).expect(200);

    const one = await request(app).get(`/api/public/updates/${u.id}`).set('Authorization', token).expect(200);
    expect(one.body.data.viewerReactions).toEqual({ liked: true, saved: false });

    const feed = await request(app).get('/api/public/feed?tab=for-you').set('Authorization', token).expect(200);
    const slide = feed.body.data.items.find((i: any) => i.type === 'update' && i.id === u.id);
    expect(slide.viewerReactions.liked).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes if wiring is complete)**

Run: `npm test -- vendorReactions.integration.test`
Expected: PASS if Tasks 1–5 are correct. If it FAILS, fix the offending task before continuing (do not weaken the test).

- [ ] **Step 3: Run the FULL suite**

Run: `npm test`
Expected: PASS — no regressions in the buyer reactions/feed suites. If any pre-existing realtime teardown noise makes jest exit non-zero despite all suites green, confirm each suite's `✓`/`✗` individually (per the CI caveat in the social-backend memory) — never weaken a real assertion to chase the exit code.

- [ ] **Step 4: Commit**

```bash
git add src/routes/__tests__/vendorReactions.integration.test.ts
git commit -m "test(social): end-to-end vendor reactions across like/getOne/feed"
```

- [ ] **Step 5: Record deploy follow-up**

Add a one-line note to the api ledger (`api/.superpowers/sdd/progress.md` if present, else create it) capturing the prod index cleanup from Task 2 and that SP1a shipped dark:

```
SP1a (vendor social-actor reactions) merged. Post-deploy: drop legacy index
updatereactions 'updateId_1_buyerId_1_type_1'. No UI consumes vendor reactions
yet — landing SP3 wires the brand session.
```

```bash
git add api/.superpowers/sdd/progress.md
git commit -m "docs(social): record SP1a deploy follow-up (index cleanup)"
```

---

## Self-Review

**1. Spec coverage (SP1a slice of the umbrella spec §5):**
- Actor abstraction → Task 1. ✅
- Vendor reactions endpoints (`/api/tickets/updates/:id/like|save`) → Task 4. ✅
- Model/service generalization (reactions) → Tasks 2–3. ✅
- Feed viewer-flags compute for a vendor viewer → Task 5. ✅
- *Deferred to SP1b (documented, not gaps):* `/api/tickets/social/*` (follow/block/me/notifications/push/search). SP2: DMs + realtime vendor handshake. Called out in Global Constraints + Task 5 note.

**2. Placeholder scan:** No TBD/TODO; every code step contains complete code; every test step shows the assertion; the one prod index step is explicitly labeled a deploy note, not a code step. ✅

**3. Type consistency:** `SocialActor { type, id }` defined in Task 1 is used verbatim in Tasks 3 (`toggleReaction`/`getViewerReactions`), 4 (`reactAsVendor` passes `{ type:'vendor', id }`; buyer `react` passes `{ type:'buyer', id }`), and 5 (`FeedOpts.actor`). `UpdateReaction` fields `actorType`/`buyerId` (Task 2) are queried identically in Task 3. Route paths `/api/tickets/updates/:id/like|save` (Task 4) match the test URLs (Tasks 4 & 6). ✅

## Execution Handoff (fill in after review)

This plan is SP1a. On completion, the next plan is **SP1b — vendor social graph** (follow/block/me/notifications/push/search), then **SP2 — vendor DMs + realtime handshake**, then the frontend **SP3/SP4**.
