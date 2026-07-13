# SP1b-b — Vendor Graph Lists + Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the organizer brand the *read/discovery* side of the follow graph — see who the brand follows and who follows it (mixed buyer + brand results), and search for accounts to follow. Ships "dark" (no UI until SP3).

**Architecture:** Purely additive read endpoints on the existing `/api/tickets/social` vendor router (from SP1b-a). Introduce a `toVendorSummary` helper (mirroring `toBuyerSummary`) so lists/search can return a uniform `{ buyers, organizers }` shape, and one new `FollowService.followersOfOrganizer` that returns followers *with their type* (a brand's followers can now be buyers OR other brands). No model changes, no writes — lower risk than SP1b-a.

**Tech Stack:** Node/TypeScript, Express, Mongoose 7 (MongoDB), Jest + supertest + mongodb-memory-server. Path aliases `@models/*`, `@services/*`, `@controllers/*`, `@utils/*`, `@middleware/*`.

## Global Constraints

- **Umbrella spec:** `docs/superpowers/specs/2026-07-13-organizer-social-shell-design.md`. This is **SP1b-b** (lists + search). **SP1b-c** = block (generalize `Block` like `Follow`/`UpdateReaction`) + notifications + push. SP2 = DMs + realtime.
- **Builds on SP1b-a (already on `main`):** `Follow.followerType` + `FollowService.followingIds(followerId, targetType, followerType)` / `followerCount` exist; vendor router mounted at `/api/tickets/social` with `me`/`follow`/`unfollow`.
- **Additive only, read-only:** no model/schema changes, no writes; do NOT modify the existing buyer endpoints (`/api/social/*`) or `FollowService.organizerFollowerIds` (used by the notification fan-out).
- **Vendor actor = the brand:** actor id = `req.ticketsUser.vendorId`; all routes `authenticateTickets`, 401 if no vendorId.
- **No block filtering yet:** block is not generalized for a vendor actor until SP1b-c, so vendor search/lists do NOT filter by blocks. Note this in code; it is deliberate, not an omission.
- **Uniform response shape:** following, followers, and search all return `{ buyers: BuyerSummary[], organizers: VendorSummary[] }`. `BuyerSummary` NEVER includes the phone (existing invariant).
- **Fail loud, no fake data.** YAGNI. TDD. Commit after every task. Full suite before the final commit.
- **Vendor seed rule (tests):** `Vendor` requires unique `email`, `phoneNumber`, and auto-derives a unique `slug` from `businessName` — every seeded vendor needs a DISTINCT businessName/email/phoneNumber (use a per-call counter). `Buyer` requires `phone` (unique) + `password`; a `username` is optional but must match `/^[a-z0-9_]{3,20}$/` and be unique when set.
- **Known-flaky suite:** `social.route.test.ts` (username race) can fail only under the parallel full-suite run; it passes in isolation and is unrelated.

## File Structure

- **Create** `src/utils/vendorSummary.util.ts` — `VendorSummary` + `toVendorSummary(vendor)`.
- **Modify** `src/services/follow.service.ts` — add `followersOfOrganizer(vendorId)` returning `{ followerType, followerId }[]`.
- **Modify** `src/controllers/vendorSocial.controller.ts` — add `following`, `followers`, `searchUsers`.
- **Modify** `src/routes/vendorSocial.route.ts` — add the three GET routes.
- **Tests** next to each unit under `src/**/__tests__/`.

---

### Task 1: `toVendorSummary` + `FollowService.followersOfOrganizer`

**Files:**
- Create: `src/utils/vendorSummary.util.ts`
- Test: `src/utils/__tests__/vendorSummary.util.test.ts`
- Modify: `src/services/follow.service.ts`
- Modify (test): `src/services/__tests__/follow.service.test.ts` — add cases INSIDE the existing `describe('FollowService', …)` block (reuse its `makeVendor`/`seedBuyer` helpers; do NOT add a second describe).

**Interfaces:**
- Produces: `interface VendorSummary { id: string; businessName: string; slug: string | null; logoUrl: string | null }`; `toVendorSummary(v): VendorSummary`.
- Produces: `FollowService.followersOfOrganizer(vendorId: string): Promise<{ followerType: FollowerType; followerId: string }[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/utils/__tests__/vendorSummary.util.test.ts
import { toVendorSummary } from '@utils/vendorSummary.util';

describe('toVendorSummary', () => {
  it('maps a vendor doc to the public brand summary (no sensitive fields)', () => {
    const v: any = { _id: 'abc', businessName: 'Bhora Fest', slug: 'bhora-fest', logoUrl: 'https://cdn/x.png', email: 'secret@x.com', password: 'h' };
    expect(toVendorSummary(v)).toEqual({ id: 'abc', businessName: 'Bhora Fest', slug: 'bhora-fest', logoUrl: 'https://cdn/x.png' });
  });

  it('nulls missing slug/logoUrl', () => {
    const v: any = { _id: 'abc', businessName: 'Solo' };
    expect(toVendorSummary(v)).toEqual({ id: 'abc', businessName: 'Solo', slug: null, logoUrl: null });
  });
});
```

Add to the EXISTING `describe('FollowService', …)` in `src/services/__tests__/follow.service.test.ts` (uses its `makeVendor`/`seedBuyer`):

```ts
  it('followersOfOrganizer returns followers with their type', async () => {
    const brand = await makeVendor();
    const buyerFollower = await seedBuyer('+26878000501');
    const brandFollower = await makeVendor();

    await FollowService.follow(buyerFollower, 'organizer', String(brand._id));       // buyer follows brand
    await FollowService.followAsVendor(String(brandFollower._id), 'organizer', String(brand._id)); // brand follows brand

    const followers = await FollowService.followersOfOrganizer(String(brand._id));
    expect(followers).toHaveLength(2);
    expect(followers).toEqual(expect.arrayContaining([
      { followerType: 'buyer', followerId: String(buyerFollower._id) },
      { followerType: 'vendor', followerId: String(brandFollower._id) },
    ]));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- vendorSummary.util.test` → FAIL (`Cannot find module '@utils/vendorSummary.util'`).
Run: `npm test -- follow.service.test` → FAIL (`followersOfOrganizer` is not a function).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/utils/vendorSummary.util.ts
/** The one public shape for "a brand" in lists/search. Never includes email/phone/password. */
export interface VendorSummary {
  id: string;
  businessName: string;
  slug: string | null;
  logoUrl: string | null;
}

export function toVendorSummary(vendor: any): VendorSummary {
  return {
    id: String(vendor._id),
    businessName: vendor.businessName,
    slug: vendor.slug ?? null,
    logoUrl: vendor.logoUrl ?? null,
  };
}
```

Add to `src/services/follow.service.ts` (near `organizerFollowerIds`, which stays unchanged):

```ts
  /** Followers of an organizer brand, WITH their type (buyers and/or other brands). */
  static async followersOfOrganizer(vendorId: string): Promise<{ followerType: FollowerType; followerId: string }[]> {
    const rows = await Follow.find({ targetType: 'organizer', targetId: vendorId }).select('followerType followerId');
    return rows.map((r) => ({ followerType: r.followerType, followerId: String(r.followerId) }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- vendorSummary.util.test` → PASS (2).
Run: `npm test -- follow.service.test` → PASS (existing + new case).

- [ ] **Step 5: Commit**

```bash
git add src/utils/vendorSummary.util.ts src/utils/__tests__/vendorSummary.util.test.ts src/services/follow.service.ts src/services/__tests__/follow.service.test.ts
git commit -m "feat(social): toVendorSummary + FollowService.followersOfOrganizer (typed followers)"
```

---

### Task 2: Vendor following + followers lists

**Files:**
- Modify: `src/controllers/vendorSocial.controller.ts`
- Modify: `src/routes/vendorSocial.route.ts`
- Test: `src/routes/__tests__/vendorSocialLists.route.test.ts`

**Interfaces:**
- Consumes: `FollowService.followingIds(id, targetType, 'vendor')`, `FollowService.followersOfOrganizer(id)`, `toBuyerSummary` (`@utils/buyerSummary.util`), `toVendorSummary` (Task 1), `Buyer`, `Vendor`.
- Produces routes (both `authenticateTickets`): `GET /api/tickets/social/me/following` and `GET /api/tickets/social/me/followers`, each → `{ buyers: BuyerSummary[], organizers: VendorSummary[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorSocialLists.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

let vseq = 0;
const makeVendor = () => {
  vseq += 1;
  return Vendor.create({ businessName: `Brand ${vseq}`, email: `vendor${vseq}@example.com`, phoneNumber: `+2687${8100000 + vseq}`, password: 'secret123' });
};

describe('/api/tickets/social/me/following|followers (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('following lists the buyers and brands the vendor follows', async () => {
    const me = await makeVendor();
    const followedBrand = await makeVendor();
    const followedBuyer = await Buyer.create({ phone: '+26878000601', password: 'secret1', name: 'Alice', username: 'alice_ff' });
    const token = `Bearer ${signVendorToken(String(me._id))}`;

    await request(app).post('/api/tickets/social/follow').set('Authorization', token).send({ targetType: 'organizer', targetId: String(followedBrand._id) }).expect(200);
    await request(app).post('/api/tickets/social/follow').set('Authorization', token).send({ targetType: 'buyer', targetId: String(followedBuyer._id) }).expect(200);

    const res = await request(app).get('/api/tickets/social/me/following').set('Authorization', token).expect(200);
    expect(res.body.data.organizers.map((o: any) => o.id)).toEqual([String(followedBrand._id)]);
    expect(res.body.data.buyers.map((b: any) => b.id)).toEqual([String(followedBuyer._id)]);
    expect(res.body.data.buyers[0]).not.toHaveProperty('phone');
  });

  it('followers lists buyers and brands that follow the vendor', async () => {
    const me = await makeVendor();
    const followerBrand = await makeVendor();
    const followerBuyer = await Buyer.create({ phone: '+26878000602', password: 'secret1', name: 'Bob' });

    // buyer follows me (buyer route resolves the buyer from the token phone)
    await request(app).post('/api/social/follow').set('Authorization', `Bearer ${signBuyerToken('+26878000602')}`).send({ targetType: 'organizer', targetId: String(me._id) }).expect(200);
    // brand follows me (vendor route)
    await request(app).post('/api/tickets/social/follow').set('Authorization', `Bearer ${signVendorToken(String(followerBrand._id))}`).send({ targetType: 'organizer', targetId: String(me._id) }).expect(200);

    const res = await request(app).get('/api/tickets/social/me/followers').set('Authorization', `Bearer ${signVendorToken(String(me._id))}`).expect(200);
    expect(res.body.data.organizers.map((o: any) => o.id)).toEqual([String(followerBrand._id)]);
    expect(res.body.data.buyers.map((b: any) => b.id)).toEqual([String(followerBuyer._id)]);
  });
});
```

> Note: the followers test drives the real buyer follow endpoint `POST /api/social/follow` (authenticateBuyer) to create a buyer→brand edge. That endpoint resolves the buyer from the token phone, so the seeded buyer's phone must match the token phone (`+26878000602`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- vendorSocialLists.route.test`
Expected: FAIL — `/me/following` and `/me/followers` return 404 (not mounted).

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/vendorSocial.controller.ts` (imports: `toBuyerSummary` from `@utils/buyerSummary.util`, `toVendorSummary` from `@utils/vendorSummary.util`, `Buyer` from `@models/buyer.model`):

```ts
  /** GET /api/tickets/social/me/following — buyers + brands this brand follows. */
  static async following(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const [buyerIds, orgIds] = await Promise.all([
        FollowService.followingIds(vendorId, 'buyer', 'vendor'),
        FollowService.followingIds(vendorId, 'organizer', 'vendor'),
      ]);
      const [buyers, organizers] = await Promise.all([
        Buyer.find({ _id: { $in: buyerIds } }),
        Vendor.find({ _id: { $in: orgIds } }).select('businessName slug logoUrl'),
      ]);
      return ApiResponseUtil.success(res, { buyers: buyers.map(toBuyerSummary), organizers: organizers.map(toVendorSummary) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load following');
    }
  }

  /** GET /api/tickets/social/me/followers — buyers + brands that follow this brand. */
  static async followers(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const rows = await FollowService.followersOfOrganizer(vendorId);
      const buyerIds = rows.filter((r) => r.followerType === 'buyer').map((r) => r.followerId);
      const vendorIds = rows.filter((r) => r.followerType === 'vendor').map((r) => r.followerId);
      const [buyers, organizers] = await Promise.all([
        Buyer.find({ _id: { $in: buyerIds } }),
        Vendor.find({ _id: { $in: vendorIds } }).select('businessName slug logoUrl'),
      ]);
      return ApiResponseUtil.success(res, { buyers: buyers.map(toBuyerSummary), organizers: organizers.map(toVendorSummary) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load followers');
    }
  }
```

Add to `src/routes/vendorSocial.route.ts` (after the existing routes):

```ts
router.get('/me/following', authenticateTickets, VendorSocialController.following);
router.get('/me/followers', authenticateTickets, VendorSocialController.followers);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- vendorSocialLists.route.test` → PASS (2). Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/vendorSocial.controller.ts src/routes/vendorSocial.route.ts src/routes/__tests__/vendorSocialLists.route.test.ts
git commit -m "feat(social): vendor following/followers lists (mixed buyer + brand summaries)"
```

---

### Task 3: Vendor account search

**Files:**
- Modify: `src/controllers/vendorSocial.controller.ts`
- Modify: `src/routes/vendorSocial.route.ts`
- Test: `src/routes/__tests__/vendorSocialSearch.route.test.ts`

**Interfaces:**
- Produces route (`authenticateTickets`): `GET /api/tickets/social/users/search?q=` → `{ buyers: BuyerSummary[], organizers: VendorSummary[] }`. Buyers match by username prefix (`^q`, case-insensitive); brands match by businessName contains (case-insensitive), excluding the searching brand and inactive brands. `q` must be 2–30 chars.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorSocialSearch.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

describe('GET /api/tickets/social/users/search (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('finds buyers by username prefix and brands by name, excluding self', async () => {
    const me = await Vendor.create({ businessName: 'Bhora Fest', email: 'me-search@example.com', phoneNumber: '+26878000701', password: 'secret123' });
    const other = await Vendor.create({ businessName: 'Bhora Nights', email: 'other-search@example.com', phoneNumber: '+26878000702', password: 'secret123' });
    await Buyer.create({ phone: '+26878000703', password: 'secret1', name: 'Bo', username: 'bhora_fan' });
    const token = `Bearer ${signVendorToken(String(me._id))}`;

    const res = await request(app).get('/api/tickets/social/users/search?q=bho').set('Authorization', token).expect(200);
    expect(res.body.data.buyers.map((b: any) => b.username)).toContain('bhora_fan');
    const orgIds = res.body.data.organizers.map((o: any) => o.id);
    expect(orgIds).toContain(String(other._id)); // matches "Bhora Nights"
    expect(orgIds).not.toContain(String(me._id)); // self excluded
  });

  it('400s a too-short query', async () => {
    const me = await Vendor.create({ businessName: 'Solo Brand', email: 'solo@example.com', phoneNumber: '+26878000704', password: 'secret123' });
    await request(app).get('/api/tickets/social/users/search?q=b').set('Authorization', `Bearer ${signVendorToken(String(me._id))}`).expect(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- vendorSocialSearch.route.test`
Expected: FAIL — route 404 (not mounted).

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/vendorSocial.controller.ts`:

```ts
  /** GET /api/tickets/social/users/search?q= — buyers by username prefix + brands by name. */
  static async searchUsers(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const q = String(req.query['q'] || '').toLowerCase();
      if (q.length < 2 || q.length > 30) return ApiResponseUtil.error(res, 'q must be 2-30 characters', 400);
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // No block filtering: block is not a vendor concept until SP1b-c.
      const [buyers, brands] = await Promise.all([
        Buyer.find({ username: { $regex: `^${escaped}`, $options: 'i' } }).limit(20),
        Vendor.find({ businessName: { $regex: escaped, $options: 'i' }, isActive: true, _id: { $ne: vendorId } })
          .select('businessName slug logoUrl').limit(20),
      ]);
      return ApiResponseUtil.success(res, { buyers: buyers.map(toBuyerSummary), organizers: brands.map(toVendorSummary) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to search accounts');
    }
  }
```

Add to `src/routes/vendorSocial.route.ts` — **register `/users/search` before any `/users/:x`** (there is none here, but keep the convention):

```ts
router.get('/users/search', authenticateTickets, VendorSocialController.searchUsers);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- vendorSocialSearch.route.test` → PASS (2). Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/vendorSocial.controller.ts src/routes/vendorSocial.route.ts src/routes/__tests__/vendorSocialSearch.route.test.ts
git commit -m "feat(social): vendor account search (buyers by username + brands by name)"
```

---

### Task 4: Full-suite green + integration sweep

**Files:**
- Test: `src/routes/__tests__/vendorGraphReads.integration.test.ts`

**Interfaces:** Consumes everything above. No new production code.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorGraphReads.integration.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';

describe('vendor discovers, follows, then sees it in following', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('search → follow → following reflects the followed brand', async () => {
    const me = await Vendor.create({ businessName: 'Alpha Events', email: 'alpha@example.com', phoneNumber: '+26878000801', password: 'secret123' });
    const target = await Vendor.create({ businessName: 'Alpine Sound', email: 'alpine@example.com', phoneNumber: '+26878000802', password: 'secret123' });
    const token = `Bearer ${signVendorToken(String(me._id))}`;

    const search = await request(app).get('/api/tickets/social/users/search?q=alpine').set('Authorization', token).expect(200);
    const found = search.body.data.organizers.find((o: any) => o.id === String(target._id));
    expect(found).toBeTruthy();

    await request(app).post('/api/tickets/social/follow').set('Authorization', token).send({ targetType: 'organizer', targetId: found.id }).expect(200);

    const following = await request(app).get('/api/tickets/social/me/following').set('Authorization', token).expect(200);
    expect(following.body.data.organizers.map((o: any) => o.id)).toContain(String(target._id));
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- vendorGraphReads.integration.test` → PASS (Tasks 1–3 wired it). If it FAILS, fix the offending task; do not weaken the test.

- [ ] **Step 3: Full suite + tsc**

Run: `npx tsc --noEmit` → 0 errors.
Run: `npm test 2>&1 | tail -40`. Expect all green except the known `social.route.test.ts` flake; for each failing suite, re-run in isolation and record whether it passes alone. Never weaken an assertion.

- [ ] **Step 4: Commit**

```bash
git add src/routes/__tests__/vendorGraphReads.integration.test.ts
git commit -m "test(social): end-to-end vendor search → follow → following"
```

---

## Self-Review

**1. Spec coverage (SP1b-b slice):**
- Vendor following list (mixed) → Task 2. ✅
- Vendor followers list (mixed) → Tasks 1 (typed followers) + 2. ✅
- Vendor account search (buyers + brands) → Task 3. ✅
- *Deferred to SP1b-c (documented):* block (+ block-filtering of search/lists), notifications, push.

**2. Placeholder scan:** No TBD/TODO; complete code in every step. ✅

**3. Type consistency:** `VendorSummary`/`toVendorSummary` (Task 1) used in Tasks 2 & 3; `followersOfOrganizer` (Task 1) returns `{ followerType, followerId }[]` consumed verbatim in Task 2; response shape `{ buyers, organizers }` identical across following/followers/search and the test assertions. ✅

## Execution Handoff

On completion, next is **SP1b-c** (block generalization + notifications + push as vendor), then **SP2** (DMs + realtime), then frontend **SP3/SP4**.
