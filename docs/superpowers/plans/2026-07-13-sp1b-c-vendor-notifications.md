# SP1b-c — Vendor Notifications Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the organizer brand a notifications inbox — starting with "someone started following your brand" — so the brand learns of social activity. Ships "dark" (no UI until SP3/SP4).

**Architecture:** Generalize `Notification` with a `recipientType` discriminator (default `'buyer'`, migration-safe — same pattern as `UpdateReaction.actorType` / `Follow.followerType`) and make `NotificationService.list`/`markRead`/`create` recipient-actor-aware. Add a `'follow'` notification type and fire it (inbox-only, no push) when a buyer OR brand follows an organizer. Expose a vendor inbox at `/api/tickets/social/notifications`. Web push for vendors is out of scope (browser push is buyer-centric; the inbox row is the durable record).

**Tech Stack:** Node/TypeScript, Express, Mongoose 7, Jest + supertest + mongodb-memory-server.

## Global Constraints

- **Umbrella spec:** `docs/superpowers/specs/2026-07-13-organizer-social-shell-design.md`. This is **SP1b-c** (notifications inbox). SP1b-d = block. SP2 = DMs + realtime.
- **Additive & migration-safe:** `Notification.recipientType` default `'buyer'`; `recipientId` not renamed. **Extend the existing backfill** `src/scripts/backfillSocialActorTypes.ts` to also stamp `Notification.recipientType='buyer'` on legacy rows, and its runbook applies here too (backfill BEFORE deploying this code — the new reads query `{recipientType:'buyer', …}` which misses null legacy rows).
- **Preserve the buyer path:** existing buyer notification endpoints (`/api/social/notifications`) and the `NotificationDispatcher` push path stay behavior-identical. Buyer callers of `NotificationService.list`/`markRead`/`create` must keep working (new `recipientType` param defaults to `'buyer'`).
- **Inbox-only for vendors:** the follow trigger writes a vendor inbox row via `NotificationService.create` directly (no push, no dispatcher) — vendor web-push is a later slice.
- **Vendor actor = the brand:** `req.ticketsUser.vendorId`; routes `authenticateTickets`, 401 if absent.
- **Fail loud, no fake data.** YAGNI. TDD. Commit per task. Full suite before final commit.
- **Known-flaky:** `social.route.test.ts` username test flakes intermittently even in isolation (pre-existing, unrelated).

## File Structure

- **Modify** `src/models/notification.model.ts` — add `recipientType` (default `'buyer'`); add `'follow'` to `NotificationType`.
- **Modify** `src/services/notification.service.ts` — `create`/`list`/`markRead` take a recipient `(recipientType, recipientId)`.
- **Modify** `src/controllers/socialProfile.controller.ts` — buyer callers pass `'buyer'`.
- **Modify** `src/services/follow.service.ts` — fire a `'follow'` notification to the target vendor on organizer-follows.
- **Create** `src/controllers/` additions in `vendorSocial.controller.ts` — `notifications`, `markNotificationsRead`.
- **Modify** `src/routes/vendorSocial.route.ts` — two routes.
- **Modify** `src/scripts/backfillSocialActorTypes.ts` — add Notification backfill.

---

### Task 1: Generalize `Notification` + `NotificationService` to a recipient actor

**Files:**
- Modify: `src/models/notification.model.ts`
- Modify: `src/services/notification.service.ts`
- Modify: `src/controllers/socialProfile.controller.ts` (two buyer call sites)
- Modify (test): `src/services/__tests__/notification.service.test.ts` — **check if it exists**; if so add cases inside its describe, else create. Also `src/models/__tests__/notification.model.test.ts` similarly.

**Interfaces:**
- Produces: `NotificationRecipientType = 'buyer' | 'vendor'`; `INotification.recipientType` (default `'buyer'`); `NotificationType` gains `'follow'`.
- Produces:
  - `NotificationService.create(recipientType, recipientId, type, title, body, data): Promise<INotification | null>`
  - `NotificationService.list(recipientType, recipientId, opts): Promise<{ items, unreadCount }>`
  - `NotificationService.markRead(recipientType, recipientId, ids?): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Model test — add to (or create) `src/models/__tests__/notification.model.test.ts`:

```ts
import mongoose from 'mongoose';
import { Notification } from '@models/notification.model';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

describe('Notification recipientType', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('defaults recipientType to buyer and accepts the follow type', async () => {
    const n = await Notification.create({ recipientId: new mongoose.Types.ObjectId(), type: 'follow', title: 'New follower', body: 'x', data: {} });
    expect(n.recipientType).toBe('buyer');
    expect(n.type).toBe('follow');
  });

  it('stores a vendor recipient', async () => {
    const n = await Notification.create({ recipientId: new mongoose.Types.ObjectId(), recipientType: 'vendor', type: 'follow', title: 'x', body: 'y', data: {} });
    expect(n.recipientType).toBe('vendor');
  });
});
```

Service test — add to (or create) `src/services/__tests__/notification.service.test.ts`:

```ts
import mongoose from 'mongoose';
import { NotificationService } from '@services/notification.service';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

describe('NotificationService recipient-actor', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lists/marks a vendor recipient independently of a buyer with the same id', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    await NotificationService.create('vendor', id, 'follow', 'New follower', 'A followed you', {});
    await NotificationService.create('buyer', id, 'follow', 'buyer one', 'x', {});

    const vendorInbox = await NotificationService.list('vendor', id, {});
    expect(vendorInbox.items).toHaveLength(1);
    expect(vendorInbox.unreadCount).toBe(1);
    expect(vendorInbox.items[0].title).toBe('New follower');

    await NotificationService.markRead('vendor', id);
    const after = await NotificationService.list('vendor', id, {});
    expect(after.unreadCount).toBe(0);
    // buyer inbox untouched
    expect((await NotificationService.list('buyer', id, {})).unreadCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- notification.model.test notification.service.test` → FAIL (`recipientType` undefined / `list` signature).

- [ ] **Step 3: Write minimal implementation**

`src/models/notification.model.ts`: add `'follow'` to the `NotificationType` union AND the schema enum; add to the interface `recipientType: NotificationRecipientType;` and export `export type NotificationRecipientType = 'buyer' | 'vendor';`; add schema field `recipientType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' }`. Update the two `recipientId`-leading indexes to lead with `recipientType` then `recipientId` (so vendor/buyer inboxes don't share a key): change `{ recipientId: 1, _id: -1 }` → `{ recipientType: 1, recipientId: 1, _id: -1 }` and `{ recipientId: 1, readAt: 1 }` → `{ recipientType: 1, recipientId: 1, readAt: 1 }`. Leave the partial event_reminder unique index unchanged.

`src/services/notification.service.ts`: change signatures — `create(recipientType, recipientId, type, title, body, data)` sets `recipientType` on the created doc; `list(recipientType, recipientId, opts)` queries `{ recipientType, recipientId }`; `markRead(recipientType, recipientId, ids?)` scopes to `{ recipientType, recipientId, … }`. Import `NotificationRecipientType`. Keep the empty-ids-is-no-op and reminder-dedupe semantics identical. Drop the `IBuyer` import if now unused.

`src/controllers/socialProfile.controller.ts`: update the two call sites — `NotificationService.list(buyer, { … })` → `NotificationService.list('buyer', String(buyer._id), { … })`; `NotificationService.markRead(buyer, ids)` → `NotificationService.markRead('buyer', String(buyer._id), ids)`.

`src/services/notificationDispatcher.service.ts`: its `NotificationService.create(id, type, title, body, data)` calls must become `NotificationService.create('buyer', id, type, title, body, data)` (dispatcher recipients are buyers). Update each call site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- notification.model.test notification.service.test` → PASS. Then `npm test -- social.route notification` and `npx tsc --noEmit` → buyer notification behavior unchanged, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/models/notification.model.ts src/services/notification.service.ts src/controllers/socialProfile.controller.ts src/services/notificationDispatcher.service.ts src/models/__tests__/notification.model.test.ts src/services/__tests__/notification.service.test.ts
git commit -m "feat(social): recipientType on Notification + follow type; NotificationService recipient-actor-aware"
```

---

### Task 2: Notify the brand when someone follows it

**Files:**
- Modify: `src/services/follow.service.ts`
- Modify (test): `src/services/__tests__/follow.service.test.ts` (add cases inside the existing `describe('FollowService', …)`).

**Interfaces:**
- Consumes: `NotificationService.create`, `Buyer`, `Vendor`.
- Behavior: when a follow edge to `targetType === 'organizer'` is newly created, write a `'follow'` inbox row for the target vendor: title `'New follower'`, body `` `${name} started following you` ``, data `{ followerType, followerId }`. Buyer follower name = `username ?? name ?? 'Someone'`; vendor follower name = `businessName`. Never throws into the follow path (best-effort, but surfaced via console on error — matches the dispatcher's per-recipient isolation).

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('FollowService', …)` in `src/services/__tests__/follow.service.test.ts`:

```ts
  it('notifies the brand when a buyer follows it', async () => {
    const brand = await makeVendor();
    const buyer = await seedBuyer('+26878000901');
    await FollowService.follow(buyer, 'organizer', String(brand._id));

    const { NotificationService } = await import('@services/notification.service');
    const inbox = await NotificationService.list('vendor', String(brand._id), {});
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].type).toBe('follow');
    expect(inbox.items[0].body).toMatch(/started following you/);
  });

  it('notifies the brand when another brand follows it', async () => {
    const brand = await makeVendor();
    const follower = await makeVendor();
    await FollowService.followAsVendor(String(follower._id), 'organizer', String(brand._id));

    const { NotificationService } = await import('@services/notification.service');
    const inbox = await NotificationService.list('vendor', String(brand._id), {});
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].body).toContain(String(follower.businessName));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- follow.service.test` → FAIL (no notification created).

- [ ] **Step 3: Write minimal implementation**

In `src/services/follow.service.ts`, add a private helper and call it from `follow`/`followAsVendor` after a successful `createEdge` when `targetType === 'organizer'`:

```ts
  /** Best-effort: tell a brand it gained a follower. Never throws into the follow path. */
  private static async notifyOrganizerFollowed(vendorId: string, followerType: FollowerType, followerId: string): Promise<void> {
    try {
      let name = 'Someone';
      if (followerType === 'buyer') {
        const b = await Buyer.findById(followerId).select('username name');
        name = b?.username ?? b?.name ?? 'Someone';
      } else {
        const v = await Vendor.findById(followerId).select('businessName');
        name = v?.businessName ?? 'A brand';
      }
      await NotificationService.create('vendor', vendorId, 'follow', 'New follower', `${name} started following you`, { followerType, followerId });
    } catch (err: any) {
      console.error(`[follow] notify organizer ${vendorId} failed:`, err?.message);
    }
  }
```

Wire it: in `follow(buyer, …)`, after `const created = await …createEdge('buyer', …)`, add `if (created && targetType === 'organizer') await FollowService.notifyOrganizerFollowed(targetId, 'buyer', String(buyer._id));`. In `followAsVendor`, capture the `createEdge` return (change it to `const created = await …createEdge('vendor', …)`) and `if (created && targetType === 'organizer') await FollowService.notifyOrganizerFollowed(targetId, 'vendor', String(vendorId));`. Add the import: `import { NotificationService } from '@services/notification.service';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- follow.service.test` → PASS (existing + 2 new). `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/follow.service.ts src/services/__tests__/follow.service.test.ts
git commit -m "feat(social): notify a brand's inbox when a buyer or brand follows it"
```

---

### Task 3: Vendor notification endpoints

**Files:**
- Modify: `src/controllers/vendorSocial.controller.ts`
- Modify: `src/routes/vendorSocial.route.ts`
- Test: `src/routes/__tests__/vendorNotifications.route.test.ts`

**Interfaces:**
- Produces routes (`authenticateTickets`): `GET /api/tickets/social/notifications?before=&limit=` → `{ items, unreadCount }`; `POST /api/tickets/social/notifications/read` body `{ ids?: string[] }` → `{ read: true }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorNotifications.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

describe('/api/tickets/social/notifications (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lists follow notifications and marks them read', async () => {
    const brand = await Vendor.create({ businessName: 'Notif Brand', email: 'notif@example.com', phoneNumber: '+26878001001', password: 'secret123' });
    const buyer = await Buyer.create({ phone: '+26878001002', password: 'secret1', name: 'Fan', username: 'fan_one' });
    const brandToken = `Bearer ${signVendorToken(String(brand._id))}`;

    await request(app).post('/api/social/follow').set('Authorization', `Bearer ${signBuyerToken('+26878001002')}`).send({ targetType: 'organizer', targetId: String(brand._id) }).expect(200);

    const list = await request(app).get('/api/tickets/social/notifications').set('Authorization', brandToken).expect(200);
    expect(list.body.data.unreadCount).toBe(1);
    expect(list.body.data.items[0].type).toBe('follow');

    await request(app).post('/api/tickets/social/notifications/read').set('Authorization', brandToken).send({}).expect(200);
    const after = await request(app).get('/api/tickets/social/notifications').set('Authorization', brandToken).expect(200);
    expect(after.body.data.unreadCount).toBe(0);
  });

  it('401s a buyer token', async () => {
    await request(app).get('/api/tickets/social/notifications').set('Authorization', `Bearer ${signBuyerToken('+26878001002')}`).expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- vendorNotifications.route.test` → FAIL (404).

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/vendorSocial.controller.ts` (import `NotificationService` from `@services/notification.service`; `HEX24` from `@utils/controllerHelpers.util`):

```ts
  /** GET /api/tickets/social/notifications?before=&limit= */
  static async notifications(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const before = req.query['before'] ? String(req.query['before']) : undefined;
      if (before !== undefined && !HEX24.test(before)) return ApiResponseUtil.error(res, 'before must be a notification id', 400);
      const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
      const result = await NotificationService.list('vendor', vendorId, { before, limit });
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load notifications');
    }
  }

  /** POST /api/tickets/social/notifications/read { ids?: string[] } */
  static async markNotificationsRead(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const ids = req.body?.ids;
      if (ids !== undefined && (!Array.isArray(ids) || !ids.every((i: unknown) => typeof i === 'string' && HEX24.test(i)))) {
        return ApiResponseUtil.error(res, 'ids must be an array of notification ids', 400);
      }
      await NotificationService.markRead('vendor', vendorId, ids);
      return ApiResponseUtil.success(res, { read: true }, 'Notifications marked read');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark notifications read');
    }
  }
```

Add to `src/routes/vendorSocial.route.ts`:

```ts
router.get('/notifications', authenticateTickets, VendorSocialController.notifications);
router.post('/notifications/read', authenticateTickets, VendorSocialController.markNotificationsRead);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- vendorNotifications.route.test` → PASS. `npx tsc --noEmit` + `npx eslint` on changed files → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/vendorSocial.controller.ts src/routes/vendorSocial.route.ts src/routes/__tests__/vendorNotifications.route.test.ts
git commit -m "feat(social): vendor notifications inbox endpoints"
```

---

### Task 4: Extend backfill + integration + full suite

**Files:**
- Modify: `src/scripts/backfillSocialActorTypes.ts` (+ its test)
- Test: `src/routes/__tests__/vendorNotifications.integration.test.ts` (covered by Task 3's route test; this task focuses on backfill + full suite)

**Interfaces:** `backfillSocialActorTypes()` returns `{ follows, reactions, notifications }` (add `notifications`).

- [ ] **Step 1: Extend the backfill + its test**

In `src/scripts/backfillSocialActorTypes.ts`: add `Notification.updateMany({ recipientType: { $exists: false } }, { $set: { recipientType: 'buyer' } })`, import `Notification`, add `notifications: <modifiedCount>` to the returned object and to its TS return type, and update the runner's log line. In `src/scripts/__tests__/backfillSocialActorTypes.test.ts`: insert a legacy-shaped Notification via `Notification.collection.insertOne({ recipientId: new mongoose.Types.ObjectId(), type: 'follow', title: 't', body: 'b', data: {}, createdAt: new Date(), updatedAt: new Date() })` (no recipientType), assert `{ recipientType: 'buyer' }` matches 0 before / 1 after, and `notifications >= 1`.

- [ ] **Step 2: Run backfill test**

Run: `npm test -- backfillSocialActorTypes` → PASS (legacy Notification row backfilled + idempotent).

- [ ] **Step 3: Full suite + tsc**

Run: `npx tsc --noEmit` → 0 errors. Run: `npm test 2>&1 | tail -40`; expect green except the known `social.route.test.ts` flake; re-run any failing suite in isolation and record.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/backfillSocialActorTypes.ts src/scripts/__tests__/backfillSocialActorTypes.test.ts
git commit -m "test(social): backfill Notification.recipientType + full-suite green for vendor notifications"
```

---

## Self-Review

**1. Spec coverage:** Notification recipient generalization → Task 1; follow-brand trigger → Task 2; vendor inbox endpoints → Task 3; backfill + suite → Task 4. Vendor web-push deferred (documented). ✅
**2. Placeholder scan:** complete code / concrete edits throughout. ✅
**3. Type consistency:** `NotificationService.create/list/markRead('vendor'|'buyer', id, …)` used identically in the trigger (Task 2) and endpoints (Task 3); `'follow'` type added in Task 1 and asserted in Tasks 2–3; backfill return shape extended in Task 4. ✅

## Execution Handoff

Next: **SP1b-d** (block: generalize `Block` like the others + block-filter search/lists), then **SP2** (DMs + realtime), then frontend **SP3/SP4**, then **SP5** (SSO).
