# Cashless Stock — Slice 2: Item-Sale Charge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `MerchantService.charge` so a vendor tap can sell specific products (server-priced) and deduct their per-bar stock inside the same atomic transaction as the wallet debit, hard-blocking any out-of-stock line — while preserving the existing amount-only charge.

**Architecture:** No new modules. Add `items[]`+`staffName?` to `MerchantCharge`; make `chargeSchema` accept `amount` XOR `items`; inside the existing `session.withTransaction`, after the wallet CAS debit and before the ledger post, decrement each line's stock via `StockService.applyMovement` (Slice 1's sole-writer, joined onto the charge's session). A `StockDeclinedError` aborts the transaction, rolling the wallet debit back. `MerchantCharge.amount` stays the ledger-authoritative total, so the money ledger is unchanged.

**Tech Stack:** Node + TypeScript, Express, Mongoose (replica set for transactions), Joi, Jest + `mongodb-memory-server`. Path aliases `@models/* @services/* @interfaces/* @controllers/* @validators/* @utils/*`.

## Global Constraints

- **Base branch:** `feat/cashless-stock-sale` off `feat/cashless-cashier` @105d3dc (Slice 1 merged), fresh worktree. Merge onto the cashless line, not `main`.
- **Money ledger unchanged:** no change to `LedgerService` or the three charge legs (`wallet +amount`, `merchant −net`, `fees −fee`). `MerchantCharge.amount` remains `= Σ lineTotal` for itemised sales.
- **Sole writer:** stock is mutated ONLY via `StockService.applyMovement` (reason `'sale'`) — the charge never touches `ProductStock`/`StockMovement` directly.
- **All-or-nothing:** any out-of-stock line aborts the whole tap; nothing (wallet, stock, ledger, charge) is committed on a decline.
- **Server-authoritative pricing:** with `items`, `amount = Σ (catalogue price × qty)`; a client `amount` is never trusted alongside `items` (validator `.xor`).
- **Amount-only path preserved** (approved decision #5): `{ bandUid, amount, clientTxnId }` still works, touches no stock, stores no `items`. Existing `merchantCharge.*.test.ts` must stay green unchanged.
- **Fail loudly:** out-of-stock → 409; product-resolution failure → 400; never silently fall back to an amount-only charge when items fail to resolve.
- **Decline errors propagate:** `StockDeclinedError` and `WalletDeclinedError` must bubble out of `charge()` — the `catch` there handles ONLY `code === 11000`.
- Money integer ZAR cents; stock integer base units; snapshot `name`/`unitPrice` at sale time.

---

### Task 1: `MerchantCharge` — `items[]` + `staffName`

**Files:**
- Modify: `src/models/merchantCharge.model.ts`
- Test: `src/models/__tests__/merchantCharge.model.test.ts` (create if absent)

**Interfaces:**
- Produces: `IMerchantCharge.items?: Array<{ productId: ObjectId, name: string, unitPrice: number, qty: number, lineTotal: number }>` and `IMerchantCharge.staffName?: string`. Both optional; existing rows valid without them.

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/__tests__/merchantCharge.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { MerchantCharge } from '@models/merchantCharge.model';

const id = () => new mongoose.Types.ObjectId();

describe('MerchantCharge items + staffName', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('persists an itemised charge with a line-item snapshot and staffName', async () => {
    const c = await MerchantCharge.create({
      merchantId: id(), eventId: id(), walletId: id(), bandUid: '04aabbccddee',
      amount: 6500, fee: 0, netAmount: 6500, clientTxnId: 'c1', status: 'completed',
      staffName: 'Sipho',
      items: [
        { productId: id(), name: 'Castle Lite 330ml', unitPrice: 2500, qty: 2, lineTotal: 5000 },
        { productId: id(), name: 'Water 500ml', unitPrice: 1500, qty: 1, lineTotal: 1500 },
      ],
    });
    expect(c.items).toHaveLength(2);
    expect(c.items![0].lineTotal).toBe(5000);
    expect(c.staffName).toBe('Sipho');
  });

  it('still persists an amount-only charge with no items (un-itemised)', async () => {
    const c = await MerchantCharge.create({
      merchantId: id(), eventId: id(), walletId: id(), bandUid: '04aabbccddee',
      amount: 300, fee: 0, netAmount: 300, clientTxnId: 'c2', status: 'completed',
    });
    expect(c.items).toBeUndefined();
    expect(c.staffName).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/__tests__/merchantCharge.model.test.ts`
Expected: FAIL (itemised create fails schema / `items` stripped).

- [ ] **Step 3: Extend the model**

In `src/models/merchantCharge.model.ts`:
- Add to `IMerchantCharge` (after `netAmount`):
  ```typescript
  items?: Array<{ productId: Types.ObjectId; name: string; unitPrice: number; qty: number; lineTotal: number }>;
  staffName?: string;
  ```
- Add to the schema (a subdocument array; no separate `_id` needed on lines):
  ```typescript
  items: {
    type: [new Schema({
      productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
      name: { type: String, required: true },
      unitPrice: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'unitPrice must be integer cents' } },
      qty: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
      lineTotal: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'lineTotal must be integer cents' } },
    }, { _id: false })],
    required: false,
  },
  staffName: { type: String, trim: true },
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/models/__tests__/merchantCharge.model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/merchantCharge.model.ts src/models/__tests__/merchantCharge.model.test.ts
git commit -m "feat(cashless-stock): MerchantCharge line-items + staffName (additive)"
```

---

### Task 2: `chargeSchema` — `amount` XOR `items` (+ `staffName`)

**Files:**
- Modify: `src/validators/merchant.validator.ts`
- Test: `src/validators/__tests__/merchant.validator.test.ts` (create if absent)

**Interfaces:**
- Produces: `chargeSchema` accepting `{ bandUid, clientTxnId, staffName?, amount? , items?: [{productId, qty}] }` with `.xor('amount','items')`; exports `MAX_LINES` and `MAX_QTY_PER_LINE`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/validators/__tests__/merchant.validator.test.ts
import { chargeSchema } from '@validators/merchant.validator';

const base = { bandUid: '04aabbccddee', clientTxnId: 'c1' };

describe('chargeSchema amount|items xor', () => {
  it('accepts an amount-only charge', () => {
    expect(chargeSchema.validate({ ...base, amount: 300 }).error).toBeUndefined();
  });
  it('accepts an itemised charge with staffName', () => {
    const { error } = chargeSchema.validate({ ...base, staffName: 'Sipho', items: [{ productId: 'p1', qty: 2 }] });
    expect(error).toBeUndefined();
  });
  it('rejects sending BOTH amount and items', () => {
    expect(chargeSchema.validate({ ...base, amount: 300, items: [{ productId: 'p1', qty: 1 }] }).error).toBeDefined();
  });
  it('rejects sending NEITHER', () => {
    expect(chargeSchema.validate({ ...base }).error).toBeDefined();
  });
  it('rejects an empty items array', () => {
    expect(chargeSchema.validate({ ...base, items: [] }).error).toBeDefined();
  });
  it('rejects a non-positive qty', () => {
    expect(chargeSchema.validate({ ...base, items: [{ productId: 'p1', qty: 0 }] }).error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/validators/__tests__/merchant.validator.test.ts`
Expected: FAIL (both-accepted / neither-rejected not yet enforced).

- [ ] **Step 3: Update the validator**

Replace the body of `src/validators/merchant.validator.ts` with (keep the `uid` + `MAX_CHARGE_CENTS` import):

```typescript
import Joi from 'joi';
import { MAX_CHARGE_CENTS } from '@services/merchant.service';

const uid = Joi.string().trim().lowercase().pattern(/^[0-9a-f]{8,}$/);

export const MAX_LINES = 50;
export const MAX_QTY_PER_LINE = 1000;

/**
 * POST /api/merchant/charge — tap-to-pay debit. Exactly one of `amount`
 * (amount-only, un-itemised) or `items` (itemised, server-priced from the
 * catalogue) must be present. merchantId/eventId come from the JWT.
 */
export const chargeSchema = Joi.object({
  bandUid: uid.required(),
  clientTxnId: Joi.string().trim().required(),
  staffName: Joi.string().trim().max(80).optional(),
  amount: Joi.number().integer().min(1).max(MAX_CHARGE_CENTS),
  items: Joi.array()
    .items(Joi.object({
      productId: Joi.string().trim().required(),
      qty: Joi.number().integer().min(1).max(MAX_QTY_PER_LINE).required(),
    }))
    .min(1).max(MAX_LINES),
}).xor('amount', 'items');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/validators/__tests__/merchant.validator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validators/merchant.validator.ts src/validators/__tests__/merchant.validator.test.ts
git commit -m "feat(cashless-stock): charge validator accepts amount XOR items + staffName"
```

---

### Task 3: `MerchantService.charge` — itemised pricing + stock decrement

**Files:**
- Modify: `src/services/merchant.service.ts`
- Test: `src/services/__tests__/merchantCharge.items.service.test.ts`

**Interfaces:**
- Consumes: `Product` (`@models/product.model`), `StockService` + `StockDeclinedError` (`@services/stock.service`), `StockMovementReason` (`@interfaces/stock.interface`).
- Produces: `charge` accepts `{ merchantId, eventId, walletId, bandUid, clientTxnId, amount?, items?: [{productId, qty}], staffName? }` (exactly one of `amount`/`items`); returns `{ wallet, charge }` where an itemised charge carries `items`/`staffName`. Throws `StockDeclinedError` (propagates) on an out-of-stock line — wallet, stock, ledger, and charge all left untouched.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/__tests__/merchantCharge.items.service.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { MerchantService } from '@services/merchant.service';
import { StockDeclinedError, StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { Wallet } from '@models/wallet.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType } from '@interfaces/ledger.interface';

const eventId = new mongoose.Types.ObjectId();

async function seed({ balance = 100000, beerStock = 100, waterStock = 100, commissionPercent = 0 } = {}) {
  const merchant = await Merchant.create({ name: 'Bar 1', eventId, commissionPercent, loginCode: String(Math.floor(100000 + Math.random() * 800000)), pin: '000000' } as any);
  const beer = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 });
  const water = await Product.create({ eventId, name: 'Water', category: 'water', price: 1500 });
  const wallet = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), bandUid: '04aabbccddee', balance, cashFundedBalance: balance, status: 'active', currency: 'ZAR' } as any);
  const by = String(merchant._id);
  if (beerStock) await StockService.applyMovement({ eventId, merchantId: merchant._id, productId: beer._id, delta: beerStock, reason: StockMovementReason.RECEIVE, byType: 'Merchant', by });
  if (waterStock) await StockService.applyMovement({ eventId, merchantId: merchant._id, productId: water._id, delta: waterStock, reason: StockMovementReason.RECEIVE, byType: 'Merchant', by });
  return { merchant, beer, water, wallet };
}
const chargeArgs = (m: any, w: any, extra: any) => ({ merchantId: String(m._id), eventId: String(eventId), walletId: String(w._id), bandUid: w.bandUid, clientTxnId: 'c1', ...extra });

describe('MerchantService.charge — itemised', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('prices from the catalogue, debits once, and decrements each product', async () => {
    const { merchant, beer, water, wallet } = await seed();
    const { wallet: w, charge } = await MerchantService.charge(chargeArgs(merchant, wallet, {
      items: [{ productId: String(beer._id), qty: 2 }, { productId: String(water._id), qty: 1 }],
      staffName: 'Sipho',
    }));
    expect(charge.amount).toBe(2 * 2500 + 1500);         // server-priced = 6500
    expect(w.balance).toBe(100000 - 6500);                // debited once
    expect(charge.items).toHaveLength(2);
    expect(charge.staffName).toBe('Sipho');
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(98);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: water._id }))!.onHand).toBe(99);
    // money ledger unchanged in shape
    expect(await LedgerService.totalOwed(String(eventId), LedgerAccountType.MERCHANT)).toBe(6500);
  });

  it('hard-blocks an out-of-stock line and rolls EVERYTHING back', async () => {
    const { merchant, beer, water, wallet } = await seed({ waterStock: 0 });
    await expect(MerchantService.charge(chargeArgs(merchant, wallet, {
      items: [{ productId: String(beer._id), qty: 1 }, { productId: String(water._id), qty: 1 }],
    }))).rejects.toBeInstanceOf(StockDeclinedError);
    // nothing committed: wallet full, beer NOT decremented, no charge row
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(100);
    expect(await MerchantCharge.countDocuments({ merchantId: merchant._id })).toBe(0);
  });

  it('N concurrent itemised taps on the last 5 beers: exactly 5 succeed, no oversell', async () => {
    const { merchant, beer } = await seed({ beerStock: 5, waterStock: 0 });
    // one funded wallet per tap
    const wallets = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), bandUid: `04aabbccdd${String(i).padStart(2, '0')}`, balance: 100000, cashFundedBalance: 100000, status: 'active', currency: 'ZAR' } as any)));
    const results = await Promise.all(wallets.map((w, i) =>
      MerchantService.charge({ merchantId: String(merchant._id), eventId: String(eventId), walletId: String(w._id), bandUid: w.bandUid, clientTxnId: `c${i}`, items: [{ productId: String(beer._id), qty: 1 }] })
        .then(() => 'ok').catch((e) => e instanceof StockDeclinedError ? 'declined' : Promise.reject(e))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(0);
  });

  it('is idempotent on {merchantId, clientTxnId}: stock + money apply once', async () => {
    const { merchant, beer, wallet } = await seed();
    const args = chargeArgs(merchant, wallet, { items: [{ productId: String(beer._id), qty: 3 }] });
    const first = await MerchantService.charge(args);
    const second = await MerchantService.charge(args);
    expect(String(second.charge._id)).toBe(String(first.charge._id));
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(97); // −3 once
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000 - 3 * 2500);
  });

  it('preserves the amount-only path (no items, no stock touched)', async () => {
    const { merchant, beer, wallet } = await seed();
    const { charge } = await MerchantService.charge(chargeArgs(merchant, wallet, { amount: 300 }));
    expect(charge.amount).toBe(300);
    expect(charge.items).toBeUndefined();
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(100); // untouched
  });

  it('rejects a product from a different event, writing nothing', async () => {
    const { merchant, wallet } = await seed();
    const foreign = await Product.create({ eventId: new mongoose.Types.ObjectId(), name: 'Nope', category: 'beer', price: 100 });
    await expect(MerchantService.charge(chargeArgs(merchant, wallet, { items: [{ productId: String(foreign._id), qty: 1 }] }))).rejects.toThrow();
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/services/__tests__/merchantCharge.items.service.test.ts`
Expected: FAIL (charge ignores `items`).

- [ ] **Step 3: Extend the service**

In `src/services/merchant.service.ts`:
- Add imports at the top:
  ```typescript
  import { Product } from '@models/product.model';
  import { StockService, StockDeclinedError } from '@services/stock.service';
  import { StockMovementReason } from '@interfaces/stock.interface';
  ```
  (Re-export `StockDeclinedError` from here too, so the controller can import both declines from `@services/merchant.service` if convenient: `export { StockDeclinedError };` — optional.)
- Change the `charge` signature and add pricing + stock steps. The full method becomes:
  ```typescript
  static async charge(params: {
    merchantId: string; eventId: string; walletId: string; bandUid: string;
    clientTxnId: string;
    amount?: number;
    items?: Array<{ productId: string; qty: number }>;
    staffName?: string;
  }): Promise<{ wallet: IWallet; charge: IMerchantCharge }> {
    const { merchantId, eventId, walletId, bandUid, clientTxnId, staffName } = params;

    const hasItems = Array.isArray(params.items) && params.items.length > 0;
    const hasAmount = params.amount != null;
    if (hasItems === hasAmount) throw new Error('provide exactly one of amount or items');

    // Idempotency: if this clientTxnId already ran FOR THIS MERCHANT, return it.
    const existing = await MerchantCharge.findOne({ merchantId, clientTxnId });
    if (existing) {
      const w = await Wallet.findById(existing.walletId);
      if (!w) throw new Error('wallet not found');
      return { wallet: w, charge: existing };
    }

    // Resolve amount + item snapshots BEFORE the transaction (prices are stable;
    // the atomic guard is the per-product stock CAS inside the txn).
    let amount: number;
    let itemSnapshots: Array<{ productId: mongoose.Types.ObjectId; name: string; unitPrice: number; qty: number; lineTotal: number }> | undefined;
    if (hasItems) {
      const merged = new Map<string, number>();
      for (const { productId, qty } of params.items!) {
        if (!Number.isInteger(qty) || qty <= 0) throw new Error('qty must be a positive integer');
        merged.set(String(productId), (merged.get(String(productId)) ?? 0) + qty);
      }
      const ids = [...merged.keys()];
      const products = await Product.find({ _id: { $in: ids }, eventId, active: true }).lean();
      if (products.length !== ids.length) throw new Error('one or more products not found for this event');
      const byId = new Map(products.map((p) => [String(p._id), p]));
      itemSnapshots = ids.map((pid) => {
        const p = byId.get(pid)!;
        const qty = merged.get(pid)!;
        return { productId: p._id as mongoose.Types.ObjectId, name: p.name, unitPrice: p.price, qty, lineTotal: p.price * qty };
      });
      amount = itemSnapshots.reduce((s, l) => s + l.lineTotal, 0);
    } else {
      amount = params.amount!;
    }
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer (cents)');
    if (amount > MAX_CHARGE_CENTS) throw new Error('amount exceeds the maximum allowed charge');

    const session = await mongoose.startSession();
    try {
      let out!: { wallet: IWallet; charge: IMerchantCharge };
      await session.withTransaction(async () => {
        const merchant = await Merchant.findById(merchantId).session(session);
        if (!merchant || merchant.status !== 'active') throw new Error('merchant not found or not active');

        const wallet = await Wallet.findOneAndUpdate(
          { _id: walletId, eventId, status: 'active', balance: { $gte: amount } },
          [{ $set: {
            balance: { $subtract: ['$balance', amount] },
            cashFundedBalance: { $max: [0, { $subtract: ['$cashFundedBalance', amount] }] },
          } }],
          { new: true, session },
        );
        if (!wallet) {
          const fresh = await Wallet.findOne({ _id: walletId, eventId }).session(session);
          if (!fresh) throw new WalletDeclinedError('wallet_not_found', 'wallet not found', null);
          if (fresh.status !== 'active') throw new WalletDeclinedError('wallet_not_active', 'wallet is not active', fresh.balance);
          throw new WalletDeclinedError('insufficient_balance', 'insufficient balance', fresh.balance);
        }

        // NEW: decrement stock per line inside the SAME transaction. A
        // StockDeclinedError aborts the txn → the wallet debit above rolls back.
        if (itemSnapshots) {
          for (const line of itemSnapshots) {
            await StockService.applyMovement({
              eventId, merchantId, productId: String(line.productId), delta: -line.qty,
              reason: StockMovementReason.SALE, refType: 'merchant_charge', refId: clientTxnId,
              byType: 'Merchant', by: merchantId, session,
            });
          }
        }

        const commissionPercent = merchant.commissionPercent || 0;
        const fee = Math.floor((amount * commissionPercent) / 100);
        const net = amount - fee;

        await LedgerService.post({
          eventId,
          postings: [
            { account: { type: LedgerAccountType.WALLET, ref: walletId }, delta: amount },
            { account: { type: LedgerAccountType.MERCHANT, ref: merchantId }, delta: -net },
            ...(fee > 0 ? [{ account: { type: LedgerAccountType.FEES }, delta: -fee }] : []),
          ],
          refType: 'merchant_charge', refId: clientTxnId, session,
        });

        const [charge] = await MerchantCharge.create([{
          merchantId, eventId, walletId, bandUid, amount, fee, netAmount: net, clientTxnId, status: 'completed',
          ...(itemSnapshots ? { items: itemSnapshots } : {}),
          ...(staffName ? { staffName } : {}),
        }], { session });
        if (!charge) throw new Error('merchant charge insert failed');
        out = { wallet, charge };
      });
      return out;
    } catch (e) {
      if ((e as { code?: number })?.code === 11000) {
        const charge = await MerchantCharge.findOne({ merchantId, clientTxnId });
        const wallet = charge ? await Wallet.findById(charge.walletId) : null;
        if (charge && wallet) return { wallet, charge };
      }
      throw e; // WalletDeclinedError / StockDeclinedError / resolution errors propagate
    } finally {
      await session.endSession();
    }
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/services/__tests__/merchantCharge.items.service.test.ts`
Then: `npx jest src/services/__tests__/merchantCharge.service.test.ts` (the pre-existing amount-only service tests — must stay green).
Then: `npx tsc --noEmit`
Expected: all PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/merchant.service.ts src/services/__tests__/merchantCharge.items.service.test.ts
git commit -m "feat(cashless-stock): item-sale charge — server pricing + atomic stock decrement"
```

---

### Task 4: Controller — decline mapping + itemised response

**Files:**
- Modify: `src/controllers/merchant.controller.ts`
- Test: `src/routes/__tests__/merchantChargeItems.route.test.ts`

**Interfaces:**
- Consumes: extended `chargeSchema`, `MerchantService.charge`, `StockDeclinedError`.
- Produces: `POST /api/merchant/charge` accepts the itemised body; returns `{ newBalance, amount, fee, merchantNet, items? }`; maps `StockDeclinedError` → **409** `{ reason:'insufficient_stock', productId, available }`, `WalletDeclinedError` → 402 (unchanged), resolution errors → 400.

- [ ] **Step 1: Write the failing route tests**

```typescript
// src/routes/__tests__/merchantChargeItems.route.test.ts
// Harness mirrors merchantCharge.route.test.ts (app, JWT token(), connectLedgerTestDb).
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { WalletService } from '@services/wallet.service';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { MerchantPermission } from '@interfaces/merchant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 700001;
const token = (merchantId: string, eventId: string) =>
  jwt.sign({ scope: 'merchant', merchantId, eventId, name: 'Bar', permissions: [MerchantPermission.CHARGE] }, JWT_SECRET);

async function setup({ beerStock = 100 } = {}) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const t = await Ticket.create({ eventId, vendorId, ticketType: 'GA', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  const bandUid = '04a1b2c3d4e5';
  await WalletService.bindBand(String(w._id), bandUid, 'op1');
  await WalletService.topUpCash({ walletId: String(w._id), eventId: String(eventId), amount: 100000, recordedBy: 'op1', clientTxnId: 'seed' });
  const merchant = await Merchant.create({ name: 'Bar', eventId, commissionPercent: 0, loginCode: String(seq++), pin: '111111' });
  const beer = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 });
  if (beerStock) await StockService.applyMovement({ eventId, merchantId: merchant._id, productId: beer._id, delta: beerStock, reason: StockMovementReason.RECEIVE, byType: 'Merchant', by: String(merchant._id) });
  return { eventId: String(eventId), bandUid, merchantId: String(merchant._id), beerId: String(beer._id) };
}

it('itemised charge returns 200 with the priced breakdown and new balance', async () => {
  const { eventId, bandUid, merchantId, beerId } = await setup();
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid, clientTxnId: 'c1', staffName: 'Sipho', items: [{ productId: beerId, qty: 2 }] });
  expect(res.status).toBe(200);
  expect(res.body.data.amount).toBe(5000);
  expect(res.body.data.newBalance).toBe(95000);
  expect(res.body.data.items).toHaveLength(1);
});

it('an out-of-stock line declines with 409 out_of_stock, wallet untouched', async () => {
  const { eventId, bandUid, merchantId, beerId } = await setup({ beerStock: 1 });
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid, clientTxnId: 'c2', items: [{ productId: beerId, qty: 5 }] });
  expect(res.status).toBe(409);
  expect(res.body.error).toMatchObject({ reason: 'insufficient_stock', productId: beerId, available: 1 });
});

it('rejects sending both amount and items with 400', async () => {
  const { eventId, bandUid, merchantId, beerId } = await setup();
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid, clientTxnId: 'c3', amount: 300, items: [{ productId: beerId, qty: 1 }] });
  expect(res.status).toBe(400);
});

it('still accepts an amount-only charge (200, un-itemised)', async () => {
  const { eventId, bandUid, merchantId } = await setup();
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid, clientTxnId: 'c4', amount: 300 });
  expect(res.status).toBe(200);
  expect(res.body.data.items).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/routes/__tests__/merchantChargeItems.route.test.ts`
Expected: FAIL (items ignored / 409 not mapped).

- [ ] **Step 3: Update the controller**

In `src/controllers/merchant.controller.ts`:
- Import the stock decline: `import { StockDeclinedError } from '@services/stock.service';`
- In `charge`, pass the new fields through and drop the `amount`-required assumption:
  ```typescript
  const result = await MerchantService.charge({
    merchantId, eventId, walletId: String(wallet._id), bandUid,
    clientTxnId: value.clientTxnId,
    ...(value.amount != null ? { amount: value.amount } : {}),
    ...(value.items ? { items: value.items } : {}),
    ...(value.staffName ? { staffName: value.staffName } : {}),
  });

  return ApiResponseUtil.success(res, {
    newBalance: result.wallet.balance,
    amount: result.charge.amount,
    fee: result.charge.fee,
    merchantNet: result.charge.netAmount,
    ...(result.charge.items ? { items: result.charge.items } : {}),
  });
  ```
- In the `catch`, add the stock decline BEFORE the wallet decline (order doesn't matter — distinct classes), and keep the rest:
  ```typescript
  if (e instanceof StockDeclinedError) {
    return ApiResponseUtil.error(res, `Out of stock`, 409, {
      reason: e.reason, productId: e.productId, available: e.available,
    });
  }
  if (e instanceof WalletDeclinedError) { /* 402 as today */ }
  const msg = e?.message || 'Charge failed';
  const status = /not found|cashless|amount|not active|exactly one|products? not found|positive integer/i.test(msg) ? 400 : 500;
  return ApiResponseUtil.error(res, msg, status);
  ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/routes/__tests__/merchantChargeItems.route.test.ts src/routes/__tests__/merchantCharge.route.test.ts`
Then: `npx tsc --noEmit`
Expected: all PASS / clean (the pre-existing merchantCharge route tests stay green).

- [ ] **Step 5: Full-slice check + commit**

Run (reduced workers to avoid replica-set contention flakes): `npx jest --maxWorkers=4`
Expected: green.

```bash
git add src/controllers/merchant.controller.ts src/routes/__tests__/merchantChargeItems.route.test.ts
git commit -m "feat(cashless-stock): charge endpoint accepts items, maps out-of-stock to 409"
```

---

## Self-Review

**Spec coverage** (design §12 slice 2: "item sales in the charge — extend MerchantService.charge with line items + per-product stock CAS + MerchantCharge.items/staffName"): model `items`/`staffName` → Task 1; validator xor → Task 2; server pricing + stock CAS + propagation → Task 3; controller decline mapping + response → Task 4. All covered. Reporting (un-itemised split) is Slice 4; POS UI is Slice 5 — out of scope, per design.

**Placeholder scan:** no TBD/TODO. `MAX_LINES`/`MAX_QTY_PER_LINE` are concrete (50/1000). Route-test harness mirrors the verified `merchantCharge.route.test.ts` (`app`, `token()`, `seedPublishedEvent`, `connectLedgerTestDb`) — the implementer aligns imports with that file if a helper name differs; assertions are the contract.

**Type consistency:** `StockDeclinedError` shape (`reason:'insufficient_stock'`, `productId`, `available`) matches Slice 1's class (Task 4 maps it to 409). `charge` params (`amount?` XOR `items?` + `staffName?`) are consistent across Tasks 2–4. `MerchantCharge.items` snapshot shape matches Task 1's model. `reason: StockMovementReason.SALE` uses Slice 1's enum. Money legs unchanged from the current implementation.

**Risk note for the executing agent:** the transaction now spans wallet + N ProductStock docs; concurrent sales of the same hot product produce `WriteConflict` (transient) errors that `session.withTransaction` retries — the concurrency test (Task 3) exercises exactly this. Run service/route suites with the replica-set helper (`connectLedgerTestDb`), and the full suite with `--maxWorkers=4` (the default parallelism flakes under 294-suite replica-set load).

---

## Downstream (own plans)

Slice 3 (transfers + counts + low-stock alerts), Slice 4 (reporting — incl. the itemised-vs-un-itemised revenue split this slice makes possible), Slice 5 (POS basket + scan + staff-name capture that feeds `staffName`), Slice 6 (dashboard), Slice 7 (seed). Also carry forward the Slice-1 deferred: receive idempotency key; a Slice-2 note — the sale path relies on `withTransaction` retry for hot-product contention.
