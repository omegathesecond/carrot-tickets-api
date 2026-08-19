# Cashless Stock — Slice 3: Transfers, Counts & Low-Stock Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bar-to-bar stock transfers, physical counts (with variance), and low-stock organizer alerts — all composing Slice 1's sole-writer `StockService.applyMovement`, and firing the alert off the money path.

**Architecture:** Two new models (`StockTransfer`, `StockCount`) + services that wrap `applyMovement` in a transaction (a transfer = `TRANSFER_OUT`+`TRANSFER_IN`; a count = one `COUNT_ADJUST`). A `StockAlertService` arms/fires a `low_stock` vendor notification (best-effort, post-commit) and re-arms on replenish. Organizer endpoints under `/api/tickets`; POS stock read + count under `/api/merchant` (reusing `CHARGE`).

**Tech Stack:** Node + TS, Express, Mongoose (replica set for transactions), Joi, Jest + `mongodb-memory-server`. Aliases `@models/* @services/* @interfaces/* @controllers/* @validators/* @middleware/* @utils/*`.

## Global Constraints

- **Base branch:** `feat/cashless-stock-transfers` off `feat/cashless-cashier` @5160fbb (Slices 1+2 merged), fresh worktree. Merge onto the cashless line, not `main`.
- **Sole writer:** all `onHand`/`StockMovement` changes go through `StockService.applyMovement`. Transfers/counts pass its optional `session` to stay atomic (it throws if the session isn't already in a transaction). `lowStockThreshold`/`lowStockAlertedAt` are NOT journal fields — write them with a direct `ProductStock.updateOne`.
- **Alert is best-effort, off the money path:** `StockAlertService.evaluateAfterSale` is fired **after** the charge returns, fire-and-forget (`.catch(console.error)`); it must never throw into the sale. A failed notification is logged loudly, never silently swallowed, and never rolls back a sale. The `MerchantService.charge` transaction is NOT modified.
- **Notification to organizer:** `NotificationService.create('vendor', String(event.vendorId), 'low_stock', title, body, data)` — a pure best-effort DB insert (no session, no push).
- **Adding `low_stock` type touches THREE spots** or it won't compile: the `NotificationType` union + the schema `type` enum (`src/models/notification.model.ts`) AND `NotificationDispatcher.PREF_BY_TYPE` (`src/services/notificationDispatcher.service.ts`, the exhaustive `Record<NotificationType,…>`).
- **Ownership:** organizer endpoints use `requireTicketsPermission(TicketsPermission.MANAGE_STOCK)` + the existing `loadOwnedEvent` helper (re-verify each `merchant.eventId`/`product.eventId === event._id`). POS endpoints use `authenticateMerchant` + `requireMerchantPermission(MerchantPermission.CHARGE)`; identity (`merchantId`,`eventId`) comes ONLY from the JWT.
- **Fail loudly:** transfer/count declines are real 4xx (409 for insufficient source stock, 400 for bad request); no silent fallbacks. Stock in integer base units.

---

### Task 1: Low-stock alert infrastructure (`low_stock` type + `StockAlertService` + threshold endpoint)

**Files:**
- Modify: `src/models/notification.model.ts`, `src/services/notificationDispatcher.service.ts`
- Create: `src/services/stockAlert.service.ts`
- Modify: `src/validators/stock.validator.ts` (add `thresholdSchema`), `src/controllers/stockAdmin.controller.ts` (add `setThreshold`), `src/routes/tickets.route.ts` (mount PATCH)
- Test: `src/services/__tests__/stockAlert.service.test.ts`, `src/routes/__tests__/stockThreshold.route.test.ts`

**Interfaces:**
- Produces: `NotificationType` includes `'low_stock'`; `StockAlertService.evaluateAfterSale({eventId, vendorId, merchantId, productIds})` and `StockAlertService.rearm(merchantId, productId)` (both best-effort, never throw); `PATCH /api/tickets/events/:eventId/stock/threshold`.

- [ ] **Step 1: Write the failing StockAlertService test**

```typescript
// src/services/__tests__/stockAlert.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockAlertService } from '@services/stockAlert.service';
import { ProductStock } from '@models/productStock.model';
import { Notification } from '@models/notification.model';

const eventId = new mongoose.Types.ObjectId();
const vendorId = new mongoose.Types.ObjectId();
const merchantId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();

async function stock(onHand: number, lowStockThreshold: number | null, lowStockAlertedAt: Date | null = null) {
  await ProductStock.create({ eventId, merchantId, productId, onHand, lowStockThreshold, lowStockAlertedAt });
}

describe('StockAlertService', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('fires exactly one low_stock vendor notification when onHand crosses <= threshold', async () => {
    await stock(5, 20);
    await StockAlertService.evaluateAfterSale({ eventId: String(eventId), vendorId: String(vendorId), merchantId: String(merchantId), productIds: [String(productId)] });
    const notes = await Notification.find({ recipientType: 'vendor', recipientId: vendorId, type: 'low_stock' });
    expect(notes).toHaveLength(1);
    // armed: lowStockAlertedAt now set
    expect((await ProductStock.findOne({ merchantId, productId }))!.lowStockAlertedAt).not.toBeNull();

    // a second evaluation while still armed fires nothing more
    await StockAlertService.evaluateAfterSale({ eventId: String(eventId), vendorId: String(vendorId), merchantId: String(merchantId), productIds: [String(productId)] });
    expect(await Notification.countDocuments({ recipientId: vendorId, type: 'low_stock' })).toBe(1);
  });

  it('does not alert a product with no threshold', async () => {
    await stock(1, null);
    await StockAlertService.evaluateAfterSale({ eventId: String(eventId), vendorId: String(vendorId), merchantId: String(merchantId), productIds: [String(productId)] });
    expect(await Notification.countDocuments({ type: 'low_stock' })).toBe(0);
  });

  it('rearm clears the marker once onHand is back above threshold', async () => {
    await stock(50, 20, new Date());
    await StockAlertService.rearm(String(merchantId), String(productId));
    expect((await ProductStock.findOne({ merchantId, productId }))!.lowStockAlertedAt).toBeNull();
  });

  it('rearm does NOT clear while still at/below threshold', async () => {
    const t = new Date();
    await stock(10, 20, t);
    await StockAlertService.rearm(String(merchantId), String(productId));
    expect((await ProductStock.findOne({ merchantId, productId }))!.lowStockAlertedAt).not.toBeNull();
  });

  it('never throws even if notification creation fails', async () => {
    await stock(1, 20);
    // vendorId '' would make NotificationService.create throw on cast; evaluateAfterSale must swallow it
    await expect(StockAlertService.evaluateAfterSale({ eventId: String(eventId), vendorId: 'not-an-objectid', merchantId: String(merchantId), productIds: [String(productId)] })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/services/__tests__/stockAlert.service.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Add the `low_stock` notification type (three spots)**

- `src/models/notification.model.ts`: add `'low_stock'` to the `NotificationType` union AND to the schema `type: { enum: [...] }` array.
- `src/services/notificationDispatcher.service.ts`: add a `low_stock` entry to the `PREF_BY_TYPE` `Record<NotificationType,…>` map, mirroring the existing vendor-only `follow` entry (the value that marks it as not buyer-dispatched — copy whatever `follow` uses; add the same short "vendor-addressed, kept for exhaustiveness" intent).

- [ ] **Step 4: Create `StockAlertService`**

```typescript
// src/services/stockAlert.service.ts
import { ProductStock } from '@models/productStock.model';
import { NotificationService } from '@services/notification.service';

/**
 * Low-stock alerting for the cashless stock system (design §4/§7). Best-effort:
 * every method swallows its own errors (logged, never thrown) so it can be fired
 * fire-and-forget after a sale without ever affecting the money path.
 * lowStockThreshold/lowStockAlertedAt are NOT journal fields, so these direct
 * ProductStock writes do not touch the onHand==Σdelta invariant.
 */
export class StockAlertService {
  /** After a sale, for each sold product atomically arm-and-detect a downward
   *  threshold crossing, and fire one low_stock notification per crossing. */
  static async evaluateAfterSale(params: {
    eventId: string; vendorId: string; merchantId: string; productIds: string[];
  }): Promise<void> {
    const { vendorId, merchantId, productIds } = params;
    for (const productId of productIds) {
      try {
        // Fires once per crossing: the lowStockAlertedAt:null guard + $set makes
        // concurrent evaluations race-safe (only one findOneAndUpdate matches).
        const armed = await ProductStock.findOneAndUpdate(
          {
            merchantId, productId,
            lowStockThreshold: { $ne: null },
            lowStockAlertedAt: null,
            $expr: { $lte: ['$onHand', '$lowStockThreshold'] },
          },
          { $set: { lowStockAlertedAt: new Date() } },
          { new: true },
        );
        if (!armed) continue;
        await NotificationService.create(
          'vendor', vendorId, 'low_stock',
          'Low stock',
          `A product is low: ${armed.onHand} left (threshold ${armed.lowStockThreshold}).`,
          { productId: String(productId), merchantId: String(merchantId), onHand: armed.onHand, threshold: armed.lowStockThreshold },
        );
      } catch (err) {
        console.error('[low-stock] evaluateAfterSale failed for product', productId, err);
      }
    }
  }

  /** Clear the armed marker once stock is back above threshold, so the next
   *  downward crossing re-alerts. Called after a replenish (receive/transfer-in/count-up). */
  static async rearm(merchantId: string, productId: string): Promise<void> {
    try {
      await ProductStock.updateOne(
        {
          merchantId, productId,
          lowStockAlertedAt: { $ne: null },
          $expr: { $gt: ['$onHand', '$lowStockThreshold'] },
        },
        { $set: { lowStockAlertedAt: null } },
      );
    } catch (err) {
      console.error('[low-stock] rearm failed for product', productId, err);
    }
  }
}
```

- [ ] **Step 5: Add the threshold validator + endpoint**

- `src/validators/stock.validator.ts` — add:
  ```typescript
  export const thresholdSchema = Joi.object({
    merchantId: Joi.string().trim().required(),
    productId: Joi.string().trim().required(),
    lowStockThreshold: Joi.number().integer().min(0).allow(null).required(),
  });
  ```
- `src/controllers/stockAdmin.controller.ts` — add (reuse the file's `loadOwnedEvent`/`actorOf`; import `ProductStock`, `thresholdSchema`):
  ```typescript
  /** PATCH /api/tickets/events/:eventId/stock/threshold */
  static async setThreshold(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = thresholdSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const merchant = await Merchant.findById(value.merchantId).lean();
      if (!merchant || String(merchant.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'merchant does not belong to this event'); return; }
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return; }
      // Upsert the bar-product stock row's threshold + re-arm (clear lowStockAlertedAt).
      const row = await ProductStock.findOneAndUpdate(
        { merchantId: value.merchantId, productId: value.productId },
        { $set: { lowStockThreshold: value.lowStockThreshold, lowStockAlertedAt: null }, $setOnInsert: { eventId: event._id, onHand: 0 } },
        { new: true, upsert: true },
      );
      ApiResponseUtil.success(res, { merchantId: value.merchantId, productId: value.productId, lowStockThreshold: row.lowStockThreshold });
    } catch (err) { next(err); }
  }
  ```
- `src/routes/tickets.route.ts` — add next to the Slice-1 stock routes:
  ```typescript
  router.patch('/events/:eventId/stock/threshold', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.setThreshold);
  ```

- [ ] **Step 6: Write the threshold route test**

```typescript
// src/routes/__tests__/stockThreshold.route.test.ts
// Harness mirrors stockAdmin.route.test.ts (app, signVendorToken, seedPublishedEvent, connectLedgerTestDb).
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

let seq = 610001;
async function owned() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  const merchant = await Merchant.create({ name: 'Bar', eventId, loginCode: String(seq++), pin: '000000' });
  const product = await Product.create({ eventId, name: 'Beer', category: 'beer', price: 2500 });
  return { eventId: String(eventId), token, merchantId: String(merchant._id), productId: String(product._id) };
}

it('sets a threshold (upsert) and re-arms', async () => {
  const { eventId, token, merchantId, productId } = await owned();
  await ProductStock.create({ eventId, merchantId, productId, onHand: 3, lowStockAlertedAt: new Date() });
  const res = await request(app).patch(`/api/tickets/events/${eventId}/stock/threshold`)
    .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, lowStockThreshold: 20 });
  expect(res.status).toBe(200);
  const row = await ProductStock.findOne({ merchantId, productId });
  expect(row!.lowStockThreshold).toBe(20);
  expect(row!.lowStockAlertedAt).toBeNull(); // re-armed
});

it('requires MANAGE_STOCK', async () => {
  const { eventId, merchantId, productId } = await owned();
  const token = signVendorToken(String(new (require('mongoose').Types.ObjectId)()), { permissions: [] });
  const res = await request(app).patch(`/api/tickets/events/${eventId}/stock/threshold`)
    .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, lowStockThreshold: 20 });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 7: Run tests + tsc**

Run: `npx jest src/services/__tests__/stockAlert.service.test.ts src/routes/__tests__/stockThreshold.route.test.ts` then `npx tsc --noEmit`.
Expected: green (the `low_stock` type compiles across all three spots).

- [ ] **Step 8: Commit**

```bash
git add src/models/notification.model.ts src/services/notificationDispatcher.service.ts src/services/stockAlert.service.ts src/validators/stock.validator.ts src/controllers/stockAdmin.controller.ts src/routes/tickets.route.ts src/services/__tests__/stockAlert.service.test.ts src/routes/__tests__/stockThreshold.route.test.ts
git commit -m "feat(cashless-stock): low-stock alert infra (low_stock type, StockAlertService, threshold endpoint)"
```

---

### Task 2: Bar-to-bar `StockTransfer`

**Files:**
- Create: `src/models/stockTransfer.model.ts`, `src/services/stockTransfer.service.ts`
- Modify: `src/validators/stock.validator.ts` (add `transferStockSchema`), `src/controllers/stockAdmin.controller.ts` (add `transferStock`), `src/routes/tickets.route.ts`
- Test: `src/services/__tests__/stockTransfer.service.test.ts`, `src/routes/__tests__/stockTransfer.route.test.ts`

**Interfaces:**
- Consumes: `StockService.applyMovement`, `StockMovementReason.{TRANSFER_OUT,TRANSFER_IN}`, `StockAlertService.rearm`, `StockDeclinedError`.
- Produces: `StockTransferService.transfer({eventId, productId, fromMerchantId, toMerchantId, qty, byType, by, note?})` → `{ transfer, fromOnHand, toOnHand }`; throws `StockDeclinedError` if the source lacks stock. `POST /api/tickets/events/:eventId/stock/transfer`.

- [ ] **Step 1: Write the failing service test**

```typescript
// src/services/__tests__/stockTransfer.service.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockTransferService } from '@services/stockTransfer.service';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { ProductStock } from '@models/productStock.model';
import { StockTransfer } from '@models/stockTransfer.model';

const eventId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const from = new mongoose.Types.ObjectId();
const to = new mongoose.Types.ObjectId();
const seedArgs = (extra: any) => ({ eventId: String(eventId), productId: String(productId), fromMerchantId: String(from), toMerchantId: String(to), byType: 'Organizer' as const, by: 'v1', ...extra });

async function receive(merchantId: mongoose.Types.ObjectId, qty: number) {
  await StockService.applyMovement({ eventId, merchantId, productId, delta: qty, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' });
}

describe('StockTransferService.transfer', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('moves qty from source to dest and records a StockTransfer', async () => {
    await receive(from, 100);
    const { transfer, fromOnHand, toOnHand } = await StockTransferService.transfer(seedArgs({ qty: 30 }));
    expect(fromOnHand).toBe(70);
    expect(toOnHand).toBe(30);
    expect((await ProductStock.findOne({ merchantId: from, productId }))!.onHand).toBe(70);
    expect((await ProductStock.findOne({ merchantId: to, productId }))!.onHand).toBe(30);
    expect(await StockTransfer.countDocuments({ _id: transfer._id })).toBe(1);
  });

  it('declines an over-transfer and moves nothing', async () => {
    await receive(from, 10);
    await expect(StockTransferService.transfer(seedArgs({ qty: 50 }))).rejects.toBeInstanceOf(StockDeclinedError);
    expect((await ProductStock.findOne({ merchantId: from, productId }))!.onHand).toBe(10); // untouched
    expect(await ProductStock.countDocuments({ merchantId: to, productId })).toBe(0);       // dest never created
    expect(await StockTransfer.countDocuments({})).toBe(0);
  });

  it('rejects a same-bar transfer', async () => {
    await receive(from, 100);
    await expect(StockTransferService.transfer(seedArgs({ qty: 5, toMerchantId: String(from) }))).rejects.toThrow(/same/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest src/services/__tests__/stockTransfer.service.test.ts` → FAIL (module not found).

- [ ] **Step 3: Create the model**

```typescript
// src/models/stockTransfer.model.ts
import mongoose, { Schema, Document } from 'mongoose';
import { StockMovementByType } from '@interfaces/stock.interface';

/** A bar-to-bar stock move (design §3). The two paired StockMovements
 *  (TRANSFER_OUT/TRANSFER_IN, refId = this _id) carry the ledger effect; this
 *  row is the human-facing audit (who moved what, from/to which bar, when). */
export interface IStockTransfer extends Document {
  eventId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  fromMerchantId: mongoose.Types.ObjectId;
  toMerchantId: mongoose.Types.ObjectId;
  qty: number;
  byType: StockMovementByType;
  by: string;
  note?: string;
  at: Date;
}

const stockTransferSchema = new Schema<IStockTransfer>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  fromMerchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  toMerchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  qty: { type: Number, required: true, min: 1, validate: { validator: Number.isSafeInteger, message: 'qty must be a whole number' } },
  byType: { type: String, enum: ['Organizer', 'Merchant', 'Platform'], required: true },
  by: { type: String, required: true },
  note: { type: String, trim: true },
  at: { type: Date, default: Date.now },
}, { timestamps: false });

stockTransferSchema.index({ eventId: 1, at: -1 });
stockTransferSchema.index({ productId: 1, at: -1 });

export const StockTransfer = mongoose.model<IStockTransfer>('StockTransfer', stockTransferSchema);
```

- [ ] **Step 4: Create the service**

```typescript
// src/services/stockTransfer.service.ts
import mongoose from 'mongoose';
import { StockService } from '@services/stock.service';
import { StockAlertService } from '@services/stockAlert.service';
import { StockMovementReason, StockMovementByType } from '@interfaces/stock.interface';
import { StockTransfer, IStockTransfer } from '@models/stockTransfer.model';

export class StockTransferService {
  static async transfer(params: {
    eventId: string; productId: string; fromMerchantId: string; toMerchantId: string;
    qty: number; byType: StockMovementByType; by: string; note?: string;
  }): Promise<{ transfer: IStockTransfer; fromOnHand: number; toOnHand: number }> {
    const { eventId, productId, fromMerchantId, toMerchantId, qty, byType, by, note } = params;
    if (fromMerchantId === toMerchantId) throw new Error('cannot transfer to the same bar');
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('qty must be a positive whole number');

    const transferId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();
    try {
      let out!: { transfer: IStockTransfer; fromOnHand: number; toOnHand: number };
      await session.withTransaction(async () => {
        const outMove = await StockService.applyMovement({ eventId, merchantId: fromMerchantId, productId, delta: -qty, reason: StockMovementReason.TRANSFER_OUT, refType: 'stock_transfer', refId: String(transferId), byType, by, note, session });
        const inMove = await StockService.applyMovement({ eventId, merchantId: toMerchantId, productId, delta: qty, reason: StockMovementReason.TRANSFER_IN, refType: 'stock_transfer', refId: String(transferId), byType, by, note, session });
        const created = await StockTransfer.create([{ _id: transferId, eventId, productId, fromMerchantId, toMerchantId, qty, byType, by, note, at: new Date() }], { session });
        out = { transfer: created[0]!, fromOnHand: outMove.onHand, toOnHand: inMove.onHand };
      });
      // Best-effort re-arm the destination (a transfer-in may lift it above threshold).
      await StockAlertService.rearm(toMerchantId, productId);
      return out;
    } finally {
      await session.endSession();
    }
  }
}
```

- [ ] **Step 5: Run to verify green** — `npx jest src/services/__tests__/stockTransfer.service.test.ts` → PASS.

- [ ] **Step 6: Add validator + controller + route + route test**

- `src/validators/stock.validator.ts` — add:
  ```typescript
  export const transferStockSchema = Joi.object({
    productId: Joi.string().trim().required(),
    fromMerchantId: Joi.string().trim().required(),
    toMerchantId: Joi.string().trim().required(),
    qty: Joi.number().integer().min(1).max(MAX_QTY).required(),
    note: Joi.string().trim().optional(),
  });
  ```
- `src/controllers/stockAdmin.controller.ts` — add (mirrors `receiveStock`'s ownership + cross-entity guards; maps `StockDeclinedError` → 409):
  ```typescript
  /** POST /api/tickets/events/:eventId/stock/transfer */
  static async transferStock(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = transferStockSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      if (value.fromMerchantId === value.toMerchantId) { ApiResponseUtil.badRequest(res, 'cannot transfer to the same bar'); return; }
      for (const mid of [value.fromMerchantId, value.toMerchantId]) {
        const m = await Merchant.findById(mid).lean();
        if (!m || String(m.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'a merchant does not belong to this event'); return; }
      }
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return; }
      const actor = actorOf(req);
      try {
        const result = await StockTransferService.transfer({ eventId: String(event._id), productId: value.productId, fromMerchantId: value.fromMerchantId, toMerchantId: value.toMerchantId, qty: value.qty, byType: 'Organizer', by: actor.vendorId ?? 'platform', note: value.note });
        ApiResponseUtil.success(res, { transferId: String(result.transfer._id), fromOnHand: result.fromOnHand, toOnHand: result.toOnHand });
      } catch (e: any) {
        if (e instanceof StockDeclinedError) { ApiResponseUtil.error(res, 'Insufficient stock at source', 409, { reason: e.reason, productId: e.productId, available: e.available }); return; }
        throw e;
      }
    } catch (err) { next(err); }
  }
  ```
  (Add imports: `StockTransferService`, `StockDeclinedError`, `transferStockSchema`.)
- `src/routes/tickets.route.ts` — add:
  ```typescript
  router.post('/events/:eventId/stock/transfer', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.transferStock);
  ```
- Route test `src/routes/__tests__/stockTransfer.route.test.ts` (mirror the Task-1 threshold route test harness): seed one owned event + two merchants + a product, receive 100 into bar A; assert `POST .../stock/transfer {productId, fromMerchantId:A, toMerchantId:B, qty:30}` → 200 with `fromOnHand:70, toOnHand:30`; an over-transfer → 409; same-bar → 400; a merchant from another event → 400.

- [ ] **Step 7: Run tests + tsc + commit**

Run: `npx jest src/services/__tests__/stockTransfer.service.test.ts src/routes/__tests__/stockTransfer.route.test.ts` then `npx tsc --noEmit`.
```bash
git add src/models/stockTransfer.model.ts src/services/stockTransfer.service.ts src/validators/stock.validator.ts src/controllers/stockAdmin.controller.ts src/routes/tickets.route.ts src/services/__tests__/stockTransfer.service.test.ts src/routes/__tests__/stockTransfer.route.test.ts
git commit -m "feat(cashless-stock): bar-to-bar StockTransfer (paired movements, source CAS, 409)"
```

---

### Task 3: `StockCount` + POS stock endpoints

**Files:**
- Create: `src/models/stockCount.model.ts`, `src/services/stockCount.service.ts`
- Modify: `src/validators/stock.validator.ts` (add `stockCountSchema`, `posCountSchema`), `src/controllers/stockAdmin.controller.ts` (add `recordCount`), `src/controllers/merchant.controller.ts` (add `stock` + `recordCount`), `src/routes/tickets.route.ts`, `src/routes/merchant.route.ts`
- Test: `src/services/__tests__/stockCount.service.test.ts`, `src/routes/__tests__/stockCount.route.test.ts` (organizer + POS)

**Interfaces:**
- Produces: `StockCountService.recordCount({eventId, merchantId, productId, countedOnHand, phase, byType, by})` → `{ count, onHand }` (writes a `COUNT_ADJUST` only when `variance ≠ 0`; always records `StockCount`; re-arms after). `POST /api/tickets/events/:eventId/stock/count`, `GET /api/merchant/stock`, `POST /api/merchant/stock/count`.

- [ ] **Step 1: Write the failing service test**

```typescript
// src/services/__tests__/stockCount.service.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockCountService } from '@services/stockCount.service';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { ProductStock } from '@models/productStock.model';
import { StockCount } from '@models/stockCount.model';
import { StockMovement } from '@models/stockMovement.model';

const eventId = new mongoose.Types.ObjectId();
const merchantId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const args = (extra: any) => ({ eventId: String(eventId), merchantId: String(merchantId), productId: String(productId), phase: 'interim' as const, byType: 'Organizer' as const, by: 'v1', ...extra });

describe('StockCountService.recordCount', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('records a shortfall: counted<expected → negative variance + COUNT_ADJUST to counted', async () => {
    await StockService.applyMovement({ eventId, merchantId, productId, delta: 100, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' });
    const { count } = await StockCountService.recordCount(args({ countedOnHand: 92 }));
    expect(count.expectedOnHand).toBe(100);
    expect(count.variance).toBe(-8);
    expect((await ProductStock.findOne({ merchantId, productId }))!.onHand).toBe(92); // reconciled to reality
    expect(await StockMovement.countDocuments({ merchantId, productId, reason: StockMovementReason.COUNT_ADJUST })).toBe(1);
  });

  it('records a zero-variance count with NO movement', async () => {
    await StockService.applyMovement({ eventId, merchantId, productId, delta: 50, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' });
    const { count } = await StockCountService.recordCount(args({ countedOnHand: 50 }));
    expect(count.variance).toBe(0);
    expect(await StockMovement.countDocuments({ merchantId, productId, reason: StockMovementReason.COUNT_ADJUST })).toBe(0);
    expect(await StockCount.countDocuments({})).toBe(1); // still recorded
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Create the model**

```typescript
// src/models/stockCount.model.ts
import mongoose, { Schema, Document } from 'mongoose';
import { StockMovementByType } from '@interfaces/stock.interface';

export type StockCountPhase = 'opening' | 'interim' | 'closing';

/** A physical stock-take (design §3): expected (system onHand) vs counted, with
 *  the preserved variance; reconciled to reality via a COUNT_ADJUST movement. */
export interface IStockCount extends Document {
  eventId: mongoose.Types.ObjectId; merchantId: mongoose.Types.ObjectId; productId: mongoose.Types.ObjectId;
  expectedOnHand: number; countedOnHand: number; variance: number;   // counted − expected
  phase: StockCountPhase; byType: StockMovementByType; by: string; at: Date;
}

const stockCountSchema = new Schema<IStockCount>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  expectedOnHand: { type: Number, required: true, validate: { validator: Number.isSafeInteger, message: 'expectedOnHand must be a whole number' } },
  countedOnHand: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'countedOnHand must be a whole number' } },
  variance: { type: Number, required: true, validate: { validator: Number.isSafeInteger, message: 'variance must be a whole number' } },
  phase: { type: String, enum: ['opening', 'interim', 'closing'], default: 'interim' },
  byType: { type: String, enum: ['Organizer', 'Merchant', 'Platform'], required: true },
  by: { type: String, required: true },
  at: { type: Date, default: Date.now },
}, { timestamps: false });

stockCountSchema.index({ merchantId: 1, productId: 1, at: -1 });
stockCountSchema.index({ eventId: 1, phase: 1, at: -1 });

export const StockCount = mongoose.model<IStockCount>('StockCount', stockCountSchema);
```

- [ ] **Step 4: Create the service**

```typescript
// src/services/stockCount.service.ts
import mongoose from 'mongoose';
import { StockService } from '@services/stock.service';
import { StockAlertService } from '@services/stockAlert.service';
import { StockMovementReason, StockMovementByType } from '@interfaces/stock.interface';
import { StockCount, IStockCount, StockCountPhase } from '@models/stockCount.model';

export class StockCountService {
  static async recordCount(params: {
    eventId: string; merchantId: string; productId: string; countedOnHand: number;
    phase?: StockCountPhase; byType: StockMovementByType; by: string;
  }): Promise<{ count: IStockCount; onHand: number }> {
    const { eventId, merchantId, productId, countedOnHand, phase = 'interim', byType, by } = params;
    if (!Number.isSafeInteger(countedOnHand) || countedOnHand < 0) throw new Error('countedOnHand must be a non-negative whole number');

    const countId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();
    try {
      let out!: { count: IStockCount; onHand: number };
      await session.withTransaction(async () => {
        const expected = await StockService.getOnHand(merchantId, productId, session);
        const variance = countedOnHand - expected;
        if (variance !== 0) {
          await StockService.applyMovement({ eventId, merchantId, productId, delta: variance, reason: StockMovementReason.COUNT_ADJUST, refType: 'stock_count', refId: String(countId), byType, by, session });
        }
        const created = await StockCount.create([{ _id: countId, eventId, merchantId, productId, expectedOnHand: expected, countedOnHand, variance, phase, byType, by, at: new Date() }], { session });
        out = { count: created[0]!, onHand: countedOnHand };
      });
      await StockAlertService.rearm(merchantId, productId); // a count-up may lift above threshold
      return out;
    } finally {
      await session.endSession();
    }
  }
}
```

- [ ] **Step 5: Run to verify green.**

- [ ] **Step 6: Validators + organizer endpoint + POS endpoints + route tests**

- `src/validators/stock.validator.ts` — add:
  ```typescript
  const phase = Joi.string().valid('opening', 'interim', 'closing');
  export const stockCountSchema = Joi.object({ merchantId: Joi.string().trim().required(), productId: Joi.string().trim().required(), countedOnHand: Joi.number().integer().min(0).max(MAX_QTY).required(), phase });
  export const posCountSchema = Joi.object({ productId: Joi.string().trim().required(), countedOnHand: Joi.number().integer().min(0).max(MAX_QTY).required(), phase });
  ```
- `src/controllers/stockAdmin.controller.ts` — add `recordCount` (organizer): `loadOwnedEvent` → validate `stockCountSchema` → verify merchant+product belong to event → `StockCountService.recordCount({..., byType:'Organizer', by: actor.vendorId ?? 'platform'})` → `success({ countId, expectedOnHand, countedOnHand, variance, onHand })`.
- `src/controllers/merchant.controller.ts` — add two handlers using `req.merchant` (JWT-only identity):
  ```typescript
  /** GET /api/merchant/stock — this bar's products + onHand for the stock-take screen. */
  static async stock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      const products = await Product.find({ eventId, active: true }).sort({ name: 1 }).lean();
      const rows = await ProductStock.find({ merchantId }).lean();
      const byProduct = new Map(rows.map((r) => [String(r.productId), r]));
      const stock = products.map((p) => {
        const r = byProduct.get(String(p._id));
        return { productId: String(p._id), name: p.name, unitLabel: p.unitLabel, onHand: r?.onHand ?? 0, lowStockThreshold: r?.lowStockThreshold ?? null };
      });
      return ApiResponseUtil.success(res, { stock });
    } catch (e: any) { return ApiResponseUtil.error(res, e?.message || 'Failed to load stock', 500); }
  }

  /** POST /api/merchant/stock/count — a stock-take by this bar (merchantId from JWT). */
  static async recordCount(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      const { error, value } = posCountSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(eventId)) return ApiResponseUtil.badRequest(res, 'product does not belong to this event');
      const { count, onHand } = await StockCountService.recordCount({ eventId, merchantId, productId: value.productId, countedOnHand: value.countedOnHand, phase: value.phase, byType: 'Merchant', by: merchantId });
      return ApiResponseUtil.success(res, { countId: String(count._id), expectedOnHand: count.expectedOnHand, countedOnHand: count.countedOnHand, variance: count.variance, onHand });
    } catch (e: any) { return ApiResponseUtil.error(res, e?.message || 'Count failed', 500); }
  }
  ```
  (Add imports to `merchant.controller.ts`: `Product`, `ProductStock`, `StockCountService`, `posCountSchema`.)
- Routes:
  - `tickets.route.ts`: `router.post('/events/:eventId/stock/count', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.recordCount);`
  - `merchant.route.ts`: `router.get('/stock', requireMerchantPermission(MerchantPermission.CHARGE), MerchantController.stock);` and `router.post('/stock/count', requireMerchantPermission(MerchantPermission.CHARGE), MerchantController.recordCount);`
- Route tests `src/routes/__tests__/stockCount.route.test.ts`: organizer count (200, variance recorded, onHand reconciled); POS `GET /api/merchant/stock` (returns this bar's products with onHand) + POS `POST /api/merchant/stock/count` (200, scoped to the token's merchant — seed stock under the token's merchantId, assert the count adjusts THAT bar). Use the merchant-JWT harness from `merchantChargeItems.route.test.ts`.

- [ ] **Step 7: Run tests + tsc + commit**

```bash
git add src/models/stockCount.model.ts src/services/stockCount.service.ts src/validators/stock.validator.ts src/controllers/stockAdmin.controller.ts src/controllers/merchant.controller.ts src/routes/tickets.route.ts src/routes/merchant.route.ts src/services/__tests__/stockCount.service.test.ts src/routes/__tests__/stockCount.route.test.ts
git commit -m "feat(cashless-stock): physical StockCount + POS stock read/count endpoints"
```

---

### Task 4: Wire the sale-triggered alert + receive re-arm (+ end-to-end alert test)

**Files:**
- Modify: `src/controllers/merchant.controller.ts` (post-charge `evaluateAfterSale`), `src/controllers/stockAdmin.controller.ts` (`receiveStock` → `rearm` after applying)
- Test: `src/routes/__tests__/lowStockAlert.route.test.ts`

**Interfaces:**
- Consumes: `StockAlertService.{evaluateAfterSale,rearm}` (Task 1), the charge flow (Slice 2), `receiveStock` (Slice 1). No new endpoints.

- [ ] **Step 1: Write the failing end-to-end test**

```typescript
// src/routes/__tests__/lowStockAlert.route.test.ts
// Merchant-JWT harness (as merchantChargeItems.route.test.ts) + a MANAGE_STOCK vendor token for receive/threshold.
// Flow: threshold=5 on a product with onHand 6; sell 2 (→4, crosses) → one low_stock vendor notification;
// sell 1 more (→3, still armed) → NO second notification; receive 10 (→13, above) re-arms; sell 9 (→4) → alerts again.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { WalletService } from '@services/wallet.service';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Notification } from '@models/notification.model';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 620001;
const mToken = (merchantId: string, eventId: string) => jwt.sign({ scope: 'merchant', merchantId, eventId, name: 'Bar', permissions: [MerchantPermission.CHARGE] }, JWT_SECRET);
const lowStockCount = (vendorId: string) => Notification.countDocuments({ recipientType: 'vendor', recipientId: vendorId, type: 'low_stock' });

async function setup() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const t = await Ticket.create({ eventId, vendorId, ticketType: 'GA', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  const bandUid = '04b1c2d3e4f5'; await WalletService.bindBand(String(w._id), bandUid, 'op1');
  await WalletService.topUpCash({ walletId: String(w._id), eventId: String(eventId), amount: 1_000_000, recordedBy: 'op1', clientTxnId: 'seed' });
  const merchant = await Merchant.create({ name: 'Bar', eventId, commissionPercent: 0, loginCode: String(seq++), pin: '111111' });
  const product = await Product.create({ eventId, name: 'Beer', category: 'beer', price: 100 });
  await StockService.applyMovement({ eventId, merchantId: merchant._id, productId: product._id, delta: 6, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' });
  // set threshold 5 via the organizer endpoint
  const vToken = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  await request(app).patch(`/api/tickets/events/${eventId}/stock/threshold`).set('Authorization', `Bearer ${vToken}`).send({ merchantId: String(merchant._id), productId: String(product._id), lowStockThreshold: 5 });
  return { eventId: String(eventId), vendorId: String(vendorId), bandUid, merchantId: String(merchant._id), productId: String(product._id), vToken };
}
const sell = (m: string, e: string, band: string, productId: string, qty: number, id: string) =>
  request(app).post('/api/merchant/charge').set('Authorization', `Bearer ${mToken(m, e)}`).send({ bandUid: band, clientTxnId: id, items: [{ productId, qty }] });

it('alerts once on downward crossing, stays quiet while armed, re-alerts after replenish', async () => {
  const { eventId, vendorId, bandUid, merchantId, productId, vToken } = await setup();
  expect((await sell(merchantId, eventId, bandUid, productId, 2, 'c1')).status).toBe(200); // 6→4, crosses 5
  await new Promise((r) => setTimeout(r, 150)); // let the fire-and-forget alert land
  expect(await lowStockCount(vendorId)).toBe(1);
  expect((await sell(merchantId, eventId, bandUid, productId, 1, 'c2')).status).toBe(200); // 4→3, still armed
  await new Promise((r) => setTimeout(r, 150));
  expect(await lowStockCount(vendorId)).toBe(1); // no second alert
  // replenish above threshold → re-arm
  await request(app).post(`/api/tickets/events/${eventId}/stock/receive`).set('Authorization', `Bearer ${vToken}`).send({ merchantId, productId, quantity: 10 }); // 3→13
  expect((await sell(merchantId, eventId, bandUid, productId, 9, 'c3')).status).toBe(200); // 13→4, crosses again
  await new Promise((r) => setTimeout(r, 150));
  expect(await lowStockCount(vendorId)).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails** — the alert isn't wired yet, so the count stays 0.

- [ ] **Step 3: Wire the charge post-commit alert**

In `src/controllers/merchant.controller.ts` `charge`, after the successful `MerchantService.charge` and BEFORE returning the response (import `StockAlertService`):
```typescript
if (result.charge.items?.length) {
  // Best-effort, off the money path: a notification failure logs loudly but never affects the sale.
  StockAlertService.evaluateAfterSale({
    eventId, merchantId, vendorId: String(event.vendorId),
    productIds: result.charge.items.map((i) => String(i.productId)),
  }).catch((err) => console.error('[low-stock] evaluateAfterSale failed', err));
}
```

- [ ] **Step 4: Wire the receive re-arm**

In `src/controllers/stockAdmin.controller.ts` `receiveStock`, after `StockService.applyMovement(... reason: RECEIVE ...)` succeeds (import `StockAlertService`):
```typescript
await StockAlertService.rearm(String(value.merchantId), String(value.productId));
```
(Transfer-in and count already re-arm inside their services — Tasks 2/3.)

- [ ] **Step 5: Run the end-to-end test + tsc**

Run: `npx jest src/routes/__tests__/lowStockAlert.route.test.ts` then `npx tsc --noEmit`. Expected: green (1 → still 1 → 2 low_stock notifications).

- [ ] **Step 6: Full-suite check + commit**

Run: `npx jest --maxWorkers=4` — confirm green (baseline was 1548/1548 before this slice; Slice 3 adds its suites).
```bash
git add src/controllers/merchant.controller.ts src/controllers/stockAdmin.controller.ts src/routes/__tests__/lowStockAlert.route.test.ts
git commit -m "feat(cashless-stock): fire low-stock alert after a sale + re-arm on receive"
```

---

## Self-Review

**Spec coverage** (design §12 slice 3: transfers + counts + low-stock alerts): transfers → Task 2; counts + POS stock read/count → Task 3; alert infra (low_stock type, StockAlertService, threshold) → Task 1; alert wiring (sale trigger + re-arm) → Task 4. All covered. Reporting *views* are Slice 4 (this slice records the data); POS/dashboard UI are Slices 5/6 — out of scope.

**Placeholder scan:** no TBD/TODO. `MAX_QTY` is the existing Slice-1 validator constant; route tests reference the verified harnesses (`stockAdmin.route.test.ts`, `merchantChargeItems.route.test.ts`) — align import names to those files. The `PREF_BY_TYPE` addition must copy the `follow` entry's shape (read it during Task 1).

**Type consistency:** `StockDeclinedError` (Slice 1) is mapped to 409 in the transfer handler; `StockMovementReason.{TRANSFER_OUT,TRANSFER_IN,COUNT_ADJUST}` are the reserved Slice-1 enum values; `StockAlertService.{evaluateAfterSale,rearm}` signatures are consistent Task 1 → Tasks 2/3/4; `NotificationService.create('vendor', vendorId, 'low_stock', …)` matches the mapped explorer signature; `byType:'Organizer'|'Merchant'` per source. The alert is fired from the controller post-commit (the `MerchantService.charge` transaction is untouched — money path unchanged).

**Risk note for the executing agent:** the low-stock alert is fire-and-forget; the end-to-end test uses small `setTimeout` waits to let it land — if that flakes, `await` the `evaluateAfterSale` promise in the test via a test-only hook, or poll. Run the full suite with `--maxWorkers=4`. Confirm the notification test helpers + `PREF_BY_TYPE` shape against the real files before Task 1.

---

## Downstream (own plans)

Slice 4 (reporting — live board, reconciliation using the transfers/counts/variances recorded here, Event Stock Dashboard, itemised-vs-un-itemised split — classify by `items.0` existence), Slice 5 (POS basket + scan + stock-take screen consuming `GET /api/merchant/stock`), Slice 6 (dashboard Stock UI), Slice 7 (seed + demo). Carry-forward: transfer/receive idempotency (no `clientTxnId` yet).
