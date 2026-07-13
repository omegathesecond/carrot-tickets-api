# SP1b-a — Vendor Social Graph (Follow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `SocialActor` abstraction (from SP1a) to the follow graph, so an organizer can **follow / unfollow accounts as their brand** and see their brand's follower/following counts — with the Discover "following" tab personalizing correctly for a vendor viewer. Ships "dark" (no UI consumes it until SP3).

**Architecture:** Generalize the `Follow` edge with a `followerType` discriminator (default `'buyer'`, migration-safe) exactly as SP1a did for `UpdateReaction.actorType`. `FollowService` gains a private `createEdge(followerType, followerId, …)` core; the existing buyer `follow(buyer)` keeps its suspension check + mutual-friend notification, and a new `followAsVendor(vendorId, …)` reuses the core without those buyer-only concerns (friends are a buyer↔buyer concept). Mount vendor graph routes under `/api/tickets/social/*`.

**Tech Stack:** Node/TypeScript, Express, Mongoose 7 (MongoDB), Jest + supertest + mongodb-memory-server. Path aliases `@models/*`, `@services/*`, `@controllers/*`, `@utils/*`, `@middleware/*`, `@validators/*`.

## Global Constraints

- **Umbrella spec:** `docs/superpowers/specs/2026-07-13-organizer-social-shell-design.md`. This is **SP1b-a**; SP1b-b = follow/followers **lists** (mixed buyer+vendor summaries) + username/vendor **search** + **block**; SP1b-c = **notifications** inbox + **push** as vendor. SP2 = DMs + realtime.
- **Builds on SP1a (already merged to `main`):** `SocialActor = { type: 'buyer' | 'vendor'; id }` and `resolveActorFromRequest(req)` exist in `@utils/socialActor.util`. `FeedOpts.actor?: SocialActor` exists in `feed.service.ts`.
- **Model change must be additive & migration-safe:** `Follow.followerType` defaults to `'buyer'`; existing rows keep working with NO data migration. Do NOT rename `followerId`. A legacy unique index `followerId_1_targetType_1_targetId_1` remains on prod until manually dropped (documented deploy step).
- **Preserve the buyer path byte-for-byte:** the existing `follow(buyer)` behavior — `assertNotSuspended`, self-follow guard, mutual-friend `NotificationDispatcher` — must be unchanged. Buyer callers of `followingCount`/`followingIds` must not need edits (new `followerType` param defaults to `'buyer'`).
- **Vendor actor = the brand:** actor id = `req.ticketsUser.vendorId` (present on both `userType: 'vendor'` and `'sub-user'` tokens). Vendor routes use `authenticateTickets`.
- **Friends are buyer↔buyer only:** a vendor follow never triggers a friend notification and never counts toward `friendIds`.
- **Fail loud, no fake data.** YAGNI. TDD. Commit after every task. Run the full suite before the final commit.
- **Known-flaky suite:** `social.route.test.ts` (username-uniqueness race) can fail only under the parallel full-suite run; it passes in isolation and is unrelated. Do not chase it.

## File Structure

- **Modify** `src/models/follow.model.ts` — add `followerType` discriminator (default `'buyer'`), generalize the unique index.
- **Modify** `src/services/follow.service.ts` — `createEdge` core + `followAsVendor`/`unfollowAsVendor`; `followingCount`/`followingIds`/`unfollow` gain an optional `followerType` (default `'buyer'`).
- **Modify** `src/services/feed.service.ts` — the following-tab follow-set query filters by `followerType: opts.actor.type` (so a vendor viewer's following tab uses vendor edges).
- **Create** `src/controllers/vendorSocial.controller.ts` — `me` (brand social summary), `follow`, `unfollow` for a vendor actor.
- **Create** `src/routes/vendorSocial.route.ts` — mounts under `/api/tickets/social`.
- **Modify** `src/app.ts` — mount `vendorSocial.route` at `/api/tickets/social` BEFORE the broad `/api/tickets` mount.
- **Tests** live next to their route/service/model under `src/**/__tests__/`.

---

### Task 1: Generalize `Follow` with a `followerType` discriminator

**Files:**
- Modify: `src/models/follow.model.ts`
- Modify (test): `src/models/__tests__/follow.model.test.ts` — **check if it exists first**. If it exists, ADD the cases below to its `describe` block; if not, create it with the full file shown.

**Interfaces:**
- Produces: `FollowerType = 'buyer' | 'vendor'`; `IFollow.followerType: FollowerType` (default `'buyer'`). `followerId` continues to hold the follower's id (buyer OR vendor). Unique key: `{ followerType, followerId, targetType, targetId }`.

- [ ] **Step 1: Write the failing test**

If `src/models/__tests__/follow.model.test.ts` does not exist, create it:

```ts
// src/models/__tests__/follow.model.test.ts
import mongoose from 'mongoose';
import { Follow } from '@models/follow.model';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

describe('Follow model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('defaults followerType to "buyer" (back-compat)', async () => {
    const f = await Follow.create({
      followerId: new mongoose.Types.ObjectId(),
      targetType: 'organizer',
      targetId: new mongoose.Types.ObjectId(),
    });
    expect(f.followerType).toBe('buyer');
  });

  it('allows a buyer and a vendor with the SAME id to follow the same target once each', async () => {
    await Follow.init();
    const followerId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'buyer', followerId, targetType: 'organizer', targetId });
    await Follow.create({ followerType: 'vendor', followerId, targetType: 'organizer', targetId });
    expect(await Follow.countDocuments({ targetId })).toBe(2);
  });

  it('rejects a duplicate follow from the same follower', async () => {
    await Follow.init();
    const followerId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'vendor', followerId, targetType: 'organizer', targetId });
    await expect(
      Follow.create({ followerType: 'vendor', followerId, targetType: 'organizer', targetId })
    ).rejects.toMatchObject({ code: 11000 });
  });
});
```

If the file already exists, add the second and third `it(...)` cases above (the ones calling `Follow.init()`) into its existing `describe` block, keeping any existing cases.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- follow.model.test`
Expected: FAIL — the "buyer and a vendor with the SAME id" case creates only 1 usable row (old unique index `{followerId, targetType, targetId}` ignores `followerType`, so the second create throws 11000).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/models/follow.model.ts
import { Schema, model, Document, Types } from 'mongoose';

export type FollowTargetType = 'buyer' | 'organizer';
export type FollowerType = 'buyer' | 'vendor';

/**
 * A directed follow edge. The follower is a buyer or an organizer brand
 * (Vendor); the target is a buyer or an organizer. followerId holds the
 * follower's id regardless of followerType.
 */
export interface IFollow extends Document {
  followerType: FollowerType;
  followerId: Types.ObjectId;
  targetType: FollowTargetType;
  targetId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const followSchema = new Schema<IFollow>(
  {
    followerType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    followerId: { type: Schema.Types.ObjectId, required: true },
    targetType: { type: String, enum: ['buyer', 'organizer'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

// One edge per (follower, target). followerType disambiguates a buyer and a
// vendor that share an ObjectId value.
followSchema.index({ followerType: 1, followerId: 1, targetType: 1, targetId: 1 }, { unique: true });
// Follower counts / lists for a target.
followSchema.index({ targetType: 1, targetId: 1 });

export const Follow = model<IFollow>('Follow', followSchema);
```

> **Prod deploy note (not a code step):** the legacy unique index `followerId_1_targetType_1_targetId_1` remains on the prod collection until dropped — harmless (distinct follower ids never collide), but for hygiene: `db.follows.dropIndex('followerId_1_targetType_1_targetId_1')`. Fresh test DBs build only the new indexes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- follow.model.test`
Expected: PASS. Also confirm the existing follow/graph suites still pass: `npm test -- socialGraph follow` → PASS (default `followerType:'buyer'` keeps buyer edges unique as before).

- [ ] **Step 5: Commit**

```bash
git add src/models/follow.model.ts src/models/__tests__/follow.model.test.ts
git commit -m "feat(social): add followerType discriminator to Follow (migration-safe)"
```

---

### Task 2: `FollowService` actor generalization + feed following-tab fix

**Files:**
- Modify: `src/services/follow.service.ts`
- Modify: `src/services/feed.service.ts`
- Modify (test): `src/services/__tests__/follow.service.test.ts` — **this file already EXISTS** with a single `describe('FollowService', …)` that imports `mongoose, {Buyer, IBuyer}, Vendor, Follow, FollowService, HttpError`, calls `await Follow.init()` in `beforeAll`, clears per test, and has a `seedBuyer(phone) = Buyer.create({ phone, password: 'secret1', name })` helper. ADD the vendor cases (a `makeVendor` helper + 4 `it(...)`) **inside that existing describe block**, reusing its lifecycle + `seedBuyer`. Do NOT add a second `describe` (the mongo helper starts a fresh `MongoMemoryServer` per `connectTestDb`, and no test file in this repo runs two connect/disconnect lifecycles — keep to one).

**Vendor seed rule (important):** `Vendor` requires a unique `email` and unique `phoneNumber`, and auto-generates a unique `slug` from `businessName` in a pre-save hook — so **every seeded vendor needs a DISTINCT businessName, email, and phoneNumber** or the create throws a duplicate-key error. Use a per-call counter helper.

**Interfaces:**
- Consumes: `Follow`, `FollowerType`, `FollowTargetType`; `assertNotSuspended`; `NotificationDispatcher`.
- Produces:
  - `FollowService.followAsVendor(vendorId: string, targetType: FollowTargetType, targetId: string): Promise<void>`
  - `FollowService.unfollowAsVendor(vendorId: string, targetType: FollowTargetType, targetId: string): Promise<void>`
  - `FollowService.followingCount(followerId: string, followerType?: FollowerType): Promise<number>` (default `'buyer'`)
  - `FollowService.followingIds(followerId: string, targetType: FollowTargetType, followerType?: FollowerType): Promise<string[]>` (default `'buyer'`)
  - existing `follow(buyer, …)` / `unfollow(buyer, …)` keep their signatures and buyer behavior.

- [ ] **Step 1: Write the failing test**

Inside the EXISTING `describe('FollowService', …)` block, add a `makeVendor` helper (near the existing `seedBuyer`) and the 4 `it(...)` cases below. `HttpError` sets `statusCode` (confirmed in `@utils/httpError.util`), so `.rejects.toMatchObject({ statusCode })` is correct. The per-call `makeVendor` counter guarantees distinct businessName/email/phoneNumber (all required + unique-per-vendor; `slug` auto-derives from `businessName`, so distinct names avoid a slug collision):

```ts
  // add near seedBuyer, still inside describe('FollowService', …)
  let vseq = 0;
  const makeVendor = () => {
    vseq += 1;
    return Vendor.create({
      businessName: `Brand ${vseq}`,
      email: `vendor${vseq}@example.com`,
      phoneNumber: `+2687${8000000 + vseq}`,
      password: 'secret123',
    });
  };

  it('a vendor follows a buyer and an organizer; counts + edges are scoped to the vendor', async () => {
    const vendor = await makeVendor();
    const buyer = await seedBuyer('+26878000101');
    const otherVendor = await makeVendor();

    await FollowService.followAsVendor(String(vendor._id), 'buyer', String(buyer._id));
    await FollowService.followAsVendor(String(vendor._id), 'organizer', String(otherVendor._id));

    expect(await FollowService.followingCount(String(vendor._id), 'vendor')).toBe(2);
    expect(await FollowService.followingCount(String(vendor._id), 'buyer')).toBe(0); // no buyer-typed edges for this id
    expect(await FollowService.followingIds(String(vendor._id), 'organizer', 'vendor')).toEqual([String(otherVendor._id)]);

    const edge = await Follow.findOne({ followerType: 'vendor', followerId: vendor._id, targetType: 'buyer' });
    expect(edge).toBeTruthy();
  });

  it('followAsVendor is idempotent and 404s an unknown target', async () => {
    const vendor = await makeVendor();
    const buyer = await seedBuyer('+26878000102');
    await FollowService.followAsVendor(String(vendor._id), 'buyer', String(buyer._id));
    await FollowService.followAsVendor(String(vendor._id), 'buyer', String(buyer._id)); // no throw
    expect(await FollowService.followingCount(String(vendor._id), 'vendor')).toBe(1);

    await expect(
      FollowService.followAsVendor(String(vendor._id), 'buyer', String(new mongoose.Types.ObjectId()))
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a vendor cannot follow itself', async () => {
    const vendor = await makeVendor();
    await expect(
      FollowService.followAsVendor(String(vendor._id), 'organizer', String(vendor._id))
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('unfollowAsVendor removes only the vendor edge', async () => {
    const vendor = await makeVendor();
    const buyer = await seedBuyer('+26878000103');
    await FollowService.followAsVendor(String(vendor._id), 'buyer', String(buyer._id));
    await FollowService.unfollowAsVendor(String(vendor._id), 'buyer', String(buyer._id));
    expect(await FollowService.followingCount(String(vendor._id), 'vendor')).toBe(0);
  });
  // NOTE: these cases live INSIDE the existing describe('FollowService', …) —
  // do not add a describe wrapper or a closing `});` here.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- follow.service.test`
Expected: FAIL — `FollowService.followAsVendor` / `unfollowAsVendor` do not exist, and `followingCount`/`followingIds` don't accept a `followerType`.

- [ ] **Step 3: Write minimal implementation**

In `src/services/follow.service.ts`, add the `FollowerType` import, a private `createEdge` core, the vendor methods, and the `followerType` params. Refactor `follow`/`unfollow`/`followingCount`/`followingIds` to route through the generalized shape while preserving buyer behavior:

```ts
import { Follow, FollowTargetType, FollowerType } from '@models/follow.model';
```

```ts
  /**
   * Create a follow edge. Returns true if newly created, false if it already
   * existed (idempotent). Throws 400 on self-follow, 404 on unknown target.
   */
  private static async createEdge(
    followerType: FollowerType,
    followerId: string,
    targetType: FollowTargetType,
    targetId: string
  ): Promise<boolean> {
    const selfFollow =
      (followerType === 'buyer' && targetType === 'buyer' && followerId === targetId) ||
      (followerType === 'vendor' && targetType === 'organizer' && followerId === targetId);
    if (selfFollow) throw new HttpError(400, 'You cannot follow yourself');

    const exists =
      targetType === 'buyer' ? await Buyer.exists({ _id: targetId }) : await Vendor.exists({ _id: targetId });
    if (!exists) throw new HttpError(404, 'User not found');

    try {
      await Follow.create({ followerType, followerId, targetType, targetId });
      return true;
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // already following — idempotent
      return false;
    }
  }

  static async follow(buyer: IBuyer, targetType: FollowTargetType, targetId: string): Promise<void> {
    assertNotSuspended(buyer);
    const created = await FollowService.createEdge('buyer', String(buyer._id), targetType, targetId);
    if (created && targetType === 'buyer' && (await FollowService.isFriend(String(buyer._id), targetId))) {
      NotificationDispatcher.dispatchAsync(
        [targetId],
        'friend',
        buyer.username ?? buyer.name ?? 'Someone',
        'followed you back — you are now friends',
        { buyerId: String(buyer._id), username: buyer.username ?? null },
        String(buyer._id)
      );
    }
  }

  static async unfollow(buyer: IBuyer, targetType: FollowTargetType, targetId: string): Promise<void> {
    await Follow.deleteOne({ followerType: 'buyer', followerId: buyer._id, targetType, targetId });
  }

  /** The brand follows a buyer or another organizer. No suspension, no friend concept. */
  static async followAsVendor(vendorId: string, targetType: FollowTargetType, targetId: string): Promise<void> {
    await FollowService.createEdge('vendor', String(vendorId), targetType, targetId);
  }

  static async unfollowAsVendor(vendorId: string, targetType: FollowTargetType, targetId: string): Promise<void> {
    await Follow.deleteOne({ followerType: 'vendor', followerId: vendorId, targetType, targetId });
  }
```

Update the two count/list helpers to accept `followerType` (default `'buyer'`, so existing buyer callers are unchanged):

```ts
  static async followingCount(followerId: string, followerType: FollowerType = 'buyer'): Promise<number> {
    return Follow.countDocuments({ followerType, followerId });
  }

  static async followingIds(followerId: string, targetType: FollowTargetType, followerType: FollowerType = 'buyer'): Promise<string[]> {
    const rows = await Follow.find({ followerType, followerId, targetType }).select('targetId');
    return rows.map((r) => String(r.targetId));
  }
```

Leave `isFriend`, `followerCount`, `followerIds`, `friendIds`, `organizerFollowerIds` unchanged — they are correct as-is for the buyer/target semantics they serve.

In `src/services/feed.service.ts`, scope the following-tab follow-set to the actor's type (so a vendor viewer uses vendor edges):

```ts
  if (opts.actor && opts.tab === 'following') {
    const follows = await Follow.find({ followerType: opts.actor.type === 'vendor' ? 'vendor' : 'buyer', followerId: opts.actor.id }).lean();
    followedAuthorIds = follows.filter((f) => f.targetType === 'buyer').map((f) => f.targetId);
    followedOrgIds = follows.filter((f) => f.targetType === 'organizer').map((f) => f.targetId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- follow.service.test`
Expected: PASS. Then confirm no buyer regressions: `npm test -- socialGraph feed.service` → PASS (buyer `follow`/`following` behavior and the buyer following-tab unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/services/follow.service.ts src/services/feed.service.ts src/services/__tests__/follow.service.test.ts
git commit -m "feat(social): FollowService vendor actor (followAsVendor/unfollowAsVendor) + feed following-tab by actor type"
```

---

### Task 3: Vendor social routes — brand `me`, follow, unfollow

**Files:**
- Create: `src/controllers/vendorSocial.controller.ts`
- Create: `src/routes/vendorSocial.route.ts`
- Modify: `src/app.ts` — mount `vendorSocial.route`
- Test: `src/routes/__tests__/vendorSocial.route.test.ts`

**Interfaces:**
- Consumes: `authenticateTickets`, `FollowService`, `Vendor`, `followSchema` (`@validators/community.validator`).
- Produces routes (all `authenticateTickets`, actor = `req.ticketsUser.vendorId`):
  - `GET /api/tickets/social/me` → `{ id, businessName, slug, logoUrl, bio, followerCount, followingCount }`
  - `POST /api/tickets/social/follow` body `{ targetType: 'buyer'|'organizer', targetId }` → `{ following: true }`
  - `DELETE /api/tickets/social/follow/:targetType/:targetId` → `{ following: false }`

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorSocial.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

let vseq = 0;
const makeVendor = (name?: string) => {
  vseq += 1;
  return Vendor.create({
    businessName: name ?? `Brand ${vseq}`,
    email: `vendor${vseq}@example.com`,
    phoneNumber: `+2687${8000000 + vseq}`,
    password: 'secret123',
  });
};

describe('/api/tickets/social (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('GET /me returns the brand social summary', async () => {
    const vendor = await makeVendor('Bhora Fest');
    const res = await request(app).get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`).expect(200);
    expect(res.body.data).toMatchObject({ id: String(vendor._id), businessName: 'Bhora Fest', followerCount: 0, followingCount: 0 });
  });

  it('follows a buyer, reflects in followingCount, then unfollows', async () => {
    const vendor = await makeVendor();
    const buyer = await Buyer.create({ phone: '+26878000201', name: 'B', password: 'secret1' });
    const token = `Bearer ${signVendorToken(String(vendor._id))}`;

    await request(app).post('/api/tickets/social/follow')
      .set('Authorization', token).send({ targetType: 'buyer', targetId: String(buyer._id) }).expect(200);

    const me = await request(app).get('/api/tickets/social/me').set('Authorization', token).expect(200);
    expect(me.body.data.followingCount).toBe(1);

    await request(app).delete(`/api/tickets/social/follow/buyer/${buyer._id}`).set('Authorization', token).expect(200);
    const me2 = await request(app).get('/api/tickets/social/me').set('Authorization', token).expect(200);
    expect(me2.body.data.followingCount).toBe(0);
  });

  it('400s an invalid follow body', async () => {
    const vendor = await makeVendor();
    await request(app).post('/api/tickets/social/follow')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
      .send({ targetType: 'nope', targetId: 'x' }).expect(400);
  });

  it('401s a buyer token (no vendorId)', async () => {
    await request(app).get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- vendorSocial.route.test`
Expected: FAIL — routes 404 (not mounted).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/controllers/vendorSocial.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Vendor } from '@models/vendor.model';
import { FollowService } from '@services/follow.service';
import { followSchema } from '@validators/community.validator';
import { failWithHttpError } from '@utils/controllerHelpers.util';

/** Social-graph endpoints where the acting identity is the organizer brand (Vendor). */
export class VendorSocialController {
  private static vendorId(req: Request): string | undefined {
    return (req as any).ticketsUser?.vendorId;
  }

  /** GET /api/tickets/social/me — the brand's own social summary. */
  static async me(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const vendor = await Vendor.findById(vendorId).select('businessName slug logoUrl bio');
      if (!vendor) return ApiResponseUtil.notFound(res, 'Organizer not found');
      const [followerCount, followingCount] = await Promise.all([
        FollowService.followerCount('organizer', vendorId),
        FollowService.followingCount(vendorId, 'vendor'),
      ]);
      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        slug: (vendor as any).slug ?? null,
        logoUrl: vendor.logoUrl ?? null,
        bio: vendor.bio ?? null,
        followerCount,
        followingCount,
      });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load brand profile');
    }
  }

  /** POST /api/tickets/social/follow */
  static async follow(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = followSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      await FollowService.followAsVendor(vendorId, value.targetType, value.targetId);
      return ApiResponseUtil.success(res, { following: true }, 'Followed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to follow');
    }
  }

  /** DELETE /api/tickets/social/follow/:targetType/:targetId */
  static async unfollow(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const targetType = String(req.params['targetType'] || '');
      const targetId = String(req.params['targetId'] || '');
      if (!['buyer', 'organizer'].includes(targetType) || !/^[0-9a-f]{24}$/i.test(targetId)) {
        return ApiResponseUtil.error(res, 'Invalid follow target', 400);
      }
      await FollowService.unfollowAsVendor(vendorId, targetType as 'buyer' | 'organizer', targetId);
      return ApiResponseUtil.success(res, { following: false }, 'Unfollowed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to unfollow');
    }
  }
}
```

```ts
// src/routes/vendorSocial.route.ts
import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { VendorSocialController } from '@controllers/vendorSocial.controller';

// Vendor (organizer brand) social-graph endpoints. Mounted at
// /api/tickets/social — see src/app.ts, placed before the broader
// /api/tickets mount so these specific paths aren't shadowed.
const router = Router();

router.get('/me', authenticateTickets, VendorSocialController.me);
router.post('/follow', authenticateTickets, VendorSocialController.follow);
router.delete('/follow/:targetType/:targetId', authenticateTickets, VendorSocialController.unfollow);

export default router;
```

In `src/app.ts`, import and mount it just beside the existing vendor-updates mount (which is already before the broad `/api/tickets`):

```ts
import vendorSocialRoutes from '@routes/vendorSocial.route';
```

```ts
app.use('/api/tickets/updates', vendorUpdateRoutes);
app.use('/api/tickets/social', vendorSocialRoutes);   // Vendor (brand) social graph — before the broad /api/tickets
app.use('/api/tickets', ticketsRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- vendorSocial.route.test`
Expected: PASS (4 tests). Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/vendorSocial.controller.ts src/routes/vendorSocial.route.ts src/app.ts src/routes/__tests__/vendorSocial.route.test.ts
git commit -m "feat(social): vendor social routes — brand /me, follow, unfollow"
```

---

### Task 4: Full-suite green + integration sweep

**Files:**
- Test: `src/routes/__tests__/vendorFollow.integration.test.ts`

**Interfaces:** Consumes everything above. No new production code.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorFollow.integration.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';

describe('vendor follows an organizer end-to-end', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('brand A follows brand B; A.following=1 and B.followerCount=1', async () => {
    const a = await Vendor.create({ businessName: 'Brand A', email: 'brand-a@example.com', password: 'secret123', phoneNumber: '+26878000301' });
    const b = await Vendor.create({ businessName: 'Brand B', email: 'brand-b@example.com', password: 'secret123', phoneNumber: '+26878000302' });
    const tokenA = `Bearer ${signVendorToken(String(a._id))}`;

    await request(app).post('/api/tickets/social/follow')
      .set('Authorization', tokenA).send({ targetType: 'organizer', targetId: String(b._id) }).expect(200);

    const meA = await request(app).get('/api/tickets/social/me').set('Authorization', tokenA).expect(200);
    expect(meA.body.data.followingCount).toBe(1);

    const publicB = await request(app).get(`/api/public/organizers/${b._id}`).expect(200);
    expect(publicB.body.data.followerCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- vendorFollow.integration.test`
Expected: PASS (Tasks 1–3 wired it). If it FAILS, fix the offending task; do not weaken the test.

- [ ] **Step 3: Full suite + tsc**

Run: `npx tsc --noEmit` → expect 0 errors.
Run: `npm test 2>&1 | tail -40`. Expect all suites green except the known `social.route.test.ts` flake; for each failing suite, re-run it in isolation and record whether it passes alone (evidence it's flakiness, not a regression). Never weaken an assertion to chase the exit code.

- [ ] **Step 4: Commit**

```bash
git add src/routes/__tests__/vendorFollow.integration.test.ts
git commit -m "test(social): end-to-end vendor follow across /me and public organizer profile"
```

- [ ] **Step 5: Record deploy follow-up**

Add a note at the `Follow` unique-index definition (like SP1a's `UpdateReaction`) so the one-time prod index cleanup isn't forgotten — a comment referencing `db.follows.dropIndex('followerId_1_targetType_1_targetId_1')`. Commit:

```bash
git add src/models/follow.model.ts
git commit -m "docs(social): record legacy Follow index cleanup at the index definition"
```

---

## Self-Review

**1. Spec coverage (SP1b-a slice of umbrella §5 — vendor social graph, follow subset):**
- Follow generalization (`followerType`) → Task 1. ✅
- Vendor follow/unfollow as actor → Task 2 (service) + Task 3 (routes). ✅
- Brand social `me` (counts) → Task 3. ✅
- Feed following-tab correct for a vendor viewer → Task 2. ✅
- *Deferred to SP1b-b/c (documented, not gaps):* following/followers **lists** (mixed summaries), **search** (incl. vendors), **block**, **notifications**, **push**. Called out in Global Constraints.

**2. Placeholder scan:** No TBD/TODO; every code step is complete; deploy notes are labeled as such. ✅

**3. Type consistency:** `FollowerType`/`FollowTargetType` (Task 1) used verbatim in Task 2 signatures; `followAsVendor`/`unfollowAsVendor`/`followingCount(id, followerType)` (Task 2) called exactly so in Task 3's controller; route paths `/api/tickets/social/{me,follow,follow/:targetType/:targetId}` (Task 3) match the test URLs (Tasks 3 & 4). ✅

## Execution Handoff

On completion, next is **SP1b-b** (follow/followers lists + search + block), then **SP1b-c** (notifications + push), then **SP2** (DMs + realtime).
