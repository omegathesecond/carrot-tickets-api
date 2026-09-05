# Stall-Scoped POS — API Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope a stall's catalogue feed to the products it actually carries, give the organizer an explicit way to allocate products to stalls, and put the band UID on cashier transaction rows.

**Architecture:** Allocation needs no new model — a `ProductStock` row for `(merchantId, productId)` already means "this stall carries this product", because `StockService.adjust` upserts on receive and throws `StockDeclinedError` on a decrement with no row. This slice corrects the one place that disagreed (`MerchantController.stock`, which loaded every product at the event) and adds an endpoint that creates and removes zero-quantity rows deliberately.

**Tech Stack:** Node 20, TypeScript, Express, Mongoose, Joi, Jest + supertest + mongodb-memory-server (1-node replica set — the ledger routes use transactions).

**Spec:** `docs/superpowers/specs/2026-09-05-stall-scoped-pos-and-hardware-scanning-design.md`

**Worktree:** `carrot-tickets/api-stockgrant-wt`, branch `feat/stall-scoped-pos` (branched from `origin/main` @ `b223245`).

## Global Constraints

- **No silent fallbacks.** Every failure surfaces through the normal error channel. Never substitute a plausible default for a failed call.
- **No new models, no new fields, no index changes.** Allocation is the existence of a `ProductStock` row.
- **Money is integer cents; stock is whole base units.** Never floats.
- **Ownership is enforced by `loadOwnedEvent`** on organizer routes (super-admin bypasses) and by the merchant JWT's own `merchantId` on merchant routes. Never trust a body-supplied merchantId without checking it belongs to the event.
- **Response envelope is `ApiResponseUtil`**: `{ success, message, data, timestamp, path }`. Tests read `res.body.data`.
- **`bandUid` is nullable on `Wallet`** — a wallet may be bound to a ticket instead. Never fabricate one.
- **Run tests with the repo's own runner:** `npx jest <path> --runInBand`. The full suite is ~460 files and takes ~13 minutes; run only your task's files while iterating.
- **Never `git add -A`.** `node_modules` in these worktrees is a shared symlink. Stage named paths only. Never run `git clean`, or `git stash -u`.

---

### Task 1: A stall's catalogue feed lists only its allocated products

**Files:**
- Modify: `src/controllers/merchant.controller.ts` (the `stock` method)
- Test: `src/routes/__tests__/merchantStockScoping.route.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the scoped `GET /api/merchant/stock` behaviour that the POS slice relies on. Response shape is unchanged — `{ stock: [{ productId, name, price, barcode, category, imageUrl, unitLabel, unitsPerPack, packLabel, onHand, lowStockThreshold, status }] }`.

The current implementation loads `Product.find({ eventId, active: true })` — every product at the event — then left-joins this merchant's `ProductStock` rows for quantities, so a product the stall never carried comes back at `onHand: 0` instead of being absent.

- [ ] **Step 1: Write the failing test**

Create `src/routes/__tests__/merchantStockScoping.route.test.ts`:

```ts
// GET /api/merchant/stock must return ONLY products this stall carries — i.e.
// products with a ProductStock row for its merchantId. Before this task it
// returned every active product at the event with onHand 0, so the Shisanyama
// handheld listed the bar's spirits as sold-out tiles.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 940001;

const tokenFor = (merchantId: string, eventId: string, merchantOperatorId: string) =>
  jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId, operatorName: 'Nomsa Shongwe',
    eventId, name: 'Stall',
    permissions: [MerchantPermission.CHARGE],
  }, JWT_SECRET);

async function seedStall(eventId: string, name: string) {
  const merchant = await Merchant.create({ name, eventId });
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode: String(seq++), pin: '111111', grants: [OperatorGrant.MANAGE_STOCK],
  });
  return {
    merchantId: String(merchant._id),
    auth: `Bearer ${tokenFor(String(merchant._id), String(eventId), String(operator._id))}`,
  };
}

async function seedProduct(eventId: string, name: string) {
  const p = await Product.create({
    eventId, name, category: 'beer', price: 2500, unitLabel: 'unit', active: true,
  });
  return String(p._id);
}

/** Allocation IS a ProductStock row — that is the whole model. */
async function allocate(merchantId: string, productId: string, eventId: string, onHand = 0) {
  await ProductStock.create({ merchantId, productId, eventId, onHand });
}

it('returns only the products allocated to this stall', async () => {
  const { eventId } = await seedPublishedEvent({});
  const bar = await seedStall(String(eventId), 'Bar');
  const chicken = await seedProduct(String(eventId), 'Quarter Chicken');
  const beer = await seedProduct(String(eventId), 'Castle Lite 330ml');
  await allocate(bar.merchantId, beer, String(eventId), 12);

  const res = await request(app).get('/api/merchant/stock').set('Authorization', bar.auth);

  expect(res.status).toBe(200);
  expect(res.body.data.stock).toHaveLength(1);
  expect(res.body.data.stock[0].productId).toBe(beer);
  expect(res.body.data.stock[0].onHand).toBe(12);
  // The unallocated product must be ABSENT, not present at zero.
  expect(res.body.data.stock.map((s: { productId: string }) => s.productId)).not.toContain(chicken);
});

it('gives two stalls at one event disjoint catalogues', async () => {
  const { eventId } = await seedPublishedEvent({});
  const bar = await seedStall(String(eventId), 'Bar');
  const shisanyama = await seedStall(String(eventId), 'Shisanyama');
  const beer = await seedProduct(String(eventId), 'Castle Lite 330ml');
  const chicken = await seedProduct(String(eventId), 'Quarter Chicken');
  await allocate(bar.merchantId, beer, String(eventId), 5);
  await allocate(shisanyama.merchantId, chicken, String(eventId), 7);

  const barRes = await request(app).get('/api/merchant/stock').set('Authorization', bar.auth);
  const shiRes = await request(app).get('/api/merchant/stock').set('Authorization', shisanyama.auth);

  expect(barRes.body.data.stock.map((s: { name: string }) => s.name)).toEqual(['Castle Lite 330ml']);
  expect(shiRes.body.data.stock.map((s: { name: string }) => s.name)).toEqual(['Quarter Chicken']);
});

it('returns an empty list for a stall with no allocations, not the whole catalogue', async () => {
  const { eventId } = await seedPublishedEvent({});
  const stall = await seedStall(String(eventId), 'New Stall');
  await seedProduct(String(eventId), 'Castle Lite 330ml');

  const res = await request(app).get('/api/merchant/stock').set('Authorization', stall.auth);

  expect(res.status).toBe(200);
  expect(res.body.data.stock).toEqual([]);
});

it('still hides an inactive product even when it is allocated', async () => {
  const { eventId } = await seedPublishedEvent({});
  const stall = await seedStall(String(eventId), 'Bar');
  const beer = await seedProduct(String(eventId), 'Castle Lite 330ml');
  await Product.updateOne({ _id: beer }, { $set: { active: false } });
  await allocate(stall.merchantId, beer, String(eventId), 9);

  const res = await request(app).get('/api/merchant/stock').set('Authorization', stall.auth);

  expect(res.body.data.stock).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/routes/__tests__/merchantStockScoping.route.test.ts --runInBand`

Expected: the first three FAIL. The first reports `expect(received).toHaveLength(1)` with `Received length: 2` — both products come back because the feed is not scoped. The fourth already passes (`active: true` is already filtered); that is intentional — it is a regression guard, and it must keep passing.

- [ ] **Step 3: Invert the query so rows drive the product list**

In `src/controllers/merchant.controller.ts`, replace the first three lines of the `stock` method body:

```ts
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      const products = await Product.find({ eventId, active: true }).sort({ name: 1 }).lean();
      const rows = await ProductStock.find({ merchantId }).lean();
      const byProduct = new Map(rows.map((r) => [String(r.productId), r]));
```

with:

```ts
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      // A stall carries a product iff it has a ProductStock row for it — the
      // same rule StockService.adjust already enforces (it upserts on receive
      // and declines a decrement with no row). Loading every product at the
      // event and left-joining quantities made a stall's handheld list its
      // neighbours' items as permanent sold-out tiles.
      const rows = await ProductStock.find({ merchantId }).lean();
      const byProduct = new Map(rows.map((r) => [String(r.productId), r]));
      const products = await Product.find({
        eventId,
        active: true,
        _id: { $in: rows.map((r) => r.productId) },
      }).sort({ name: 1 }).lean();
```

Leave the rest of the method exactly as it is: the `map` that builds each row, the `status` rule, and the `ApiResponseUtil.success(res, { stock })` return are unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/routes/__tests__/merchantStockScoping.route.test.ts --runInBand`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the neighbouring suites that touch this feed**

Run: `npx jest src/routes/__tests__/merchantStockAccess.route.test.ts src/routes/__tests__/merchantStockWrite.route.test.ts src/routes/__tests__/merchantChargeItems.route.test.ts src/services/__tests__/merchantCharge.items.service.test.ts --runInBand`

Expected: PASS. If any fixture seeded a product without a `ProductStock` row and asserted it appeared in `/merchant/stock`, that assertion encoded the bug — update the fixture to allocate the product, and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/merchant.controller.ts src/routes/__tests__/merchantStockScoping.route.test.ts
git commit -m "fix(pos): a stall's catalogue lists only the products it carries"
```

---

### Task 2: Read and write a product's stall allocations

**Files:**
- Modify: `src/validators/stock.validator.ts` (add `allocationsSchema` after `thresholdSchema`, ~line 52)
- Modify: `src/controllers/stockAdmin.controller.ts` (add two static methods)
- Modify: `src/routes/tickets.route.ts` (add two routes beside the other `stock/` routes, ~line 666)
- Test: `src/routes/__tests__/stockAllocations.route.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's rule that a `ProductStock` row means "carried".
- Produces:
  - `GET /api/tickets/events/:eventId/stock/allocations` → `{ allocations: Record<string, string[]> }`, a map of `productId → merchantIds[]` covering every product at the event. A product with no stalls maps to `[]` and is still present as a key — the dashboard needs that to flag it.
  - `PUT /api/tickets/events/:eventId/stock/allocations` with body `{ productId: string, merchantIds: string[] }` → `{ allocated: string[] }` (the resulting stall ids, sorted).
  - Both gated by `TicketsPermission.MANAGE_STOCK`.

Deliberately a separate endpoint rather than an overload of `stock/receive` or `stock/threshold`: "this stall carries this" and "this stall received twelve" are different statements, and only the second is a stock movement that belongs in the ledger.

- [ ] **Step 1: Write the failing test**

Create `src/routes/__tests__/stockAllocations.route.test.ts`:

```ts
// Allocation = the existence of a ProductStock row. These routes let the
// organizer state it directly instead of having to receive stock to imply it.
// Harness mirrors stockAdmin.route.test.ts: signVendorToken + seedPublishedEvent.
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function ownedCashlessEvent() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  return { eventId: String(eventId), token };
}

const stall = async (eventId: string, name: string) =>
  String((await Merchant.create({ name, eventId }))._id);

const product = async (eventId: string, name: string) =>
  String((await Product.create({ eventId, name, category: 'beer', price: 2500, unitLabel: 'unit', active: true }))._id);

const put = (eventId: string, token: string, body: unknown) =>
  request(app).put(`/api/tickets/events/${eventId}/stock/allocations`)
    .set('Authorization', `Bearer ${token}`).send(body);

it('allocates a product to two stalls by creating zero-quantity rows', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const shi = await stall(eventId, 'Shisanyama');
  const beer = await product(eventId, 'Castle Lite 330ml');

  const res = await put(eventId, token, { productId: beer, merchantIds: [bar, shi] });

  expect(res.status).toBe(200);
  expect(res.body.data.allocated.sort()).toEqual([bar, shi].sort());
  const rows = await ProductStock.find({ productId: beer }).lean();
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.onHand === 0)).toBe(true);
});

it('is idempotent and never resets an existing quantity', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  await ProductStock.create({ merchantId: bar, productId: beer, eventId, onHand: 40 });

  const res = await put(eventId, token, { productId: beer, merchantIds: [bar] });

  expect(res.status).toBe(200);
  // Re-allocating a stall that already carries 40 must not zero it.
  expect((await ProductStock.findOne({ merchantId: bar, productId: beer }))!.onHand).toBe(40);
});

it('reports every product at the event, including one allocated to nobody', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  const orphan = await product(eventId, 'Quarter Chicken');
  await put(eventId, token, { productId: beer, merchantIds: [bar] });

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/allocations`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.data.allocations[beer]).toEqual([bar]);
  // Present as a key with an empty list — that is what lets the dashboard
  // flag "not on any stall" rather than silently omitting the product.
  expect(res.body.data.allocations[orphan]).toEqual([]);
});

it('refuses a stall belonging to a different event', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const other = await ownedCashlessEvent();
  const foreign = await stall(other.eventId, 'Someone Else Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');

  const res = await put(eventId, token, { productId: beer, merchantIds: [foreign] });

  expect(res.status).toBe(400);
  expect(await ProductStock.countDocuments({ productId: beer })).toBe(0);
});

it('refuses a product belonging to a different event', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const other = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const foreignProduct = await product(other.eventId, 'Not Ours');

  const res = await put(eventId, token, { productId: foreignProduct, merchantIds: [bar] });

  expect(res.status).toBe(400);
});

it('refuses an organizer who does not own the event', async () => {
  const { eventId } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  const intruder = signVendorToken('64b7c1f1f1f1f1f1f1f1f1f1', { permissions: [TicketsPermission.MANAGE_STOCK] });

  const res = await put(eventId, intruder, { productId: beer, merchantIds: [bar] });

  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/routes/__tests__/stockAllocations.route.test.ts --runInBand`
Expected: all FAIL with 404 — the routes do not exist yet.

- [ ] **Step 3: Add the validator**

In `src/validators/stock.validator.ts`, directly after `thresholdSchema`:

```ts
export const allocationsSchema = Joi.object({
  productId: objectId.required(),
  // An empty array is legal and meaningful: it delists the product from every
  // stall. Task 3 is what stops that from silently discarding held stock.
  merchantIds: Joi.array().items(objectId).required(),
});
```

- [ ] **Step 4: Add the controller methods**

In `src/controllers/stockAdmin.controller.ts`, add `allocationsSchema` to the existing import from `@validators/stock.validator`, add `ProductStock` to the model imports if absent, and add these two methods to the class:

```ts
  /** GET /api/tickets/events/:eventId/stock/allocations */
  static async listAllocations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const products = await Product.find({ eventId: event._id }, { _id: 1 }).lean();
      const rows = await ProductStock.find(
        { productId: { $in: products.map((p) => p._id) } },
        { productId: 1, merchantId: 1 },
      ).lean();
      // Every product gets a key, even with no stalls — the dashboard needs the
      // empty list to flag "not on any stall" rather than infer it from absence.
      const allocations: Record<string, string[]> = {};
      for (const p of products) allocations[String(p._id)] = [];
      for (const r of rows) allocations[String(r.productId)]?.push(String(r.merchantId));
      ApiResponseUtil.success(res, { allocations });
    } catch (err) { next(err); }
  }

  /** PUT /api/tickets/events/:eventId/stock/allocations */
  static async setAllocations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = allocationsSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }

      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) {
        ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return;
      }
      const wanted: string[] = [...new Set<string>(value.merchantIds.map(String))];
      if (wanted.length) {
        const merchants = await Merchant.find(
          { _id: { $in: wanted }, eventId: event._id }, { _id: 1 },
        ).lean();
        if (merchants.length !== wanted.length) {
          ApiResponseUtil.badRequest(res, 'one or more stalls do not belong to this event'); return;
        }
      }

      const existing = await ProductStock.find({ productId: product._id }).lean();
      const have = new Set(existing.map((r) => String(r.merchantId)));
      const want = new Set(wanted);

      // Task 3 fills this in. Removing a row that still holds stock would
      // discard inventory the movement ledger still accounts for.
      const toRemove = existing.filter((r) => !want.has(String(r.merchantId)));

      for (const merchantId of wanted) {
        if (have.has(merchantId)) continue; // never touch an existing quantity
        await ProductStock.create({
          merchantId, productId: product._id, eventId: event._id, onHand: 0,
        });
      }
      if (toRemove.length) {
        await ProductStock.deleteMany({ _id: { $in: toRemove.map((r) => r._id) } });
      }

      ApiResponseUtil.success(res, { allocated: wanted.sort() });
    } catch (err) { next(err); }
  }
```

- [ ] **Step 5: Add the routes**

In `src/routes/tickets.route.ts`, immediately after the `stock/count` route (~line 668):

```ts
router.get('/events/:eventId/stock/allocations', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.listAllocations);
router.put('/events/:eventId/stock/allocations', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.setAllocations);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/routes/__tests__/stockAllocations.route.test.ts --runInBand`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/validators/stock.validator.ts src/controllers/stockAdmin.controller.ts src/routes/tickets.route.ts src/routes/__tests__/stockAllocations.route.test.ts
git commit -m "feat(stock): read and write a product's stall allocations"
```

---

### Task 3: Delisting a stall that still holds stock is refused

**Files:**
- Modify: `src/controllers/stockAdmin.controller.ts` (the `setAllocations` method from Task 2)
- Test: `src/routes/__tests__/stockAllocations.route.test.ts` (append)

**Interfaces:**
- Consumes: `PUT /api/tickets/events/:eventId/stock/allocations` from Task 2, including its `toRemove` list.
- Produces: a 400 whose message names each stall and its quantity, and leaves every row intact.

Task 2 deletes any row not in the new list. For a stall holding `onHand: 0` that is correct — nothing is lost. For a stall holding 12 units it would delete inventory that `StockMovement` still accounts for, turning the reconciliation report inconsistent with no trace.

- [ ] **Step 1: Write the failing test**

Append to `src/routes/__tests__/stockAllocations.route.test.ts`:

```ts
it('refuses to delist a stall that still holds stock, naming it and the quantity', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  await ProductStock.create({ merchantId: bar, productId: beer, eventId, onHand: 12 });

  const res = await put(eventId, token, { productId: beer, merchantIds: [] });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('Bar');
  expect(res.body.error).toContain('12');
  // Nothing removed: the row and its stock survive the refusal intact.
  expect((await ProductStock.findOne({ merchantId: bar, productId: beer }))!.onHand).toBe(12);
});

it('allows delisting a stall holding nothing', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  await ProductStock.create({ merchantId: bar, productId: beer, eventId, onHand: 0 });

  const res = await put(eventId, token, { productId: beer, merchantIds: [] });

  expect(res.status).toBe(200);
  expect(res.body.data.allocated).toEqual([]);
  expect(await ProductStock.countDocuments({ productId: beer })).toBe(0);
});

it('refuses the whole request when one of several delisted stalls holds stock', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const shi = await stall(eventId, 'Shisanyama');
  const beer = await product(eventId, 'Castle Lite 330ml');
  await ProductStock.create({ merchantId: bar, productId: beer, eventId, onHand: 0 });
  await ProductStock.create({ merchantId: shi, productId: beer, eventId, onHand: 3 });

  const res = await put(eventId, token, { productId: beer, merchantIds: [] });

  expect(res.status).toBe(400);
  // All-or-nothing: the empty-handed stall must not be delisted either, or a
  // retry after writing off the 3 would silently leave the catalogue changed.
  expect(await ProductStock.countDocuments({ productId: beer })).toBe(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/routes/__tests__/stockAllocations.route.test.ts -t "delist" --runInBand`

Expected: the first FAILS with `expect(received).toBe(400)` / `Received: 200` — Task 2 deletes the row regardless of quantity. The second already passes. The third FAILS on the document count.

- [ ] **Step 3: Refuse before writing anything**

In `setAllocations`, replace the `toRemove` block and its comment:

```ts
      // Task 3 fills this in. Removing a row that still holds stock would
      // discard inventory the movement ledger still accounts for.
      const toRemove = existing.filter((r) => !want.has(String(r.merchantId)));
```

with:

```ts
      const toRemove = existing.filter((r) => !want.has(String(r.merchantId)));
      // Deleting a row that still holds stock would discard inventory the
      // StockMovement ledger still accounts for, silently desyncing the
      // reconciliation report. Refuse the WHOLE request rather than delisting
      // the empty stalls and rejecting the rest — a partial apply would leave
      // the catalogue changed in a way the caller never asked for.
      const held = toRemove.filter((r) => (r.onHand ?? 0) > 0);
      if (held.length) {
        const names = await Merchant.find(
          { _id: { $in: held.map((r) => r.merchantId) } }, { name: 1 },
        ).lean();
        const byId = new Map(names.map((m) => [String(m._id), m.name]));
        const detail = held
          .map((r) => `${byId.get(String(r.merchantId)) ?? 'stall'} (${r.onHand})`)
          .join(', ');
        ApiResponseUtil.badRequest(
          res,
          `Cannot remove a stall that still holds stock: ${detail}. Transfer or write it off first.`,
        );
        return;
      }
```

This block must sit **before** the `for (const merchantId of wanted)` create loop, so a refusal writes nothing at all.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/routes/__tests__/stockAllocations.route.test.ts --runInBand`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/stockAdmin.controller.ts src/routes/__tests__/stockAllocations.route.test.ts
git commit -m "feat(stock): refuse to delist a stall that still holds stock"
```

---

### Task 4: Cashier transaction rows carry the band UID

**Files:**
- Modify: `src/services/cashier.service.ts` (the `listTransactions` method)
- Test: `src/services/__tests__/cashierTxnBandUid.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CashierTxn` gains `bandUid: string | null`. The POS slice parses this field. Every other field keeps its name and type.

`listTransactions` builds rows from `WalletTopup` and `WalletWithdrawal`, which carry `walletId` and no band identity, so the cashier's History cannot say which band a top-up belongs to. `bandUid` lives on `Wallet` and is **nullable** — a wallet may be bound to a ticket instead — so the field is nullable end to end.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/cashierTxnBandUid.test.ts`:

```ts
// A cashier's History row must say WHICH band it was. bandUid lives on Wallet,
// not on WalletTopup/WalletWithdrawal, so listTransactions has to join — and
// it must stay null (never a placeholder) for a ticket-bound wallet.
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { CashierService } from '@services/cashier.service';
import { Wallet } from '@models/wallet.model';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const CASHIER = 'cashier-1';

async function bandWallet(eventId: string, bandUid: string) {
  return String((await Wallet.create({ eventId, bandUid, balance: 0, status: 'active' }))._id);
}

it('carries the band UID of the wallet each top-up belongs to', async () => {
  const { eventId } = await seedPublishedEvent({});
  const walletId = await bandWallet(String(eventId), '04A2B3C4D5E6F7');
  await WalletTopup.create({
    walletId, eventId, amount: 5000, method: 'cash', status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'a-1',
  });

  const { transactions } = await CashierService.listTransactions({ cashierId: CASHIER });

  expect(transactions).toHaveLength(1);
  expect(transactions[0]!.bandUid).toBe('04A2B3C4D5E6F7');
});

it('carries the band UID on withdrawals too', async () => {
  const { eventId } = await seedPublishedEvent({});
  const walletId = await bandWallet(String(eventId), '04FFEEDDCCBBAA');
  await WalletWithdrawal.create({
    walletId, eventId, amount: 1500, status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'w-1',
  });

  const { transactions } = await CashierService.listTransactions({ cashierId: CASHIER });

  expect(transactions[0]!.bandUid).toBe('04FFEEDDCCBBAA');
});

it('reports null — never a placeholder — for a ticket-bound wallet', async () => {
  const { eventId } = await seedPublishedEvent({});
  const walletId = String((await Wallet.create({
    eventId, bandUid: null, balance: 0, status: 'active',
  }))._id);
  await WalletTopup.create({
    walletId, eventId, amount: 2000, method: 'cash', status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'a-2',
  });

  const { transactions } = await CashierService.listTransactions({ cashierId: CASHIER });

  expect(transactions[0]!.bandUid).toBeNull();
});

it('maps each row to its own band when a cashier served several', async () => {
  const { eventId } = await seedPublishedEvent({});
  const first = await bandWallet(String(eventId), 'AAAA1111');
  const second = await bandWallet(String(eventId), 'BBBB2222');
  await WalletTopup.create({
    walletId: first, eventId, amount: 1000, method: 'cash', status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'a-3',
  });
  await WalletTopup.create({
    walletId: second, eventId, amount: 2000, method: 'cash', status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'a-4',
  });

  const { transactions } = await CashierService.listTransactions({ cashierId: CASHIER });

  const byAmount = new Map(transactions.map((t) => [t.amount, t.bandUid]));
  expect(byAmount.get(1000)).toBe('AAAA1111');
  expect(byAmount.get(2000)).toBe('BBBB2222');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/services/__tests__/cashierTxnBandUid.test.ts --runInBand`
Expected: FAIL — TypeScript reports `bandUid` does not exist on `CashierTxn`, or the assertions receive `undefined`.

- [ ] **Step 3: Add `bandUid` to the interface**

Find the `CashierTxn` type used by `CashierService.listTransactions` (it is declared alongside the service or in `@interfaces/cashier.interface`; follow the import). Add:

```ts
  /** The band this row's wallet belongs to. Null when the wallet is bound to a
   *  ticket instead of a band — Wallet.bandUid is nullable, and inventing a
   *  value here would put a fake identifier on a real receipt. */
  bandUid: string | null;
```

- [ ] **Step 4: Join the wallets in `listTransactions`**

In `src/services/cashier.service.ts`, after the `Promise.all` that loads `topups` and `withdrawals` and before the `transactions` array is built, insert:

```ts
    // WalletTopup/WalletWithdrawal carry only walletId; the band identity lives
    // on Wallet. One batched lookup over the wallets we just referenced — not a
    // per-row query.
    const walletIds = [...new Set([
      ...topups.map((t) => String(t.walletId)),
      ...withdrawals.map((w) => String(w.walletId)),
    ])];
    const wallets = await Wallet.find({ _id: { $in: walletIds } }, { bandUid: 1 }).lean();
    const bandByWallet = new Map(wallets.map((w) => [String(w._id), w.bandUid ?? null]));
```

Then add `bandUid` to both mappers:

```ts
      ...topups.map((t) => ({ id: String(t._id), type: 'topup' as const, amount: t.amount, status: t.status, at: t.createdAt, bandUid: bandByWallet.get(String(t.walletId)) ?? null })),
      ...withdrawals.map((w) => ({ id: String(w._id), type: 'withdrawal' as const, amount: w.amount, status: w.status, at: w.createdAt, bandUid: bandByWallet.get(String(w.walletId)) ?? null })),
```

Add `import { Wallet } from '@models/wallet.model';` if it is not already imported. The `summary` block is unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/services/__tests__/cashierTxnBandUid.test.ts --runInBand`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the cashier route suites**

Run: `npx jest src/routes/__tests__/cashier --runInBand`
Expected: PASS. The added field is additive, so no existing assertion should move.

- [ ] **Step 7: Commit**

```bash
git add src/services/cashier.service.ts src/services/__tests__/cashierTxnBandUid.test.ts
git commit -m "feat(cashier): carry the band UID on transaction rows"
```

---

## Verification before handing off

- [ ] `npx tsc --noEmit` is clean.
- [ ] `npx jest --runInBand` — full suite green. Baseline is 455 files / 2696 tests; this slice adds 3 files. A SIGSEGV'd worker is a known flake — re-run before reporting a failure.
- [ ] `GET /api/merchant/stock` returns `{ stock: [] }` for a stall with no allocations, and the POS slice's empty state is what an operator sees.

**Do not deploy this slice on its own during a live event.** The moment it serves traffic, every stall's POS lists only what it has been allocated — which, for products that were never received anywhere, is nothing. The dashboard slice's "Allocate to all stalls" action is what restores the catalogue, and it has to be available and used immediately after.
