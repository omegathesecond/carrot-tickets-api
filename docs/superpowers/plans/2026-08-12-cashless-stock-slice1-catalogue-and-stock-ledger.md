# Cashless Stock — Slice 1: Catalogue + Stock Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the event-scoped product catalogue and the per-bar stock ledger (denormalized `ProductStock.onHand` backed by an append-only `StockMovement` journal, written by a single service), plus organiser product CRUD and receive-stock — all under test. This is the foundation the item-based sale (Slice 2) and everything downstream builds on.

**Architecture:** Mirror the money ledger exactly. `ProductStock.onHand` is a denormalized per-(merchant×product) count and the atomic CAS source; every change to it goes through `StockService.applyMovement`, the **sole writer** of `StockMovement` (like `LedgerService.post` is the sole writer of `LedgerEntry`). A movement atomically updates `onHand` (CAS-guarded so a decrement can never drive it negative) and appends a journal row carrying `balanceAfter`. The invariant `onHand == Σ(movement deltas)` is therefore true by construction and property-tested.

**Tech Stack:** Node + TypeScript, Express, Mongoose (MongoDB, replica set for transactions), Joi validation, Jest + `mongodb-memory-server`. TS path aliases (`@models/*`, `@services/*`, `@interfaces/*`, `@controllers/*`, `@validators/*`, `@utils/*`, `@middleware/*`, `@/*`).

## Global Constraints

- **Base branch:** `feat/cashless-stock` off `feat/cashless-cashier`, in the `api-cashier-wt` worktree. Merge onto the cashless line, **not** `main`.
- **Units:** stock is **integer base units** (bottles/cans/items); never fractional. Money stays integer ZAR cents (untouched by this slice).
- **Money ledger is untouched.** This slice adds no `LedgerEntry` writes and does not modify `MerchantService.charge`. That is Slice 2.
- **Sole writer:** `StockMovement` is written ONLY by `StockService.applyMovement`. No controller or other service inserts `StockMovement` directly.
- **Model registration:** each model self-registers via `mongoose.model('Name', schema)` at file end; import the model where used (no central registry). Declare each index once.
- **Unique-index-on-optional rule:** a unique index over a field that can be absent MUST use `partialFilterExpression`, never `sparse` on a compound index (a compound sparse index still indexes every doc when a sibling field is always present → `E11000` on the null value). Repo has a prior incident on exactly this.
- **Fail loudly:** insufficient stock is a real thrown error surfaced to the caller — never a silent clamp to zero or a fabricated success (workspace rule).
- **Responses:** all HTTP responses go through `@utils/apiResponse.util` (`ApiResponseUtil.success/created/badRequest/notFound/forbidden`).
- **Ownership:** every organiser stock route is guarded by `requireTicketsPermission(TicketsPermission.MANAGE_STOCK)` AND an in-controller check that the caller owns the event (super-admin bypasses), mirroring `MerchantAdminController`.

---

### Task 1: `MANAGE_STOCK` permission

**Files:**
- Modify: `src/interfaces/ticketsPermission.interface.ts`
- Test: `src/interfaces/__tests__/ticketsPermission.stock.test.ts`

**Interfaces:**
- Produces: `TicketsPermission.MANAGE_STOCK = 'tickets:manage_stock'`; present in `EVENT_PERMISSIONS`, in `TICKETS_ROLE_PERMISSIONS[OWNER]` (via the existing filter) and `[MANAGER]` (explicit); absent from `SALES`/`SCANNER`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/interfaces/__tests__/ticketsPermission.stock.test.ts
import {
  TicketsPermission,
  TicketsRole,
  TICKETS_ROLE_PERMISSIONS,
  EVENT_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';

describe('MANAGE_STOCK permission', () => {
  it('is defined in the tickets namespace', () => {
    expect(TicketsPermission.MANAGE_STOCK).toBe('tickets:manage_stock');
  });

  it('is an events-vertical permission (kept for events, stripped for transport)', () => {
    expect(EVENT_PERMISSIONS).toContain(TicketsPermission.MANAGE_STOCK);
    expect(TRANSPORT_PERMISSIONS).not.toContain(TicketsPermission.MANAGE_STOCK);
  });

  it('is granted to OWNER and MANAGER, not SALES or SCANNER', () => {
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.MANAGE_STOCK);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]).toContain(TicketsPermission.MANAGE_STOCK);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SALES]).not.toContain(TicketsPermission.MANAGE_STOCK);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SCANNER]).not.toContain(TicketsPermission.MANAGE_STOCK);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/interfaces/__tests__/ticketsPermission.stock.test.ts`
Expected: FAIL (`MANAGE_STOCK` undefined).

- [ ] **Step 3: Add the permission**

In `src/interfaces/ticketsPermission.interface.ts`:
- Add to the `TicketsPermission` enum (after `MANAGE_ACCESS`):
  ```typescript
  // Cashless stock/inventory management — organiser manages the product
  // catalogue, per-bar stock, transfers and counts. Events-vertical (a bus
  // operator has no bar stock), so it lives in EVENT_PERMISSIONS below.
  MANAGE_STOCK = 'tickets:manage_stock',
  ```
- Add `TicketsPermission.MANAGE_STOCK,` to the `EVENT_PERMISSIONS` array.
- Add `TicketsPermission.MANAGE_STOCK,` to the `TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]` array. (OWNER already includes every non-platform-staff permission via its `Object.values(...).filter(...)`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/interfaces/__tests__/ticketsPermission.stock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/ticketsPermission.interface.ts src/interfaces/__tests__/ticketsPermission.stock.test.ts
git commit -m "feat(cashless-stock): add MANAGE_STOCK permission (events vertical)"
```

---

### Task 2: `Product` model + stock enums

**Files:**
- Create: `src/interfaces/stock.interface.ts`
- Create: `src/models/product.model.ts`
- Test: `src/models/__tests__/product.model.test.ts`

**Interfaces:**
- Produces: `ProductCategory` enum; `IProduct` (`eventId`, `name`, `barcode?`, `category`, `price` cents, `unitLabel`, `unitsPerPack?`, `packLabel?`, `imageUrl?`, `active`); the `Product` model. Unique **partial** index on `{eventId, barcode}` for string barcodes only.

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/__tests__/product.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Product } from '@models/product.model';
import { ProductCategory } from '@interfaces/stock.interface';

const eventId = () => new mongoose.Types.ObjectId();

describe('Product model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a product with defaults', async () => {
    const p = await Product.create({
      eventId: eventId(), name: 'Castle Lite 330ml',
      category: ProductCategory.BEER, price: 2500,
    });
    expect(p.price).toBe(2500);
    expect(p.unitLabel).toBe('unit');
    expect(p.active).toBe(true);
  });

  it('rejects a non-integer price', async () => {
    await expect(
      Product.create({ eventId: eventId(), name: 'x', category: ProductCategory.OTHER, price: 25.5 }),
    ).rejects.toThrow();
  });

  it('enforces barcode uniqueness per event, but allows many barcodeless products', async () => {
    const ev = eventId();
    await Product.create({ eventId: ev, name: 'A', category: ProductCategory.BEER, price: 100, barcode: '6001240100015' });
    await expect(
      Product.create({ eventId: ev, name: 'B', category: ProductCategory.BEER, price: 100, barcode: '6001240100015' }),
    ).rejects.toThrow(); // duplicate barcode, same event

    // two products with NO barcode in the same event must both succeed
    await Product.create({ eventId: ev, name: 'Ice', category: ProductCategory.OTHER, price: 500 });
    await expect(
      Product.create({ eventId: ev, name: 'Cup', category: ProductCategory.OTHER, price: 200 }),
    ).resolves.toBeDefined();

    // same barcode is fine at a DIFFERENT event
    await expect(
      Product.create({ eventId: eventId(), name: 'A2', category: ProductCategory.BEER, price: 100, barcode: '6001240100015' }),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/__tests__/product.model.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the interface enums**

```typescript
// src/interfaces/stock.interface.ts
/**
 * Cashless stock/inventory (design 2026-08-12). Stock is tracked in integer
 * base units (bottles/cans/items). Money stays in ZAR cents on the money ledger.
 */

/** Product taxonomy — "not limited to alcohol" (design §1). */
export enum ProductCategory {
  BEER = 'beer',
  SPIRITS = 'spirits',
  WINE = 'wine',
  SOFT_DRINK = 'soft_drink',
  WATER = 'water',
  FOOD = 'food',
  MERCH = 'merch',
  CIGARETTES = 'cigarettes',
  OTHER = 'other',
}
```

- [ ] **Step 4: Create the model**

```typescript
// src/models/product.model.ts
import mongoose, { Schema, Document } from 'mongoose';
import { ProductCategory } from '@interfaces/stock.interface';

/**
 * A sellable catalogue item at ONE cashless event (design §4). Price is per
 * base unit in ZAR cents. `unitsPerPack` drives case<->unit conversion at the
 * entry/display boundary; stock itself is always base units. `barcode` is the
 * manufacturer EAN/UPC — unique per event, but optional (food/ice/cups have none).
 */
export interface IProduct extends Document {
  eventId: mongoose.Types.ObjectId;
  name: string;
  barcode?: string;
  category: ProductCategory;
  price: number; // integer ZAR cents, per base unit
  unitLabel: string;
  unitsPerPack?: number;
  packLabel?: string;
  imageUrl?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    name: { type: String, required: true, trim: true },
    barcode: { type: String, trim: true },
    category: { type: String, enum: Object.values(ProductCategory), required: true },
    price: {
      type: Number, required: true, min: 0,
      validate: { validator: Number.isSafeInteger, message: 'price must be integer minor units (ZAR cents)' },
    },
    unitLabel: { type: String, default: 'unit', trim: true },
    unitsPerPack: { type: Number, min: 1, validate: { validator: (v: number) => v == null || Number.isSafeInteger(v), message: 'unitsPerPack must be a whole number' } },
    packLabel: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

// Unique barcode per event, but ONLY for products that HAVE a barcode.
// partialFilterExpression (not sparse): a compound sparse index still indexes
// every doc because eventId is always present, so barcode:null would collide
// across barcodeless products in the same event (the E11000 {null} incident).
productSchema.index(
  { eventId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
);

export const Product = mongoose.model<IProduct>('Product', productSchema);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/models/__tests__/product.model.test.ts`
Expected: PASS. (If the uniqueness assertions flake, ensure indexes are built: the test helper's `connectTestDb` + Mongoose `autoIndex` builds them; add `await Product.init();` at the top of the uniqueness test if needed.)

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/stock.interface.ts src/models/product.model.ts src/models/__tests__/product.model.test.ts
git commit -m "feat(cashless-stock): Product model + ProductCategory (partial-unique barcode)"
```

---

### Task 3: `ProductStock` model

**Files:**
- Create: `src/models/productStock.model.ts`
- Test: `src/models/__tests__/productStock.model.test.ts`

**Interfaces:**
- Produces: `IProductStock` (`eventId`, `merchantId`, `productId`, `onHand` int ≥ 0, `lowStockThreshold?`, `lowStockAlertedAt?`); the `ProductStock` model; unique index `{merchantId, productId}`; index `{eventId, productId}`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/__tests__/productStock.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { ProductStock } from '@models/productStock.model';

const id = () => new mongoose.Types.ObjectId();

describe('ProductStock model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('defaults onHand to 0', async () => {
    const s = await ProductStock.create({ eventId: id(), merchantId: id(), productId: id() });
    expect(s.onHand).toBe(0);
  });

  it('is unique per (merchant, product)', async () => {
    await ProductStock.init();
    const merchantId = id(); const productId = id();
    await ProductStock.create({ eventId: id(), merchantId, productId, onHand: 10 });
    await expect(
      ProductStock.create({ eventId: id(), merchantId, productId, onHand: 5 }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/__tests__/productStock.model.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the model**

```typescript
// src/models/productStock.model.ts
import mongoose, { Schema, Document } from 'mongoose';

/**
 * Per-BAR on-hand count for one product (design §4). `onHand` is the
 * denormalized, authoritative count and the atomic CAS source for the
 * hard-block-at-zero sale (Slice 2). It is mutated ONLY by
 * StockService.applyMovement, which keeps it equal to the sum of this
 * bar-product's StockMovement deltas.
 */
export interface IProductStock extends Document {
  eventId: mongoose.Types.ObjectId;
  merchantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  onHand: number; // integer base units, >= 0
  lowStockThreshold?: number;
  lowStockAlertedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const productStockSchema = new Schema<IProductStock>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    onHand: {
      type: Number, default: 0, min: 0,
      validate: { validator: Number.isSafeInteger, message: 'onHand must be a whole number of base units' },
    },
    lowStockThreshold: { type: Number, min: 0 },
    lowStockAlertedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One stock row per bar-product; also the lookup key for the sale CAS.
productStockSchema.index({ merchantId: 1, productId: 1 }, { unique: true });
// Aggregate one product across all bars ("Castle Lite across the event").
productStockSchema.index({ eventId: 1, productId: 1 });

export const ProductStock = mongoose.model<IProductStock>('ProductStock', productStockSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/models/__tests__/productStock.model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/productStock.model.ts src/models/__tests__/productStock.model.test.ts
git commit -m "feat(cashless-stock): ProductStock model (per-bar onHand, unique per bar-product)"
```

---

### Task 4: `StockMovement` model + movement enums

**Files:**
- Modify: `src/interfaces/stock.interface.ts`
- Create: `src/models/stockMovement.model.ts`
- Test: `src/models/__tests__/stockMovement.model.test.ts`

**Interfaces:**
- Produces: `StockMovementReason` enum (`receive`|`sale`|`transfer_in`|`transfer_out`|`count_adjust`|`spoilage`|`manual`); `StockMovementByType` type (`'Organizer'|'Merchant'|'Platform'`); `IStockMovement` (`eventId`, `merchantId`, `productId`, `delta` signed int, `reason`, `balanceAfter`, `refType?`, `refId?`, `byType`, `by`, `note?`, `at`); the `StockMovement` model.

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/__tests__/stockMovement.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockMovement } from '@models/stockMovement.model';
import { StockMovementReason } from '@interfaces/stock.interface';

const id = () => new mongoose.Types.ObjectId();

describe('StockMovement model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('records a signed delta and balanceAfter', async () => {
    const m = await StockMovement.create({
      eventId: id(), merchantId: id(), productId: id(),
      delta: -1, reason: StockMovementReason.SALE, balanceAfter: 144,
      byType: 'Merchant', by: 'm1',
    });
    expect(m.delta).toBe(-1);
    expect(m.balanceAfter).toBe(144);
  });

  it('rejects a non-integer delta', async () => {
    await expect(
      StockMovement.create({
        eventId: id(), merchantId: id(), productId: id(),
        delta: 1.5, reason: StockMovementReason.RECEIVE, balanceAfter: 10,
        byType: 'Organizer', by: 'o1',
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/__tests__/stockMovement.model.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Extend the interface**

Append to `src/interfaces/stock.interface.ts`:

```typescript
/** Why a stock quantity changed. The append-only journal's reason codes. */
export enum StockMovementReason {
  RECEIVE = 'receive',
  SALE = 'sale',
  TRANSFER_IN = 'transfer_in',
  TRANSFER_OUT = 'transfer_out',
  COUNT_ADJUST = 'count_adjust',
  SPOILAGE = 'spoilage',
  MANUAL = 'manual',
}

/** Who initiated a movement (for the audit trail). */
export type StockMovementByType = 'Organizer' | 'Merchant' | 'Platform';
```

- [ ] **Step 4: Create the model**

```typescript
// src/models/stockMovement.model.ts
import mongoose, { Schema, Document } from 'mongoose';
import { StockMovementReason, StockMovementByType } from '@interfaces/stock.interface';

/**
 * One append-only leg of the stock journal (design §4/§5). Written ONLY by
 * StockService.applyMovement. `balanceAfter` is the onHand immediately after
 * this movement — captures "stock before/after" for the itemised receipt and
 * the transaction log without recomputation. Per bar-product,
 * onHand == Σ delta (the invariant, property-tested).
 */
export interface IStockMovement extends Document {
  eventId: mongoose.Types.ObjectId;
  merchantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  delta: number; // signed integer base units, non-zero
  reason: StockMovementReason;
  balanceAfter: number;
  refType?: string;
  refId?: string;
  byType: StockMovementByType;
  by: string;
  note?: string;
  at: Date;
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    delta: {
      type: Number, required: true,
      validate: { validator: Number.isSafeInteger, message: 'delta must be a whole number of base units' },
    },
    reason: { type: String, enum: Object.values(StockMovementReason), required: true },
    balanceAfter: {
      type: Number, required: true, min: 0,
      validate: { validator: Number.isSafeInteger, message: 'balanceAfter must be a whole number' },
    },
    refType: { type: String },
    refId: { type: String },
    byType: { type: String, enum: ['Organizer', 'Merchant', 'Platform'], required: true },
    by: { type: String, required: true },
    note: { type: String, trim: true },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

// Per bar-product journal, newest first (statement view + Σ delta invariant).
stockMovementSchema.index({ merchantId: 1, productId: 1, at: -1 });
// Reporting: sales over time / peak hours (Slice 4).
stockMovementSchema.index({ eventId: 1, reason: 1, at: -1 });
// Provenance ("the movement for this charge/transfer/count").
stockMovementSchema.index({ refType: 1, refId: 1 });

export const StockMovement = mongoose.model<IStockMovement>('StockMovement', stockMovementSchema);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/models/__tests__/stockMovement.model.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/stock.interface.ts src/models/stockMovement.model.ts src/models/__tests__/stockMovement.model.test.ts
git commit -m "feat(cashless-stock): StockMovement journal model + reason enum"
```

---

### Task 5: `StockService.applyMovement` — the sole writer

**Files:**
- Create: `src/services/stock.service.ts`
- Test: `src/services/__tests__/stock.service.test.ts`

**Interfaces:**
- Consumes: `Product`, `ProductStock`, `StockMovement` models; `StockMovementReason`, `StockMovementByType`.
- Produces:
  - `class StockDeclinedError extends Error` with `{ reason: 'insufficient_stock', productId: string, available: number }`.
  - `StockService.applyMovement(input): Promise<{ onHand: number; movement: IStockMovement }>` where `input = { eventId, merchantId, productId, delta, reason, refType?, refId?, byType, by, note?, session? }`. Atomic: CAS-updates `ProductStock.onHand` (`$gte` guard on decrement; upsert on the first positive movement) and appends one `StockMovement` with `balanceAfter`. Owns its own transaction unless a caller `session` (already in a transaction) is passed. A decrement that would go negative throws `StockDeclinedError` and writes nothing.
  - `StockService.getOnHand(merchantId, productId, session?): Promise<number>` — 0 when no row.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/__tests__/stock.service.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockMovementReason } from '@interfaces/stock.interface';

const eventId = new mongoose.Types.ObjectId();
const merchantId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const base = { eventId, merchantId, productId, byType: 'Organizer' as const, by: 'o1' };

describe('StockService.applyMovement', () => {
  beforeAll(connectLedgerTestDb, 60000); // transactions need a replica set
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('receives stock: upserts the row and appends a movement', async () => {
    const { onHand, movement } = await StockService.applyMovement({
      ...base, delta: 500, reason: StockMovementReason.RECEIVE, refType: 'stock_receive', refId: 'r1',
    });
    expect(onHand).toBe(500);
    expect(movement.balanceAfter).toBe(500);
    const stock = await ProductStock.findOne({ merchantId, productId });
    expect(stock!.onHand).toBe(500);
  });

  it('a decrement CAS-guards against oversell and writes nothing on decline', async () => {
    await StockService.applyMovement({ ...base, delta: 3, reason: StockMovementReason.RECEIVE });
    await expect(
      StockService.applyMovement({ ...base, delta: -5, reason: StockMovementReason.SALE, refId: 'c1' }),
    ).rejects.toMatchObject({ reason: 'insufficient_stock', available: 3 });
    // balance untouched, no sale movement written
    expect((await ProductStock.findOne({ merchantId, productId }))!.onHand).toBe(3);
    expect(await StockMovement.countDocuments({ reason: StockMovementReason.SALE })).toBe(0);
  });

  it('a decrement with no stock row declines with available 0', async () => {
    await expect(
      StockService.applyMovement({ ...base, delta: -1, reason: StockMovementReason.SALE }),
    ).rejects.toBeInstanceOf(StockDeclinedError);
  });

  it('keeps onHand == Σ deltas after a mixed sequence', async () => {
    await StockService.applyMovement({ ...base, delta: 100, reason: StockMovementReason.RECEIVE });
    await StockService.applyMovement({ ...base, delta: -10, reason: StockMovementReason.SALE });
    await StockService.applyMovement({ ...base, delta: -4, reason: StockMovementReason.SALE });
    await StockService.applyMovement({ ...base, delta: 20, reason: StockMovementReason.RECEIVE });
    const stock = await ProductStock.findOne({ merchantId, productId });
    const rows = await StockMovement.find({ merchantId, productId });
    const sum = rows.reduce((s, r) => s + r.delta, 0);
    expect(stock!.onHand).toBe(106);
    expect(sum).toBe(106);
  });

  it('rejects a zero delta', async () => {
    await expect(
      StockService.applyMovement({ ...base, delta: 0, reason: StockMovementReason.MANUAL }),
    ).rejects.toThrow(/non-zero/);
  });

  it('N concurrent single-unit sales on the last 5 units: exactly 5 succeed, none oversell', async () => {
    await StockService.applyMovement({ ...base, delta: 5, reason: StockMovementReason.RECEIVE });
    const attempts = Array.from({ length: 12 }, (_, i) =>
      StockService.applyMovement({ ...base, delta: -1, reason: StockMovementReason.SALE, refId: `c${i}` })
        .then(() => 'ok').catch(() => 'declined'),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect((await ProductStock.findOne({ merchantId, productId }))!.onHand).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/services/__tests__/stock.service.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the service**

```typescript
// src/services/stock.service.ts
import mongoose, { ClientSession } from 'mongoose';
import { ProductStock, IProductStock } from '@models/productStock.model';
import { StockMovement, IStockMovement } from '@models/stockMovement.model';
import { StockMovementReason, StockMovementByType } from '@interfaces/stock.interface';

export class StockDeclinedError extends Error {
  readonly reason = 'insufficient_stock';
  constructor(public productId: string, public available: number) {
    super(`insufficient_stock: product ${productId} has ${available} on hand`);
    this.name = 'StockDeclinedError';
  }
}

export interface MovementInput {
  eventId: string | mongoose.Types.ObjectId;
  merchantId: string | mongoose.Types.ObjectId;
  productId: string | mongoose.Types.ObjectId;
  /** Signed base units, non-zero. > 0 adds (upserts the row), < 0 CAS-decrements. */
  delta: number;
  reason: StockMovementReason;
  refType?: string;
  refId?: string;
  byType: StockMovementByType;
  by: string;
  note?: string;
  /** Join a caller transaction (e.g. the item-sale charge, Slice 2). */
  session?: ClientSession;
}

/**
 * The ONLY writer of ProductStock.onHand and StockMovement (design §5). A
 * movement atomically CAS-updates onHand and appends a balanced journal row,
 * so onHand == Σ(deltas) holds by construction. A decrement below zero throws
 * StockDeclinedError and writes nothing — hard-block-at-zero, no silent clamp.
 */
export class StockService {
  static async applyMovement(input: MovementInput): Promise<{ onHand: number; movement: IStockMovement }> {
    const { delta, reason, refType, refId, byType, by, note } = input;
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new Error(`delta must be a non-zero whole number of base units, got ${delta}`);
    }
    const eventId = toId(input.eventId);
    const merchantId = toId(input.merchantId);
    const productId = toId(input.productId);

    if (input.session && !input.session.inTransaction()) {
      throw new Error('applyMovement requires the caller session to be in a transaction');
    }

    const work = async (session: ClientSession) => {
      const decrement = delta < 0;
      const filter: Record<string, unknown> = { merchantId, productId };
      // CAS guard: a decrement matches only when there is enough on hand.
      if (decrement) filter['onHand'] = { $gte: -delta };

      const stock = (await ProductStock.findOneAndUpdate(
        filter,
        // $ifNull covers the upsert-insert case where onHand doesn't exist yet.
        [{ $set: { onHand: { $add: [{ $ifNull: ['$onHand', 0] }, delta] }, eventId } }],
        { new: true, upsert: !decrement, setDefaultsOnInsert: true, session },
      )) as IProductStock | null;

      if (!stock) {
        // Decrement declined (or no row at all). Re-read to report the true available.
        const existing = await ProductStock.findOne({ merchantId, productId }, { onHand: 1 }, { session });
        throw new StockDeclinedError(String(productId), existing?.onHand ?? 0);
      }

      const [movement] = await StockMovement.create(
        [{ eventId, merchantId, productId, delta, reason, balanceAfter: stock.onHand, refType, refId, byType, by, note, at: new Date() }],
        { session },
      );
      return { onHand: stock.onHand, movement };
    };

    if (input.session) return work(input.session);

    const session = await mongoose.startSession();
    try {
      let result!: { onHand: number; movement: IStockMovement };
      await session.withTransaction(async () => { result = await work(session); });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /** Current on-hand for a bar-product; 0 when no row exists. Reporting only. */
  static async getOnHand(
    merchantId: string | mongoose.Types.ObjectId,
    productId: string | mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<number> {
    const row = await ProductStock.findOne({ merchantId: toId(merchantId), productId: toId(productId) }, { onHand: 1 }, { session ?? undefined } as any);
    return row?.onHand ?? 0;
  }
}

function toId(v: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId {
  return typeof v === 'string' ? new mongoose.Types.ObjectId(v) : v;
}
```

> Note on the `getOnHand` session arg: pass it plainly — `ProductStock.findOne(filter, projection).session(session ?? null)`. If the inline options object above trips the type-checker, rewrite as:
> ```typescript
> const q = ProductStock.findOne({ merchantId: toId(merchantId), productId: toId(productId) }, { onHand: 1 });
> const row = await (session ? q.session(session) : q);
> ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/services/__tests__/stock.service.test.ts`
Expected: PASS (all six, including the concurrency test — exactly 5 succeed).

- [ ] **Step 5: Commit**

```bash
git add src/services/stock.service.ts src/services/__tests__/stock.service.test.ts
git commit -m "feat(cashless-stock): StockService.applyMovement sole-writer + CAS hard-block"
```

---

### Task 6: Stock-ledger property test

**Files:**
- Test: `src/services/__tests__/stockLedger.property.test.ts`

**Interfaces:**
- Consumes: `StockService.applyMovement`, `ProductStock`, `StockMovement`.

- [ ] **Step 1: Write the property test**

```typescript
// src/services/__tests__/stockLedger.property.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockMovementReason } from '@interfaces/stock.interface';

// Deterministic PRNG (no Math.random — reproducible failures).
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

describe('stock ledger invariant: onHand == Σ deltas', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('holds after 200 random receive/sale movements', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const merchantId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const base = { eventId, merchantId, productId, byType: 'Organizer' as const, by: 'o1' };
    const rng = makeRng(42);

    for (let i = 0; i < 200; i++) {
      const isReceive = rng() < 0.5;
      const qty = 1 + Math.floor(rng() * 20);
      try {
        await StockService.applyMovement({
          ...base,
          delta: isReceive ? qty : -qty,
          reason: isReceive ? StockMovementReason.RECEIVE : StockMovementReason.SALE,
          refId: `m${i}`,
        });
      } catch (e) {
        // Declines (oversell attempts) are expected and must leave state consistent.
        expect(e).toBeInstanceOf(StockDeclinedError);
      }
    }

    const stock = await ProductStock.findOne({ merchantId, productId });
    const rows = await StockMovement.find({ merchantId, productId });
    const sum = rows.reduce((s, r) => s + r.delta, 0);
    expect(stock!.onHand).toBe(sum);
    expect(stock!.onHand).toBeGreaterThanOrEqual(0);
    // balanceAfter of the last movement equals the final onHand.
    const last = rows.sort((a, b) => a.at.getTime() - b.at.getTime()).at(-1);
    if (last) expect(last.balanceAfter).toBe(stock!.onHand);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (implementation already exists)

Run: `npx jest src/services/__tests__/stockLedger.property.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/services/__tests__/stockLedger.property.test.ts
git commit -m "test(cashless-stock): stock-ledger invariant property test"
```

---

### Task 7: Organiser product CRUD + receive-stock (validators, controller, routes)

**Files:**
- Create: `src/validators/stock.validator.ts`
- Create: `src/controllers/stockAdmin.controller.ts`
- Modify: `src/routes/tickets.route.ts`
- Test: `src/routes/__tests__/stockAdmin.route.test.ts`

**Interfaces:**
- Consumes: `Product`, `ProductStock`, `StockService.applyMovement`, `ApiResponseUtil`, `requireTicketsPermission`, `TicketsPermission.MANAGE_STOCK`, the `Event` model (ownership).
- Produces (routes, all under `/api/tickets`, `MANAGE_STOCK`-gated, event-ownership enforced):
  - `POST /events/:eventId/products` `{ name, category, price, barcode?, unitLabel?, unitsPerPack?, packLabel?, imageUrl? }` → created product.
  - `GET /events/:eventId/products` → the event's products.
  - `PATCH /products/:id` `{ name?, price?, category?, barcode?, unitLabel?, unitsPerPack?, packLabel?, imageUrl?, active? }`.
  - `POST /events/:eventId/stock/receive` `{ merchantId, productId, quantity, unit?: 'unit'|'pack', note? }` → `{ onHand }` after applying a `receive` movement (packs converted via the product's `unitsPerPack`).

- [ ] **Step 1: Write the failing route tests**

```typescript
// src/routes/__tests__/stockAdmin.route.test.ts
// Harness copied verbatim from src/routes/__tests__/merchantCharge.route.test.ts:
//   app from '@/app', connectLedgerTestDb (routes use transactions),
//   signVendorToken(vendorId, { permissions }) and seedPublishedEvent() ->
//   { eventId, vendorId }. No new helpers are needed.
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginSeq = 900001;

/** A published cashless event + a MANAGE_STOCK owner token for its vendor. */
async function ownedCashlessEvent() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  return { eventId: String(eventId), vendorId: String(vendorId), token };
}

describe('stock admin routes', () => {
  it('creates and lists products for an owned event', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const create = await request(app)
      .post(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Castle Lite 330ml', category: 'beer', price: 2500, barcode: '6001240100015', unitsPerPack: 24, packLabel: 'case' });
    expect(create.status).toBe(201);
    expect(create.body.data.name).toBe('Castle Lite 330ml');

    const list = await request(app)
      .get(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('rejects a caller without MANAGE_STOCK', async () => {
    const { eventId, vendorId } = await ownedCashlessEvent();
    const token = signVendorToken(vendorId, { permissions: [] });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', category: 'other', price: 100 });
    expect(res.status).toBe(403);
  });

  it("forbids managing another vendor's event", async () => {
    const { token } = await ownedCashlessEvent();        // token for vendor A
    const other = await seedPublishedEvent({});           // event owned by vendor B
    const res = await request(app)
      .post(`/api/tickets/events/${other.eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', category: 'other', price: 100 });
    expect(res.status).toBe(403);
  });

  it('receives stock in packs and converts to base units', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const merchant = await Merchant.create({ name: 'Bar 4', eventId, loginCode: String(__loginSeq++), pin: '000000' });
    const product = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500, unitsPerPack: 24 });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({ merchantId: String(merchant._id), productId: String(product._id), quantity: 50, unit: 'pack' });
    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(1200); // 50 * 24
  });

  it('rejects receiving a product from a different event', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const merchant = await Merchant.create({ name: 'Bar 4', eventId, loginCode: String(__loginSeq++), pin: '000000' });
    const foreignProduct = await Product.create({ eventId: new mongoose.Types.ObjectId(), name: 'Nope', category: 'beer', price: 100 });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({ merchantId: String(merchant._id), productId: String(foreignProduct._id), quantity: 10 });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/routes/__tests__/stockAdmin.route.test.ts`
Expected: FAIL (routes not mounted).

- [ ] **Step 3: Create the validators**

```typescript
// src/validators/stock.validator.ts
import Joi from 'joi';
import { ProductCategory } from '@interfaces/stock.interface';

const MAX_PRICE_CENTS = 100_000_00; // R100,000/unit ceiling, defense-in-depth
const MAX_QTY = 1_000_000;

export const createProductSchema = Joi.object({
  name: Joi.string().trim().min(1).required(),
  category: Joi.string().valid(...Object.values(ProductCategory)).required(),
  price: Joi.number().integer().min(0).max(MAX_PRICE_CENTS).required(),
  barcode: Joi.string().trim().min(3).optional(),
  unitLabel: Joi.string().trim().optional(),
  unitsPerPack: Joi.number().integer().min(1).optional(),
  packLabel: Joi.string().trim().optional(),
  imageUrl: Joi.string().trim().uri().optional(),
});

export const updateProductSchema = Joi.object({
  name: Joi.string().trim().min(1),
  category: Joi.string().valid(...Object.values(ProductCategory)),
  price: Joi.number().integer().min(0).max(MAX_PRICE_CENTS),
  barcode: Joi.string().trim().min(3).allow(null),
  unitLabel: Joi.string().trim(),
  unitsPerPack: Joi.number().integer().min(1).allow(null),
  packLabel: Joi.string().trim().allow(null),
  imageUrl: Joi.string().trim().uri().allow(null),
  active: Joi.boolean(),
}).min(1);

export const receiveStockSchema = Joi.object({
  merchantId: Joi.string().trim().required(),
  productId: Joi.string().trim().required(),
  quantity: Joi.number().integer().min(1).max(MAX_QTY).required(),
  unit: Joi.string().valid('unit', 'pack').default('unit'),
  note: Joi.string().trim().optional(),
});
```

- [ ] **Step 4: Create the controller**

```typescript
// src/controllers/stockAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { createProductSchema, updateProductSchema, receiveStockSchema } from '@validators/stock.validator';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

// Mirrors MerchantAdminController.loadOwnedEvent — a product/stock op is only
// allowed by the owner of the event it belongs to (super-admin bypasses).
async function loadOwnedEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  if (!eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return null; }
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  const actor = actorOf(req);
  if (!actor.isSuperAdmin && String(event.vendorId) !== actor.vendorId) {
    ApiResponseUtil.forbidden(res, 'Event belongs to a different vendor'); return null;
  }
  return event;
}

export class StockAdminController {
  /** POST /api/tickets/events/:eventId/products */
  static async createProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = createProductSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      try {
        const product = await Product.create({ ...value, eventId: event._id });
        ApiResponseUtil.created(res, product);
      } catch (e: any) {
        if (e?.code === 11000) { ApiResponseUtil.badRequest(res, 'A product with that barcode already exists at this event'); return; }
        throw e;
      }
    } catch (err) { next(err); }
  }

  /** GET /api/tickets/events/:eventId/products */
  static async listProducts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const products = await Product.find({ eventId: event._id }).sort({ name: 1 });
      ApiResponseUtil.success(res, products);
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/products/:id */
  static async updateProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const product = await Product.findById(req.params['id']);
      if (!product) { ApiResponseUtil.notFound(res, 'Product not found'); return; }
      const event = await loadOwnedEvent(req, res, String(product.eventId));
      if (!event) return;
      const { error, value } = updateProductSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      Object.assign(product, value);
      try {
        await product.save();
      } catch (e: any) {
        if (e?.code === 11000) { ApiResponseUtil.badRequest(res, 'A product with that barcode already exists at this event'); return; }
        throw e;
      }
      ApiResponseUtil.success(res, product);
    } catch (err) { next(err); }
  }

  /** POST /api/tickets/events/:eventId/stock/receive */
  static async receiveStock(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = receiveStockSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }

      const merchant = await Merchant.findById(value.merchantId).lean();
      if (!merchant || String(merchant.eventId) !== String(event._id)) {
        ApiResponseUtil.badRequest(res, 'merchant does not belong to this event'); return;
      }
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) {
        ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return;
      }

      // Case->unit conversion: 'pack' quantities multiply by unitsPerPack.
      const perPack = product.unitsPerPack && product.unitsPerPack > 0 ? product.unitsPerPack : 1;
      if (value.unit === 'pack' && perPack === 1) {
        ApiResponseUtil.badRequest(res, 'product has no pack size; receive in units'); return;
      }
      const baseUnits = value.unit === 'pack' ? value.quantity * perPack : value.quantity;

      const actor = actorOf(req);
      const { onHand, movement } = await StockService.applyMovement({
        eventId: String(event._id),
        merchantId: value.merchantId,
        productId: value.productId,
        delta: baseUnits,
        reason: StockMovementReason.RECEIVE,
        refType: 'stock_receive',
        refId: String(movementRef()),
        byType: 'Organizer',
        by: actor.vendorId ?? 'platform',
        note: value.note,
      });
      ApiResponseUtil.success(res, { onHand, movementId: String(movement._id) });
    } catch (err) { next(err); }
  }
}

// A receive is organiser-initiated and not client-idempotent in v1; a fresh
// ObjectId gives each receive a stable refId for provenance without a
// clientTxnId contract (the sale path in Slice 2 will carry a real clientTxnId).
import mongoose from 'mongoose';
function movementRef() { return new mongoose.Types.ObjectId(); }
```

- [ ] **Step 5: Mount the routes**

In `src/routes/tickets.route.ts`:
- Add the import near the other controller imports:
  ```typescript
  import { StockAdminController } from '@controllers/stockAdmin.controller';
  ```
- Add this block next to the merchant/cashless routes (before `export default router;`):
  ```typescript
  /**
   * Cashless Stock/Inventory — organiser manages the product catalogue and
   * loads per-bar stock (design 2026-08-12, Slice 1). MANAGE_STOCK gate +
   * event-ownership enforced in the controller.
   */
  router.post('/events/:eventId/products', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.createProduct);
  router.get('/events/:eventId/products', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.listProducts);
  router.patch('/products/:id', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.updateProduct);
  router.post('/events/:eventId/stock/receive', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.receiveStock);
  ```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/routes/__tests__/stockAdmin.route.test.ts`
Expected: PASS. (If auth/app import shapes differ, align the two flagged imports with `merchantCharge.route.test.ts`; the status-code assertions are the contract.)

- [ ] **Step 7: Full slice test + typecheck**

Run: `npx jest src/interfaces/__tests__/ticketsPermission.stock.test.ts src/models/__tests__/product.model.test.ts src/models/__tests__/productStock.model.test.ts src/models/__tests__/stockMovement.model.test.ts src/services/__tests__/stock.service.test.ts src/services/__tests__/stockLedger.property.test.ts src/routes/__tests__/stockAdmin.route.test.ts`
Then: `npx tsc --noEmit`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/validators/stock.validator.ts src/controllers/stockAdmin.controller.ts src/routes/tickets.route.ts src/routes/__tests__/stockAdmin.route.test.ts
git commit -m "feat(cashless-stock): organiser product CRUD + receive-stock (pack<->unit)"
```

---

## Self-Review

**Spec coverage (Slice 1 scope = design §12 slice 1: "Catalogue + stock models & service — Product, ProductStock, StockMovement, StockService.post (sole writer), organiser product/stock CRUD + receive, tests incl. stock-ledger property test"):**
- `Product` model → Task 2. `ProductStock` → Task 3. `StockMovement` → Task 4. Sole-writer service (`StockService.applyMovement`, named per the API here rather than `post`) → Task 5. Stock-ledger property test → Task 6. Organiser product CRUD + receive → Task 7. `MANAGE_STOCK` permission the CRUD needs → Task 1. ✅ All Slice 1 items covered. Transfers, counts, low-stock alerts, item-sales, and reporting are explicitly LATER slices (design §12 slices 2–4) — out of scope here, by design.

**Placeholder scan:** No TBD/TODO. The route test uses the real, verified harness (`app from '@/app'`, `signVendorToken`, `seedPublishedEvent`, `connectLedgerTestDb`) taken from `merchantCharge.route.test.ts` — no invented helpers. The `getOnHand` session-typing note in Task 5 gives a concrete fallback rewrite, not a blank.

**Type consistency:** `StockService.applyMovement` input/return, `StockDeclinedError` (`reason:'insufficient_stock'`, `productId`, `available`), `StockMovementReason`, `StockMovementByType`, `ProductCategory`, and the model interfaces are used identically across Tasks 4–7. Routes are all under `/api/tickets/...` matching the shipped namespace. Permission name `MANAGE_STOCK` is consistent Task 1 → Task 7.

**Note for the executing agent:** `StockService.applyMovement` and the route tests use transactions, so they require the **replica-set** test helper (`connectLedgerTestDb`), not `connectTestDb`. Plain model tests (Tasks 2–4) use `connectTestDb`. Confirm `src/__tests__/helpers/mongo.ts` and the auth helper import path against an existing cashless route test before running.

---

## Downstream slices (own plans, written after this one ships)

Per design §12, each gets its own plan/PR onto the cashless line: **Slice 2** item sales in the charge (extend `MerchantService.charge` with line items + per-product stock CAS + `MerchantCharge.items`/`staffName`); **Slice 3** transfers + counts + low-stock alerts; **Slice 4** reporting (board/reconciliation/dashboard/movements); **Slice 5** POS basket + stock-take; **Slice 6** dashboard Stock UI; **Slice 7** seed + docs.
