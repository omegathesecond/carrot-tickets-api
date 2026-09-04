# Stock controller grant — API slice implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a stall operator carrying a new `manage_stock` grant receive, write off and transfer their own stall's stock from the POS, and make the organizer's movements log name the person who did it.

**Architecture:** A stock controller is a `MerchantOperator` carrying `OperatorGrant.MANAGE_STOCK`, exactly as the register desk is a gate operator carrying `ISSUE_TAGS`. The grant translates into a new `MerchantPermission.MANAGE_STOCK`, which guards three new write routes on the existing `/api/merchant` router. Every write takes `merchantId` and `eventId` from the JWT and goes through the existing `StockService.applyMovement` / `StockTransferService.transfer`, so the ledger, the CAS guard, the alerts and the reporting all keep working untouched.

**Tech Stack:** Node + TypeScript, Express, Mongoose, Joi validators, Jest + supertest, `mongodb-memory-server` as a 1-node replica set (transactions work in tests).

**Spec:** `docs/superpowers/specs/2026-09-05-merchant-stock-controller-grant-design.md`

## Global Constraints

- **Scope comes from the token, never the body.** Every handler reads `merchantId` / `eventId` off `(req as any).merchant as MerchantToken`. The POS schemas declare no `merchantId` field and this codebase sets no `allowUnknown`, so a body aimed at another stall is **refused with a 400** rather than silently dropped — the caller learns their payload meant nothing.
- **`merchant:charge` stays the floor.** The derived permission set is always `[CHARGE, ...granted]`, so no existing operator loses a capability.
- **`POST /merchant/stock/count` is not touched.** It stays open to any operator with `merchant:charge`.
- **No silent fallbacks.** Every failure returns a real status with a message. Insufficient stock is **409** with `{ reason, productId, available }` — the envelope `MerchantController.charge` already returns for `StockDeclinedError`. Bad input is 400. Missing permission is 403.
- **Attribution is `byType: 'Merchant', by: merchantOperatorId`** on every movement, matching `MerchantController.recordCount`.
- Run tests with `npx jest <path>` from the repo root. Full suite: `npm test`.
- Commit after every task. Never run `git clean -xfd`, `git stash push -u`, or `git rm -r node_modules` in this worktree — `node_modules` is a symlink into a shared install used by ~40 worktrees.

## Deviations from the spec (deliberate, for DRY)

1. **Insufficient stock is 409, not 400.** The spec said 400; the codebase already answers `StockDeclinedError` with 409 + `{reason, productId, available}` in the charge path. Matching it beats inventing a second convention.
2. **Pack→unit conversion happens server-side.** The spec had the POS send base units. But `StockAdminController.receiveStock` already converts `{quantity, unit:'pack'}` using `product.unitsPerPack`, including the "product has no pack size" refusal. Task 4 extracts that rule into `toBaseUnits()` and both controllers use it, so the two receive paths can never disagree.

---

### Task 1: The grant and its merchant translation

**Files:**
- Modify: `src/interfaces/operatorGrant.interface.ts`
- Modify: `src/interfaces/merchant.interface.ts:22-24`
- Test: `src/interfaces/__tests__/operatorGrant.merchant.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `OperatorGrant.MANAGE_STOCK` (`'manage_stock'`); `MerchantPermission.MANAGE_STOCK` (`'merchant:manage_stock'`); `grantedMerchantPermissions(grants?: string[] | null): MerchantPermission[]`.

- [ ] **Step 1: Write the failing test**

Create `src/interfaces/__tests__/operatorGrant.merchant.test.ts`:

```ts
import { MerchantPermission } from '@interfaces/merchant.interface';
import {
  OperatorGrant,
  grantedMerchantPermissions,
  grantedTicketsPermissions,
  grantedCashierPermissions,
  sanitizeGrants,
} from '@interfaces/operatorGrant.interface';

describe('manage_stock grant', () => {
  it('translates into the merchant namespace', () => {
    expect(grantedMerchantPermissions([OperatorGrant.MANAGE_STOCK]))
      .toEqual([MerchantPermission.MANAGE_STOCK]);
  });

  it('grants nothing in the tickets or cashier namespaces — stock is stall-scoped', () => {
    expect(grantedTicketsPermissions([OperatorGrant.MANAGE_STOCK])).toEqual([]);
    expect(grantedCashierPermissions([OperatorGrant.MANAGE_STOCK])).toEqual([]);
  });

  it('gives a stall operator nothing for issue_tags', () => {
    expect(grantedMerchantPermissions([OperatorGrant.ISSUE_TAGS])).toEqual([]);
  });

  it('ignores unknown and duplicate values', () => {
    expect(grantedMerchantPermissions(['not_a_grant', OperatorGrant.MANAGE_STOCK]))
      .toEqual([MerchantPermission.MANAGE_STOCK]);
    expect(grantedMerchantPermissions(null)).toEqual([]);
    expect(sanitizeGrants([OperatorGrant.MANAGE_STOCK, OperatorGrant.MANAGE_STOCK]))
      .toEqual([OperatorGrant.MANAGE_STOCK]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/interfaces/__tests__/operatorGrant.merchant.test.ts`
Expected: FAIL — TypeScript cannot resolve `grantedMerchantPermissions` or `OperatorGrant.MANAGE_STOCK`.

- [ ] **Step 3: Add the permission**

In `src/interfaces/merchant.interface.ts`, extend the enum:

```ts
/** Permission namespace for merchant-scoped tokens, mirroring ResellerPermission. */
export enum MerchantPermission {
  CHARGE = 'merchant:charge',
  /** Receive, write off and transfer THIS stall's stock (OperatorGrant.MANAGE_STOCK). */
  MANAGE_STOCK = 'merchant:manage_stock',
}
```

- [ ] **Step 4: Add the grant and the merchant translator**

In `src/interfaces/operatorGrant.interface.ts`: import `MerchantPermission`, add the enum member, widen both existing maps to `Partial<…>`, and add the merchant map.

```ts
import { MerchantPermission } from '@interfaces/merchant.interface';

export enum OperatorGrant {
  /** …existing ISSUE_TAGS doc comment unchanged… */
  ISSUE_TAGS = 'issue_tags',
  /**
   * The stall's STOCK CONTROLLER. Receives deliveries into this stall, writes
   * off breakage, and moves stock to another stall — all scoped to the stall
   * the operator belongs to. Held by a MerchantOperator; it means nothing on a
   * gate operator or cashier, whose namespaces deliberately have no mapping.
   */
  MANAGE_STOCK = 'manage_stock',
}
```

Both existing maps become partial, because a grant no longer has to mean something in every namespace:

```ts
/** Grants → the tickets namespace (gate operators). */
const TICKETS_BY_GRANT: Partial<Record<OperatorGrant, TicketsPermission>> = {
  [OperatorGrant.ISSUE_TAGS]: TicketsPermission.ISSUE_TAGS,
};

/** Grants → the cashier namespace (cashiers log in through their own middleware). */
const CASHIER_BY_GRANT: Partial<Record<OperatorGrant, CashierPermission>> = {
  [OperatorGrant.ISSUE_TAGS]: CashierPermission.ISSUE_TAGS,
};

/** Grants → the merchant namespace (stall operators on the POS). */
const MERCHANT_BY_GRANT: Partial<Record<OperatorGrant, MerchantPermission>> = {
  [OperatorGrant.MANAGE_STOCK]: MerchantPermission.MANAGE_STOCK,
};
```

Each translator now drops grants with no mapping in its namespace, on top of the unknown-value filter it already ran:

```ts
export function grantedTicketsPermissions(grants?: string[] | null): TicketsPermission[] {
  return (grants ?? [])
    .filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant))
    .map((g) => TICKETS_BY_GRANT[g])
    .filter((p): p is TicketsPermission => p !== undefined);
}

export function grantedCashierPermissions(grants?: string[] | null): CashierPermission[] {
  return (grants ?? [])
    .filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant))
    .map((g) => CASHIER_BY_GRANT[g])
    .filter((p): p is CashierPermission => p !== undefined);
}

export function grantedMerchantPermissions(grants?: string[] | null): MerchantPermission[] {
  return (grants ?? [])
    .filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant))
    .map((g) => MERCHANT_BY_GRANT[g])
    .filter((p): p is MerchantPermission => p !== undefined);
}
```

- [ ] **Step 5: Run the test and the existing grant suites**

Run: `npx jest src/interfaces/__tests__/ src/routes/__tests__/gateGrantRevocation.route.test.ts`
Expected: PASS. The gate suite must stay green — `ISSUE_TAGS` behaviour is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/operatorGrant.interface.ts src/interfaces/merchant.interface.ts src/interfaces/__tests__/operatorGrant.merchant.test.ts
git commit -m "feat(stock): add the stall-scoped manage_stock grant and its merchant translation"
```

---

### Task 2: Login mints the granted permission

**Files:**
- Modify: `src/services/merchantAuth.service.ts` (the `payload` literal, `permissions:` line)
- Test: `src/services/__tests__/merchantAuthGrants.test.ts` (create)

**Interfaces:**
- Consumes: `grantedMerchantPermissions`, `MerchantPermission.MANAGE_STOCK` (Task 1).
- Produces: a merchant JWT whose `permissions` is `[CHARGE, ...granted]`.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/merchantAuthGrants.test.ts`:

```ts
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantAuthService } from '@services/merchantAuth.service';
import { MerchantPermission, MerchantToken } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 910001;

async function seedOperator(grants: OperatorGrant[]) {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({ name: 'Sandwich Stall', eventId });
  const loginCode = String(seq++);
  await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode, pin: '111111', grants,
  });
  return { loginCode };
}

it('mints manage_stock for an operator carrying the grant', async () => {
  const { loginCode } = await seedOperator([OperatorGrant.MANAGE_STOCK]);
  const { accessToken } = await MerchantAuthService.login(loginCode, '111111');
  const payload = jwt.verify(accessToken, JWT_SECRET) as MerchantToken;
  expect(payload.permissions).toEqual([
    MerchantPermission.CHARGE,
    MerchantPermission.MANAGE_STOCK,
  ]);
});

it('leaves an ungranted operator with charge alone', async () => {
  const { loginCode } = await seedOperator([]);
  const { accessToken } = await MerchantAuthService.login(loginCode, '111111');
  const payload = jwt.verify(accessToken, JWT_SECRET) as MerchantToken;
  expect(payload.permissions).toEqual([MerchantPermission.CHARGE]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/merchantAuthGrants.test.ts`
Expected: FAIL — the first test gets `['merchant:charge']`.

- [ ] **Step 3: Mint from the row's grants**

In `src/services/merchantAuth.service.ts`, import the translator:

```ts
import { grantedMerchantPermissions } from '@interfaces/operatorGrant.interface';
```

and replace the hard-coded line in the `payload` literal:

```ts
      // The role is the floor (every person on a till can charge); grants are
      // the per-person extras. Re-derived from the row on every request too —
      // see authenticateMerchant — so this is the POS's copy, not the gate.
      permissions: [
        MerchantPermission.CHARGE,
        ...grantedMerchantPermissions((operator as any).grants),
      ],
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/services/__tests__/merchantAuthGrants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/merchantAuth.service.ts src/services/__tests__/merchantAuthGrants.test.ts
git commit -m "feat(stock): merchant login mints permissions from the operator's grants"
```

---

### Task 3: Permissions are derived per request, not read from the token

**Files:**
- Modify: `src/middleware/merchantAuth.middleware.ts` (the `MerchantOperator.findById` projection and what lands on `req`)
- Test: `src/routes/__tests__/merchantStockGrantRevocation.route.test.ts` (create)

**Interfaces:**
- Consumes: `grantedMerchantPermissions` (Task 1).
- Produces: `(req as any).merchant.permissions` always reflects the **current** row, not the JWT.

- [ ] **Step 1: Write the failing test**

Create `src/routes/__tests__/merchantStockGrantRevocation.route.test.ts`:

```ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 920001;

// A token that CLAIMS manage_stock. Authorization must come from the row.
const forgedToken = (merchantId: string, eventId: string, merchantOperatorId: string) =>
  jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId, operatorName: 'Nomsa Shongwe',
    eventId, name: 'Sandwich Stall',
    permissions: [MerchantPermission.CHARGE, MerchantPermission.MANAGE_STOCK],
  }, JWT_SECRET);

it('refuses a token claiming a grant the row does not carry', async () => {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({ name: 'Sandwich Stall', eventId });
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode: String(seq++), pin: '111111', grants: [],
  });

  const res = await request(app).get('/api/merchant/stalls')
    .set('Authorization', `Bearer ${forgedToken(String(merchant._id), String(eventId), String(operator._id))}`);

  expect(res.status).toBe(403);
});

it('stops honouring a grant as soon as it is revoked', async () => {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({ name: 'Sandwich Stall', eventId });
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode: String(seq++), pin: '111111', grants: [OperatorGrant.MANAGE_STOCK],
  });
  const auth = `Bearer ${forgedToken(String(merchant._id), String(eventId), String(operator._id))}`;

  const before = await request(app).get('/api/merchant/stalls').set('Authorization', auth);
  expect(before.status).toBe(200);

  await MerchantOperator.updateOne({ _id: operator._id }, { $set: { grants: [] } });

  const after = await request(app).get('/api/merchant/stalls').set('Authorization', auth);
  expect(after.status).toBe(403);
});
```

> This test needs `GET /api/merchant/stalls` from Task 7. Implement Task 7 first if you are executing out of order; if you are executing in order, expect these two tests to 404 until Task 7 lands and to be re-run there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/merchantStockGrantRevocation.route.test.ts`
Expected: FAIL — 404 (route not built yet) or 200 (token trusted).

- [ ] **Step 3: Derive the permission set from the row**

In `src/middleware/merchantAuth.middleware.ts`, widen the projection and the local type, then overwrite `permissions` before the request continues:

```ts
import { grantedMerchantPermissions } from '@interfaces/operatorGrant.interface';

  let operator: { isActive?: boolean; grants?: string[] } | null;
  let merchant: { status?: string } | null;
  try {
    [operator, merchant] = await Promise.all([
      MerchantOperator.findById(decoded.merchantOperatorId)
        .select('isActive grants')
        .lean<{ isActive?: boolean; grants?: string[] } | null>(),
      Merchant.findById(decoded.merchantId).select('status').lean<{ status?: string } | null>(),
    ]);
  } catch (e) {
    next(e);
    return;
  }
```

and, immediately before `next()`:

```ts
  // The token's own `permissions` is the POS's copy for rendering; it is NEVER
  // what authorizes. Tokens live 7 days, so a grant removed this morning would
  // otherwise keep working until next week. The row is already in hand from
  // the liveness read above, so deriving here costs no extra query.
  (req as any).merchant = {
    ...decoded,
    permissions: [
      MerchantPermission.CHARGE,
      ...grantedMerchantPermissions(operator.grants),
    ],
  };
  next();
```

- [ ] **Step 4: Run the revocation test and every existing merchant suite**

Run: `npx jest src/routes/__tests__/merchantStockGrantRevocation.route.test.ts src/routes/__tests__/merchantCharge.route.test.ts src/routes/__tests__/merchantChargeItems.route.test.ts src/routes/__tests__/merchantTransactions.route.test.ts src/routes/__tests__/stockCount.route.test.ts src/routes/__tests__/lowStockAlert.route.test.ts`
Expected: PASS. Existing suites mint tokens carrying `[CHARGE]` and their operator rows have no grants, so the derived set matches what they had.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/merchantAuth.middleware.ts src/routes/__tests__/merchantStockGrantRevocation.route.test.ts
git commit -m "fix(merchant): derive token permissions from the operator row on every request"
```

---

### Task 4: `POST /merchant/stock/receive`

**Files:**
- Create: `src/utils/stockUnits.util.ts`
- Modify: `src/controllers/stockAdmin.controller.ts:97-102` (use the extracted helper)
- Modify: `src/validators/stock.validator.ts` (append `posStockAdjustSchema`)
- Modify: `src/controllers/merchant.controller.ts` (imports + new handler)
- Modify: `src/routes/merchant.route.ts` (mount the route)
- Test: `src/routes/__tests__/merchantStockWrite.route.test.ts` (create — Tasks 4-7 all add to this file)

**Interfaces:**
- Consumes: `MerchantPermission.MANAGE_STOCK` (Task 1); per-request permissions (Task 3).
- Produces: `toBaseUnits(product: { unitsPerPack?: number | null }, quantity: number, unit: 'unit' | 'pack'): number | null` — `null` means "asked for packs on a product with no pack size". `posStockAdjustSchema`. Response `{ onHand, movementId }`.

- [ ] **Step 1: Write the failing test**

Create `src/routes/__tests__/merchantStockWrite.route.test.ts`:

```ts
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
import { StockMovement } from '@models/stockMovement.model';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 930001;

export const token = (merchantId: string, eventId: string, merchantOperatorId: string) =>
  jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId, operatorName: 'Nomsa Shongwe',
    eventId, name: 'Sandwich Stall', permissions: [MerchantPermission.CHARGE],
  }, JWT_SECRET);

/** A stall, a person on it, and a 24-per-case product. `grants` decides the job. */
async function seedStall(opts: { grants?: OperatorGrant[]; onHand?: number } = {}) {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({ name: 'Sandwich Stall', eventId });
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode: String(seq++), pin: '111111',
    grants: opts.grants ?? [OperatorGrant.MANAGE_STOCK],
  });
  const product = await Product.create({
    eventId, name: 'Castle Lite 330ml', category: ProductCategory.BEER,
    price: 2500, unitLabel: 'bottle', unitsPerPack: 24, packLabel: 'case',
    barcode: '6001240100015',
  });
  if (opts.onHand != null) {
    await ProductStock.create({ eventId, merchantId: merchant._id, productId: product._id, onHand: opts.onHand });
  }
  return {
    eventId: String(eventId),
    merchantId: String(merchant._id),
    merchantOperatorId: String(operator._id),
    productId: String(product._id),
    auth: `Bearer ${token(String(merchant._id), String(eventId), String(operator._id))}`,
  };
}

describe('POST /api/merchant/stock/receive', () => {
  it('adds a delivery in cases and journals it against the operator', async () => {
    const s = await seedStall({ onHand: 10 });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, quantity: 5, unit: 'pack', note: 'Friday delivery' });

    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(130); // 10 + 5*24

    const move = await StockMovement.findOne({ merchantId: s.merchantId, reason: StockMovementReason.RECEIVE }).lean();
    expect(move).toMatchObject({ delta: 120, balanceAfter: 130, byType: 'Merchant', by: s.merchantOperatorId });
  });

  it('defaults to base units when no unit is given', async () => {
    const s = await seedStall({ onHand: 0 });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth).send({ productId: s.productId, quantity: 7 });
    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(7);
  });

  it('refuses a stall operator without the grant', async () => {
    const s = await seedStall({ grants: [], onHand: 0 });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth).send({ productId: s.productId, quantity: 1 });
    expect(res.status).toBe(403);
  });

  it('refuses a product from another event', async () => {
    const s = await seedStall({ onHand: 0 });
    const other = await seedPublishedEvent({});
    const foreign = await Product.create({
      eventId: other.eventId, name: 'Foreign Cola', category: ProductCategory.SOFT_DRINK,
      price: 1800, unitLabel: 'can',
    });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth).send({ productId: String(foreign._id), quantity: 1 });
    expect(res.status).toBe(400);
  });

  it('refuses packs on a product with no pack size', async () => {
    const s = await seedStall({ onHand: 0 });
    const ice = await Product.create({
      eventId: s.eventId, name: 'Ice 2kg', category: ProductCategory.OTHER,
      price: 2000, unitLabel: 'bag',
    });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth).send({ productId: String(ice._id), quantity: 2, unit: 'pack' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/pack size/i);
  });

  it('refuses a body that names another stall — scope is the token, not the payload', async () => {
    const s = await seedStall({ onHand: 0 });
    const otherStall = await Merchant.create({ name: 'Drinks Stall', eventId: s.eventId });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, quantity: 3, merchantId: String(otherStall._id) });

    // posStockAdjustSchema declares no merchantId and Joi rejects unknown keys,
    // so this fails loudly instead of quietly writing to the caller's own stall.
    expect(res.status).toBe(400);
    const theirs = await ProductStock.findOne({ merchantId: otherStall._id, productId: s.productId }).lean();
    expect(theirs).toBeNull();
  });
});
```

Check `ProductCategory.OTHER` exists in `src/interfaces/stock.interface.ts`; if the enum has no `OTHER`, use any member that is not `BEER`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/merchantStockWrite.route.test.ts`
Expected: FAIL — every request 404s, the route does not exist.

- [ ] **Step 3: Extract the pack rule**

Create `src/utils/stockUnits.util.ts`:

```ts
/**
 * Case → base-unit conversion, shared by the organizer's receive endpoint and
 * the POS stock writes so the two can never disagree about what "5 cases"
 * means. Returns null when packs were asked for on a product that has no pack
 * size — the caller turns that into a 400 rather than silently receiving 5
 * bottles instead of 5 cases.
 */
export function toBaseUnits(
  product: { unitsPerPack?: number | null },
  quantity: number,
  unit: 'unit' | 'pack',
): number | null {
  const perPack = product.unitsPerPack && product.unitsPerPack > 0 ? product.unitsPerPack : 1;
  if (unit === 'pack') return perPack === 1 ? null : quantity * perPack;
  return quantity;
}
```

Then in `src/controllers/stockAdmin.controller.ts`, replace the inline block at lines 97-102 with the helper — same behaviour, one definition:

```ts
import { toBaseUnits } from '@utils/stockUnits.util';

      // Case->unit conversion: 'pack' quantities multiply by unitsPerPack.
      const baseUnits = toBaseUnits(product, value.quantity, value.unit);
      if (baseUnits == null) {
        ApiResponseUtil.badRequest(res, 'product has no pack size; receive in units'); return;
      }
```

- [ ] **Step 4: Add the validator**

Append to `src/validators/stock.validator.ts`:

```ts
/**
 * POS stock write (receive / waste). merchantId is deliberately absent — the
 * stall comes from the token, so a body cannot aim a write at another stall.
 */
export const posStockAdjustSchema = Joi.object({
  productId: objectId.required(),
  quantity: Joi.number().integer().min(1).max(MAX_QTY).required(),
  unit: Joi.string().valid('unit', 'pack').default('unit'),
  note: Joi.string().trim().optional(),
});
```

- [ ] **Step 5: Add the handler**

In `src/controllers/merchant.controller.ts`, extend the imports:

```ts
import mongoose from 'mongoose';
import { Merchant } from '@models/merchant.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { StockTransferService } from '@services/stockTransfer.service';
import { posCountSchema, posStockAdjustSchema, posTransferSchema } from '@validators/stock.validator';
import { toBaseUnits } from '@utils/stockUnits.util';
```

(`posTransferSchema` and `StockTransferService` are used in Task 6; import them now to keep one import edit.)

Add to `MerchantController`:

```ts
  /**
   * Resolve the product named in the body against the token's event and turn
   * the quantity into base units. Returns null after answering the response —
   * every POS stock write shares these two refusals.
   */
  private static async resolveProductAndUnits(
    req: Request, res: Response, value: { productId: string; quantity: number; unit: 'unit' | 'pack' },
  ): Promise<number | null> {
    const { eventId } = (req as any).merchant as MerchantToken;
    const product = await Product.findById(value.productId).lean();
    if (!product || String(product.eventId) !== String(eventId)) {
      ApiResponseUtil.badRequest(res, 'product does not belong to this event');
      return null;
    }
    const units = toBaseUnits(product, value.quantity, value.unit);
    if (units == null) {
      ApiResponseUtil.badRequest(res, 'product has no pack size; receive in units');
      return null;
    }
    return units;
  }

  /** POST /api/merchant/stock/receive — a delivery INTO this stall. */
  static async receiveStock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId, merchantOperatorId } = (req as any).merchant as MerchantToken;
      const { error, value } = posStockAdjustSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const units = await MerchantController.resolveProductAndUnits(req, res, value);
      if (units == null) return;

      const { onHand, movement } = await StockService.applyMovement({
        eventId, merchantId, productId: value.productId,
        delta: units, reason: StockMovementReason.RECEIVE,
        refType: 'stock_receive', refId: String(new mongoose.Types.ObjectId()),
        byType: 'Merchant', by: merchantOperatorId, note: value.note,
      });
      // Fire-and-forget: a receive back above threshold re-arms the alert. A
      // rearm failure must never turn a successful receive into a 500.
      StockAlertService.rearm(String(merchantId), String(value.productId)).catch(() => {});
      return ApiResponseUtil.success(res, { onHand, movementId: String(movement._id) });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Receive failed', 500);
    }
  }
```

- [ ] **Step 6: Mount the route**

In `src/routes/merchant.route.ts`, after the existing stock routes:

```ts
router.post(
  '/stock/receive',
  requireMerchantPermission(MerchantPermission.MANAGE_STOCK),
  MerchantController.receiveStock,
);
```

- [ ] **Step 7: Run the tests**

Run: `npx jest src/routes/__tests__/merchantStockWrite.route.test.ts src/routes/__tests__/stockAdmin.route.test.ts`
Expected: PASS — including `stockAdmin`, which now goes through the extracted helper.

- [ ] **Step 8: Commit**

```bash
git add src/utils/stockUnits.util.ts src/controllers/stockAdmin.controller.ts src/validators/stock.validator.ts src/controllers/merchant.controller.ts src/routes/merchant.route.ts src/routes/__tests__/merchantStockWrite.route.test.ts
git commit -m "feat(stock): stall operators can receive deliveries from the POS"
```

---

### Task 5: `POST /merchant/stock/waste`

**Files:**
- Modify: `src/controllers/merchant.controller.ts` (new handler)
- Modify: `src/routes/merchant.route.ts`
- Test: `src/routes/__tests__/merchantStockWrite.route.test.ts` (append)

**Interfaces:**
- Consumes: `posStockAdjustSchema`, `resolveProductAndUnits`, `seedStall` (Task 4).
- Produces: the first writer of `StockMovementReason.SPOILAGE` in the codebase. Response `{ onHand, movementId }`.

- [ ] **Step 1: Write the failing test**

Append to `src/routes/__tests__/merchantStockWrite.route.test.ts`:

```ts
describe('POST /api/merchant/stock/waste', () => {
  it('writes off breakage and lands as spoilage in the journal', async () => {
    const s = await seedStall({ onHand: 40 });
    const res = await request(app).post('/api/merchant/stock/waste')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, quantity: 6, note: 'crate dropped' });

    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(34);

    const move = await StockMovement.findOne({ merchantId: s.merchantId, reason: StockMovementReason.SPOILAGE }).lean();
    expect(move).toMatchObject({ delta: -6, balanceAfter: 34, byType: 'Merchant', by: s.merchantOperatorId, note: 'crate dropped' });
  });

  it('refuses to write off more than is on hand, leaving the balance untouched', async () => {
    const s = await seedStall({ onHand: 3 });
    const res = await request(app).post('/api/merchant/stock/waste')
      .set('Authorization', s.auth).send({ productId: s.productId, quantity: 4 });

    expect(res.status).toBe(409);
    expect(res.body.data).toMatchObject({ reason: 'insufficient_stock', available: 3 });

    const row = await ProductStock.findOne({ merchantId: s.merchantId, productId: s.productId }).lean();
    expect(row?.onHand).toBe(3);
  });

  it('refuses a stall operator without the grant', async () => {
    const s = await seedStall({ grants: [], onHand: 10 });
    const res = await request(app).post('/api/merchant/stock/waste')
      .set('Authorization', s.auth).send({ productId: s.productId, quantity: 1 });
    expect(res.status).toBe(403);
  });
});
```

Confirm the 409 body path: `ApiResponseUtil.error(res, msg, 409, extra)` puts `extra` under `data` in the charge path — if the envelope differs, assert on whatever `MerchantController.charge`'s own tests assert.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/merchantStockWrite.route.test.ts -t waste`
Expected: FAIL — 404.

- [ ] **Step 3: Add the handler**

In `src/controllers/merchant.controller.ts`:

```ts
  /** POST /api/merchant/stock/waste — breakage and spoilage at this stall. */
  static async wasteStock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId, merchantOperatorId } = (req as any).merchant as MerchantToken;
      const { error, value } = posStockAdjustSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const units = await MerchantController.resolveProductAndUnits(req, res, value);
      if (units == null) return;

      const { onHand, movement } = await StockService.applyMovement({
        eventId, merchantId, productId: value.productId,
        delta: -units, reason: StockMovementReason.SPOILAGE,
        refType: 'stock_waste', refId: String(new mongoose.Types.ObjectId()),
        byType: 'Merchant', by: merchantOperatorId, note: value.note,
      });
      return ApiResponseUtil.success(res, { onHand, movementId: String(movement._id) });
    } catch (e: any) {
      // The CAS guard in applyMovement declined the decrement: the stall does
      // not hold that much. Same envelope the charge path returns, so a POS
      // client has one shape to handle.
      if (e instanceof StockDeclinedError) {
        return ApiResponseUtil.error(res, 'Not enough on hand', 409, {
          reason: e.reason, productId: e.productId, available: e.available,
        });
      }
      return ApiResponseUtil.error(res, e?.message || 'Write-off failed', 500);
    }
  }
```

- [ ] **Step 4: Mount the route**

```ts
router.post(
  '/stock/waste',
  requireMerchantPermission(MerchantPermission.MANAGE_STOCK),
  MerchantController.wasteStock,
);
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/routes/__tests__/merchantStockWrite.route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/merchant.controller.ts src/routes/merchant.route.ts src/routes/__tests__/merchantStockWrite.route.test.ts
git commit -m "feat(stock): stall operators can write off waste from the POS"
```

---

### Task 6: `POST /merchant/stock/transfer`

**Files:**
- Modify: `src/validators/stock.validator.ts` (append `posTransferSchema`)
- Modify: `src/controllers/merchant.controller.ts` (new handler)
- Modify: `src/routes/merchant.route.ts`
- Test: `src/routes/__tests__/merchantStockWrite.route.test.ts` (append)

**Interfaces:**
- Consumes: `seedStall` (Task 4), `StockTransferService.transfer` (existing).
- Produces: `posTransferSchema`. Response `{ fromOnHand, toOnHand, transferId }`.

- [ ] **Step 1: Write the failing test**

Append to `src/routes/__tests__/merchantStockWrite.route.test.ts`:

```ts
describe('POST /api/merchant/stock/transfer', () => {
  it('moves stock to another stall and journals both legs', async () => {
    const s = await seedStall({ onHand: 50 });
    const drinks = await Merchant.create({ name: 'Drinks Stall', eventId: s.eventId });

    const res = await request(app).post('/api/merchant/stock/transfer')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, toMerchantId: String(drinks._id), quantity: 2, unit: 'pack' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fromOnHand: 2, toOnHand: 48 }); // 50-48, 0+48

    const out = await StockMovement.findOne({ merchantId: s.merchantId, reason: StockMovementReason.TRANSFER_OUT }).lean();
    const inn = await StockMovement.findOne({ merchantId: drinks._id, reason: StockMovementReason.TRANSFER_IN }).lean();
    expect(out).toMatchObject({ delta: -48, byType: 'Merchant', by: s.merchantOperatorId });
    expect(inn).toMatchObject({ delta: 48, byType: 'Merchant', by: s.merchantOperatorId });
    expect(String(out!.refId)).toBe(String(inn!.refId));
  });

  it('refuses a destination stall at another event', async () => {
    const s = await seedStall({ onHand: 50 });
    const other = await seedPublishedEvent({});
    const foreign = await Merchant.create({ name: 'Other Event Stall', eventId: other.eventId });

    const res = await request(app).post('/api/merchant/stock/transfer')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, toMerchantId: String(foreign._id), quantity: 1 });
    expect(res.status).toBe(400);
  });

  it('refuses a suspended destination stall', async () => {
    const s = await seedStall({ onHand: 50 });
    const closed = await Merchant.create({ name: 'Closed Stall', eventId: s.eventId, status: 'suspended' });

    const res = await request(app).post('/api/merchant/stock/transfer')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, toMerchantId: String(closed._id), quantity: 1 });
    expect(res.status).toBe(400);
  });

  it('refuses transferring more than is on hand', async () => {
    const s = await seedStall({ onHand: 5 });
    const drinks = await Merchant.create({ name: 'Drinks Stall', eventId: s.eventId });

    const res = await request(app).post('/api/merchant/stock/transfer')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, toMerchantId: String(drinks._id), quantity: 6 });

    expect(res.status).toBe(409);
    const row = await ProductStock.findOne({ merchantId: s.merchantId, productId: s.productId }).lean();
    expect(row?.onHand).toBe(5);
  });

  it('refuses a stall operator without the grant', async () => {
    const s = await seedStall({ grants: [], onHand: 50 });
    const drinks = await Merchant.create({ name: 'Drinks Stall', eventId: s.eventId });
    const res = await request(app).post('/api/merchant/stock/transfer')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, toMerchantId: String(drinks._id), quantity: 1 });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/merchantStockWrite.route.test.ts -t transfer`
Expected: FAIL — 404.

- [ ] **Step 3: Add the validator**

Append to `src/validators/stock.validator.ts`:

```ts
/** POS transfer. `fromMerchantId` is absent by design — it is always the token's stall. */
export const posTransferSchema = Joi.object({
  productId: objectId.required(),
  toMerchantId: objectId.required(),
  quantity: Joi.number().integer().min(1).max(MAX_QTY).required(),
  unit: Joi.string().valid('unit', 'pack').default('unit'),
  note: Joi.string().trim().optional(),
});
```

- [ ] **Step 4: Add the handler**

In `src/controllers/merchant.controller.ts`:

```ts
  /** POST /api/merchant/stock/transfer — move stock from THIS stall to another. */
  static async transferStock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId, merchantOperatorId } = (req as any).merchant as MerchantToken;
      const { error, value } = posTransferSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      if (String(value.toMerchantId) === String(merchantId)) {
        return ApiResponseUtil.badRequest(res, 'cannot transfer to the same stall');
      }

      // The destination must be a live stall at THIS event. Without this check
      // a valid id from another event would move stock across event
      // boundaries, which no report would ever reconcile.
      const destination = await Merchant.findById(value.toMerchantId).lean();
      if (!destination || String(destination.eventId) !== String(eventId) || destination.status !== 'active') {
        return ApiResponseUtil.badRequest(res, 'destination stall is not an active stall at this event');
      }

      const units = await MerchantController.resolveProductAndUnits(req, res, value);
      if (units == null) return;

      const { transfer, fromOnHand, toOnHand } = await StockTransferService.transfer({
        eventId, productId: value.productId,
        fromMerchantId: String(merchantId), toMerchantId: String(value.toMerchantId),
        qty: units, byType: 'Merchant', by: merchantOperatorId, note: value.note,
      });
      return ApiResponseUtil.success(res, {
        transferId: String(transfer._id), fromOnHand, toOnHand,
      });
    } catch (e: any) {
      if (e instanceof StockDeclinedError) {
        return ApiResponseUtil.error(res, 'Not enough on hand', 409, {
          reason: e.reason, productId: e.productId, available: e.available,
        });
      }
      return ApiResponseUtil.error(res, e?.message || 'Transfer failed', 500);
    }
  }
```

- [ ] **Step 5: Mount the route**

```ts
router.post(
  '/stock/transfer',
  requireMerchantPermission(MerchantPermission.MANAGE_STOCK),
  MerchantController.transferStock,
);
```

- [ ] **Step 6: Run the tests**

Run: `npx jest src/routes/__tests__/merchantStockWrite.route.test.ts src/routes/__tests__/stockTransfer.route.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/validators/stock.validator.ts src/controllers/merchant.controller.ts src/routes/merchant.route.ts src/routes/__tests__/merchantStockWrite.route.test.ts
git commit -m "feat(stock): stall operators can transfer stock to another stall from the POS"
```

---

### Task 7: `GET /merchant/stalls`

**Files:**
- Modify: `src/controllers/merchant.controller.ts` (new handler)
- Modify: `src/routes/merchant.route.ts`
- Test: `src/routes/__tests__/merchantStockWrite.route.test.ts` (append)

**Interfaces:**
- Consumes: `seedStall` (Task 4).
- Produces: `{ stalls: Array<{ merchantId: string; name: string }> }` — the transfer screen's destination list. Unblocks Task 3's tests.

- [ ] **Step 1: Write the failing test**

Append to `src/routes/__tests__/merchantStockWrite.route.test.ts`:

```ts
describe('GET /api/merchant/stalls', () => {
  it('lists the other active stalls at this event, by name', async () => {
    const s = await seedStall({ onHand: 0 });
    await Merchant.create({ name: 'Drinks Stall', eventId: s.eventId });
    await Merchant.create({ name: 'Closed Stall', eventId: s.eventId, status: 'suspended' });
    const other = await seedPublishedEvent({});
    await Merchant.create({ name: 'Other Event Stall', eventId: other.eventId });

    const res = await request(app).get('/api/merchant/stalls').set('Authorization', s.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.stalls.map((x: any) => x.name)).toEqual(['Drinks Stall']);
  });

  it('refuses a stall operator without the grant', async () => {
    const s = await seedStall({ grants: [], onHand: 0 });
    const res = await request(app).get('/api/merchant/stalls').set('Authorization', s.auth);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/merchantStockWrite.route.test.ts -t stalls`
Expected: FAIL — 404.

- [ ] **Step 3: Add the handler**

```ts
  /**
   * GET /api/merchant/stalls — transfer destinations: the OTHER live stalls at
   * this event. The caller's own stall is excluded because a transfer to
   * yourself is rejected downstream; offering it would be a dead option.
   */
  static async stalls(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      const rows = await Merchant.find({ eventId, status: 'active' }).select('name').sort({ name: 1 }).lean();
      const stalls = rows
        .filter((m: any) => String(m._id) !== String(merchantId))
        .map((m: any) => ({ merchantId: String(m._id), name: m.name }));
      return ApiResponseUtil.success(res, { stalls });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Could not load stalls', 500);
    }
  }
```

- [ ] **Step 4: Mount the route**

```ts
router.get(
  '/stalls',
  requireMerchantPermission(MerchantPermission.MANAGE_STOCK),
  MerchantController.stalls,
);
```

- [ ] **Step 5: Run the tests, including Task 3's now-unblocked suite**

Run: `npx jest src/routes/__tests__/merchantStockWrite.route.test.ts src/routes/__tests__/merchantStockGrantRevocation.route.test.ts`
Expected: PASS — both revocation tests included.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/merchant.controller.ts src/routes/merchant.route.ts src/routes/__tests__/merchantStockWrite.route.test.ts
git commit -m "feat(stock): list transfer destination stalls for the POS"
```

---

### Task 8: The organizer can grant it

**Files:**
- Modify: `src/controllers/merchantOperatorAdmin.controller.ts` (create + update handlers)
- Test: `src/routes/__tests__/merchantOperatorAdmin.route.test.ts` (append)

**Interfaces:**
- Consumes: `sanitizeGrants` (existing), `OperatorGrant.MANAGE_STOCK` (Task 1).
- Produces: `POST`/`PATCH` on stall operators accept `grants: string[]`, filtered to known values.

- [ ] **Step 1: Write the failing test**

Append to `src/routes/__tests__/merchantOperatorAdmin.route.test.ts`, using that
file's own fixtures (`seedMerchant`, `organizerToken`, `VENDOR_A`) — it already
imports `MerchantOperator`, so only the grant enum is a new import:

```ts
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

it('creates a stall operator carrying the stock grant', async () => {
  const { merchantId } = await seedMerchant();
  const res = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${organizerToken(VENDOR_A)}`)
    .send({ fullName: 'Sipho Mabuza', grants: [OperatorGrant.MANAGE_STOCK] });

  expect(res.status).toBe(201);
  const saved = await MerchantOperator.findById(res.body.data.operator._id).lean();
  expect(saved!.grants).toEqual([OperatorGrant.MANAGE_STOCK]);
});

it('drops unknown grant values instead of storing them', async () => {
  const { merchantId } = await seedMerchant();
  const res = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${organizerToken(VENDOR_A)}`)
    .send({ fullName: 'Sipho Mabuza', grants: ['manage_stock', 'root', 42] });

  expect(res.status).toBe(201);
  const saved = await MerchantOperator.findById(res.body.data.operator._id).lean();
  expect(saved!.grants).toEqual([OperatorGrant.MANAGE_STOCK]);
});

it('defaults to no grants when the field is absent', async () => {
  const { merchantId } = await seedMerchant();
  const res = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${organizerToken(VENDOR_A)}`)
    .send({ fullName: 'Sipho Mabuza' });

  expect(res.status).toBe(201);
  const saved = await MerchantOperator.findById(res.body.data.operator._id).lean();
  expect(saved!.grants).toEqual([]);
});

it('revokes a grant on patch', async () => {
  const { merchantId } = await seedMerchant();
  const auth = `Bearer ${organizerToken(VENDOR_A)}`;
  const created = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', auth)
    .send({ fullName: 'Sipho Mabuza', grants: [OperatorGrant.MANAGE_STOCK] });
  const operatorId = created.body.data.operator._id;

  const res = await request(app).patch(`/api/tickets/merchant-operators/${operatorId}`)
    .set('Authorization', auth).send({ grants: [] });

  expect(res.status).toBe(200);
  const saved = await MerchantOperator.findById(operatorId).lean();
  expect(saved!.grants).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/merchantOperatorAdmin.route.test.ts`
Expected: FAIL — `grants` comes back `[]` because the handler never reads it.

- [ ] **Step 3: Accept grants on create and update**

In `src/controllers/merchantOperatorAdmin.controller.ts`, import the sanitizer:

```ts
import { sanitizeGrants } from '@interfaces/operatorGrant.interface';
```

In `create`, add one field to the `MerchantOperator.create({…})` call:

```ts
        loginCode,
        pin,
        grants: sanitizeGrants(req.body.grants),
```

In `update`, beside the `isActive` block:

```ts
      // Only known grants survive — a typo must not sit on the row waiting to
      // widen a token later. Mirrors GateOperatorAdminController.update.
      if ('grants' in req.body) (operator as any).grants = sanitizeGrants(req.body.grants);
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/routes/__tests__/merchantOperatorAdmin.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/merchantOperatorAdmin.controller.ts src/routes/__tests__/merchantOperatorAdmin.route.test.ts
git commit -m "feat(stock): organizers can grant manage_stock to a stall operator"
```

---

### Task 9: The movements log names the person

**Files:**
- Modify: `src/services/stockReport.service.ts:353-368` (the `movements` mapping)
- Test: `src/routes/__tests__/stockReportMovements.route.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks (but its test seeds a movement written by Task 4's route).
- Produces: each movement gains `byName: string | null` — the operator's full name for `byType: 'Merchant'`, `null` otherwise.

- [ ] **Step 1: Write the failing test**

Append to `src/routes/__tests__/stockReportMovements.route.test.ts`, following
that file's own pattern (`seedPublishedEvent`, `signVendorToken`, the `seq`
counter). Add one import — `MerchantOperator` — the rest is already imported:

```ts
import { MerchantOperator } from '@models/merchantOperator.model';

it('names the stall operator behind a POS movement', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  const bar = await Merchant.create({ name: 'Sandwich Stall', eventId } as any);
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: bar._id, eventId,
    loginCode: String(seq++), pin: '111111',
  });
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);

  // Exactly what the POS receive route writes: attributed to the PERSON.
  await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id),
    delta: 24, reason: StockMovementReason.RECEIVE,
    byType: 'Merchant', by: String(operator._id),
  } as any);

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/movements`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.data.movements[0]).toMatchObject({
    by: String(operator._id),
    byName: 'Nomsa Shongwe',
  });
});

it('leaves byName null for organizer-written movements', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  const bar = await Merchant.create({ name: 'Bar 1', eventId } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  // Organizer-written rows put a vendorId (not an ObjectId person) in `by`.
  await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id),
    delta: 20, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: String(vendorId),
  } as any);

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/movements`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.body.data.movements[0].byName).toBeNull();
});

it('falls back rather than leaking a bare id when the operator is gone', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  const bar = await Merchant.create({ name: 'Sandwich Stall', eventId } as any);
  const operator = await MerchantOperator.create({
    fullName: 'Temp Staff', merchantId: bar._id, eventId,
    loginCode: String(seq++), pin: '111111',
  });
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id),
    delta: 5, reason: StockMovementReason.RECEIVE, byType: 'Merchant', by: String(operator._id),
  } as any);
  await MerchantOperator.deleteOne({ _id: operator._id });

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/movements`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.body.data.movements[0].byName).toBe('Unknown operator');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/stockReportMovements.route.test.ts`
Expected: FAIL — `byName` is undefined.

- [ ] **Step 3: Resolve operator names**

In `src/services/stockReport.service.ts`, import the model and the hex guard:

```ts
import { MerchantOperator } from '@models/merchantOperator.model';
import { HEX24 } from '@utils/controllerHelpers.util';
```

Beside the existing `productIds` / `merchantIds` collection, gather the operator ids — guarded, because `by` is a free string that holds a vendorId or `'platform'` for organizer-written rows and would throw on an ObjectId cast:

```ts
    const operatorIds = [...new Set(
      page
        .filter((d: any) => d.byType === 'Merchant' && HEX24.test(String(d.by)))
        .map((d: any) => String(d.by)),
    )];
```

Add a third parallel read and map:

```ts
    const [prods, merchs, ops] = await Promise.all([
      Product.find({ _id: { $in: productIds.map(oid) } }).select('name').lean(),
      Merchant.find({ _id: { $in: merchantIds.map(oid) } }).select('name').lean(),
      operatorIds.length
        ? MerchantOperator.find({ _id: { $in: operatorIds.map(oid) } }).select('fullName').lean()
        : Promise.resolve([] as any[]),
    ]);
    const operatorName = new Map(ops.map((o: any) => [String(o._id), o.fullName]));
```

And in the row mapping, beside `by`:

```ts
      byType: d.byType, by: d.by,
      // Who actually did it. Organizer-written rows keep byName null — their
      // `by` is a vendorId, not a person, and inventing a name for it would be
      // worse than showing none.
      byName: d.byType === 'Merchant' ? (operatorName.get(String(d.by)) ?? 'Unknown operator') : null,
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/routes/__tests__/stockReportMovements.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/stockReport.service.ts src/routes/__tests__/stockReportMovements.route.test.ts
git commit -m "feat(stock): movements name the stall operator who wrote them"
```

---

### Task 10: Full suite and typecheck

**Files:** none — verification only.

- [ ] **Step 1: Typecheck**

Run: `npm run build`
Expected: clean. The `Partial<Record<…>>` change in Task 1 is the likely source of any error — a namespace map that still declares itself total will fail here.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all green. Pay attention to `merchantCharge`, `merchantChargeItems`, `stockCount`, `lowStockAlert` and `gateGrantRevocation` — they exercise the code paths this plan changed.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A ':!node_modules'
git commit -m "chore(stock): typecheck and lint fixes for the manage_stock grant"
```

---

## What this plan does NOT cover

Slice 2, in its own plan: the POS Stock-tab actions (scan → Receive / Waste / Transfer, cases ⇄ units), the `OperatorGrantsField` + `appliesTo` change in `StallOperatorsPanel`, and rendering `byName ?? by` in the dashboard movements table. The API shipped here is inert until that lands — no existing operator's permission set changes, so it is safe to deploy on its own.
