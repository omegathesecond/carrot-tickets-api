# Venue Trading — Phase 2 (Stalls, Catalogue, Stock, Till Staff) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A switched-on venue manages its own stalls, till staff, catalogue and day-to-day stock (receive, transfer, counts, allocations, reports, reconciliation PDF) from the dashboard's Venue section, and its till operators sign in on the POS to count stock — all on the SAME stock code events use.

**Architecture:** Seven cashless models gain `venueId` beside `eventId` with a schema plugin enforcing EXACTLY ONE owner. A `TradingScope` (`{kind:'event',eventId} | {kind:'venue',venueId}`) is resolved by route middleware (`eventScope` / `venueScope`), and the existing stall, stock and report handlers read it instead of `req.params.eventId`, so each handler is mounted twice: the unchanged event URLs and new `/api/tickets/venue/*` URLs. Services take `ScopeIds` (`{eventId} | {venueId}`), so every existing event caller keeps compiling unchanged. The dashboard's stock panels take a `scope` prop and the Venue page renders them; the POS opens a venue till straight on its Stock page.

**Tech Stack:** API — Express + Mongoose 7 + Joi, Jest + supertest + mongodb-memory-server (replica set for stock transactions). Dashboard — React + Vite + TanStack Query + Vitest (NO jest-dom: native matchers). POS — Flutter (`flutter test` / `flutter analyze` only).

**Spec:** `docs/superpowers/specs/2026-10-01-venue-trading-design.md` — § Architecture, § Phase 2. Read both.

## Repos, branches, worktrees

| Repo | Worktree | Branch | Base |
|---|---|---|---|
| API | `carrot-tickets/api-venue-wt` | `feat/venue-trading` (continue) | head `11f0f25` (= origin/dev) |
| Dashboard | `carrot-tickets/dashboard-venue-wt` | `feat/venue-section` (continue) | head `ecaa44d` (= origin/dev) |
| POS | `carrot-tickets/pos-venue-wt` (create) | `feat/venue-till` | `origin/main` |

Create the POS worktree before Task 9:
```bash
cd ~/Documents/omevision/contracts/carrot-tickets/pos-app && git fetch origin main && git worktree add -b feat/venue-till ../pos-venue-wt origin/main && cd ../pos-venue-wt && flutter pub get
```
Never work in the `api/`, `dashboard/`, `landing/` or `pos-app/` checkouts.

## Decisions this plan takes (beyond the spec text)

- **Table, Waiter and MerchantCharge stay event-only in Phase 2.** The spec lists them among the shared models, but nothing in Phase 2 writes a venue table, waiter or charge; they gain `venueId` in Phase 3 with the selling work. The `Table {eventId,label}` index fix therefore also moves to Phase 3.
- **Till staff are managed per stall** (the stall detail page), exactly as events do — not a separate "Till staff" tab.
- **The bulk stock-take import is an operations procedure over the count endpoint, not a UI** (see memory `carrot-bulk-stocktake-import`). It works for venues as soon as `POST /venue/stock/count` exists; nothing else to build.
- **New product-barcode indexes get NEW names and a reversed key order** (`{barcode, eventId}` / `{barcode, venueId}`), so they can be created beside the legacy `eventId_1_barcode_1` on any MongoDB version without a same-name or same-key-pattern conflict. The migration script then drops the legacy index. Deploy order stops mattering for events.
- **A venue's reconciliation is a date range**, default today in `Africa/Mbabane`. Without an opening count, its opening figure is the stall-product's balance at the start of the range (from `StockMovement.balanceAfter`), and expected closing is the balance at the end — events keep their "pre-doors receives" logic unchanged, because an event starts from zero and a venue does not.
- **Money in the shared stock panels defaults to Rand**, as today, and takes an optional `currency`; the venue passes its own. Events are unaffected.

## Global Constraints

- Every `Merchant`, `MerchantOperator`, `Product`, `ProductStock`, `StockMovement`, `StockCount`, `StockTransfer` document has EXACTLY ONE of `eventId` / `venueId`; both or neither is a validation error with the message `exactly one of eventId or venueId is required`.
- Existing event URLs, permissions, response shapes and behaviour do not change. Every existing stock / stall / operator / report / till test passes with NO edits except the mechanical call-shape edits a task explicitly lists (Task 5 Step 8, Task 7 Step 6) — never an assertion change.
- Venue routes live under `/api/tickets/venue/*` with NO id in the URL; the venue comes from the logged-in vendor (`Venue.vendorId`).
- No venue on the account → **404** `No venue on this account`. Suspended venue → **403** `Venue trading is suspended`.
- A document from another venue, or from an event, addressed through a venue route → **404** (never 403, never a leak). A venue document addressed through an event route → **404**.
- Venue stalls always store `commissionPercent: 0`, whatever the request sends.
- Venue permissions: stalls + till staff writes `tickets:manage_venue`; stall list `tickets:manage_venue` OR `tickets:manage_stock`; catalogue + stock writes `tickets:manage_stock`; reports `tickets:view_revenue`.
- Venue till tokens: tag charge → **403** `Tag payments aren't used at venues`; tables / hand-out → **403** `Venue table service is not available yet`.
- Fail loudly: no fallback data that mimics success; no backward-compatibility shims; DRY — reuse the existing handlers, services and components.
- API tests: targeted files only, `--runInBand`, read the COUNTS. Stock-writing suites use `connectLedgerTestDb` (replica set). Never run the full API suite (unreliable on this Mac; main has 3 known failures).
- Dashboard typecheck: `npx tsc --noEmit -p tsconfig.app.json` (the root tsconfig checks nothing). Dashboard tests use native matchers — `@testing-library/jest-dom` is NOT installed.
- POS: never `flutter run`, never build an APK. Only `flutter analyze` and `flutter test <file>`.
- Do not push, merge or deploy.

## Review Focus

1. **A venue's stock board must never show event sales.** `MerchantCharge` has no `venueId` in Phase 2, so the venue board's charge queries rely on Mongoose passing an unknown field to MongoDB (strictQuery off). If that ever flips, the filter would be stripped and every event's sales would appear. Pinned in Task 5 ("venue board shows no event charges").
2. **Two venues stocking the same barcode.** Must both succeed; the same barcode twice in ONE venue must still be refused. Pinned in Task 2 (migration test) and Task 4 (route).
3. **Cross-tenant addressing.** Venue B's stall/product/operator id used by venue A, and a venue id used on an event route, must 404 and change nothing. Pinned in Tasks 3 and 4.
4. **A day that starts with stock already on the shelf.** Venue reconciliation opening = balance at range start, not "receives before doors". Pinned in Task 5.
5. **A suspended venue's till operator.** Sign-in and every till request refused while suspended. Pinned in Task 6.

---

## Task 1: Trading-scope foundation — util, schema plugin, seven models (API)

**Files:**
- Create: `src/utils/tradingScope.util.ts`
- Create: `src/models/tradingScope.schema.ts`
- Modify: `src/interfaces/merchant.interface.ts` (IMerchant `eventId`), `src/interfaces/merchantOperator.interface.ts` (IMerchantOperator `eventId`)
- Modify: `src/models/merchant.model.ts`, `merchantOperator.model.ts`, `product.model.ts`, `productStock.model.ts`, `stockMovement.model.ts`, `stockCount.model.ts`, `stockTransfer.model.ts`
- Modify: `src/services/merchantAuth.service.ts` (temporary guard, replaced in Task 6)
- Test: `src/utils/__tests__/tradingScope.util.test.ts`, `src/models/__tests__/tradingScope.models.test.ts`

**Interfaces:**
- Produces (`@utils/tradingScope.util`):
  - `type TradingScope = { kind: 'event'; eventId: string } | { kind: 'venue'; venueId: string }`
  - `type ScopeIds = { eventId: Id; venueId?: never } | { venueId: Id; eventId?: never }` where `Id = string | mongoose.Types.ObjectId`
  - `type ScopeMatch = { eventId: ObjectId } | { venueId: ObjectId }`
  - `scopeIds(scope: TradingScope): ScopeIds`
  - `scopeMatch(ids: ScopeIds): ScopeMatch` — query filter AND write fields (same shape)
  - `scopeOfDoc(doc): TradingScope | null`, `requireScopeOf(doc): TradingScope` (throws), `belongsToScope(doc, scope): boolean`
- Produces (`@models/tradingScope.schema`): `applyTradingScope(schema: Schema): void`

- [ ] **Step 1: Write the failing util test**

`src/utils/__tests__/tradingScope.util.test.ts`:

```ts
import mongoose from 'mongoose';
import { scopeIds, scopeMatch, scopeOfDoc, requireScopeOf, belongsToScope } from '@utils/tradingScope.util';

const E = new mongoose.Types.ObjectId().toHexString();
const V = new mongoose.Types.ObjectId().toHexString();

describe('tradingScope util', () => {
  it('an event scope becomes an eventId filter', () => {
    const m = scopeMatch(scopeIds({ kind: 'event', eventId: E }));
    expect(Object.keys(m)).toEqual(['eventId']);
    expect(String((m as { eventId: unknown }).eventId)).toBe(E);
  });

  it('a venue scope becomes a venueId filter', () => {
    const m = scopeMatch({ venueId: V });
    expect(Object.keys(m)).toEqual(['venueId']);
    expect(String((m as { venueId: unknown }).venueId)).toBe(V);
  });

  it('refuses an owner with neither id', () => {
    expect(() => scopeMatch({} as never)).toThrow('scope requires an eventId or a venueId');
  });

  it('reads the owner of a document', () => {
    expect(scopeOfDoc({ eventId: E })).toEqual({ kind: 'event', eventId: E });
    expect(scopeOfDoc({ venueId: new mongoose.Types.ObjectId(V) })).toEqual({ kind: 'venue', venueId: V });
    expect(scopeOfDoc({})).toBeNull();
    expect(scopeOfDoc(null)).toBeNull();
  });

  it('requireScopeOf throws loudly for an ownerless document', () => {
    expect(() => requireScopeOf({})).toThrow('document has neither an eventId nor a venueId');
  });

  it('belongsToScope needs the same kind AND the same id', () => {
    const venue = { kind: 'venue', venueId: V } as const;
    expect(belongsToScope({ venueId: V }, venue)).toBe(true);
    expect(belongsToScope({ venueId: new mongoose.Types.ObjectId().toHexString() }, venue)).toBe(false);
    expect(belongsToScope({ eventId: V }, venue)).toBe(false); // same hex, wrong kind
    expect(belongsToScope({ eventId: E }, { kind: 'event', eventId: E })).toBe(true);
    expect(belongsToScope(null, venue)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd ~/Documents/omevision/contracts/carrot-tickets/api-venue-wt && npx jest src/utils/__tests__/tradingScope.util.test.ts --runInBand`
Expected: FAIL — `Cannot find module '@utils/tradingScope.util'`.

- [ ] **Step 3: Write the util**

`src/utils/tradingScope.util.ts`:

```ts
import mongoose from 'mongoose';

/**
 * Who owns a piece of cashless data: one event, or one venue (venue trading
 * spec § Architecture). Resolved per request by eventScope / venueScope.
 */
export type TradingScope =
  | { kind: 'event'; eventId: string }
  | { kind: 'venue'; venueId: string };

type Id = string | mongoose.Types.ObjectId;

/**
 * Exactly one owner id, as service inputs carry it. Every existing event
 * caller keeps passing `eventId` unchanged; venue callers pass `venueId`. The
 * `?: never` arms make "both" and "neither" compile errors.
 */
export type ScopeIds =
  | { eventId: Id; venueId?: never }
  | { venueId: Id; eventId?: never };

export type ScopeMatch =
  | { eventId: mongoose.Types.ObjectId }
  | { venueId: mongoose.Types.ObjectId };

const oid = (v: Id): mongoose.Types.ObjectId =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v));

export function scopeIds(scope: TradingScope): ScopeIds {
  return scope.kind === 'event' ? { eventId: scope.eventId } : { venueId: scope.venueId };
}

/** The owner as a query filter — and, being the same shape, as the fields to write. */
export function scopeMatch(ids: ScopeIds): ScopeMatch {
  if (ids.venueId != null) return { venueId: oid(ids.venueId) };
  if (ids.eventId != null) return { eventId: oid(ids.eventId) };
  throw new Error('scope requires an eventId or a venueId');
}

type Owned = { eventId?: unknown; venueId?: unknown } | null | undefined;

export function scopeOfDoc(doc: Owned): TradingScope | null {
  if (!doc) return null;
  if (doc.venueId != null) return { kind: 'venue', venueId: String(doc.venueId) };
  if (doc.eventId != null) return { kind: 'event', eventId: String(doc.eventId) };
  return null;
}

/** For code that has already loaded a document the schema guarantees is owned. */
export function requireScopeOf(doc: Owned): TradingScope {
  const scope = scopeOfDoc(doc);
  if (!scope) throw new Error('document has neither an eventId nor a venueId');
  return scope;
}

export function belongsToScope(doc: Owned, scope: TradingScope): boolean {
  const own = scopeOfDoc(doc);
  if (!own || own.kind !== scope.kind) return false;
  return own.kind === 'event'
    ? own.eventId === (scope as { eventId: string }).eventId
    : own.venueId === (scope as { venueId: string }).venueId;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx jest src/utils/__tests__/tradingScope.util.test.ts --runInBand` — 6 passed.

- [ ] **Step 5: Write the failing model test**

`src/models/__tests__/tradingScope.models.test.ts` (validate-only — no database needed; it checks the OWNER rule, so other missing required fields do not matter):

```ts
import mongoose from 'mongoose';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';
import { StockTransfer } from '@models/stockTransfer.model';

const OWNER_RULE = 'exactly one of eventId or venueId is required';
const id = () => new mongoose.Types.ObjectId();

/** The owner-rule error on `doc`, or undefined. Other validation errors are ignored. */
async function ownerError(doc: mongoose.Document): Promise<string | undefined> {
  try {
    await doc.validate();
    return undefined;
  } catch (e: any) {
    return e?.errors?.venueId?.message;
  }
}

const MODELS: Array<[string, mongoose.Model<any>]> = [
  ['Merchant', Merchant],
  ['MerchantOperator', MerchantOperator],
  ['Product', Product],
  ['ProductStock', ProductStock],
  ['StockMovement', StockMovement],
  ['StockCount', StockCount],
  ['StockTransfer', StockTransfer],
];

describe.each(MODELS)('%s — event-or-venue ownership', (_name, Model) => {
  it('accepts an eventId alone', async () => {
    expect(await ownerError(new Model({ eventId: id() }))).toBeUndefined();
  });

  it('accepts a venueId alone', async () => {
    expect(await ownerError(new Model({ venueId: id() }))).toBeUndefined();
  });

  it('refuses neither', async () => {
    expect(await ownerError(new Model({}))).toBe(OWNER_RULE);
  });

  it('refuses both', async () => {
    expect(await ownerError(new Model({ eventId: id(), venueId: id() }))).toBe(OWNER_RULE);
  });

  it('has a venueId-led index for venue queries', () => {
    const keys = Model.schema.indexes().map(([k]) => Object.keys(k)[0]);
    expect(keys).toContain('venueId');
  });
});
```

(`Product`'s venue index arrives in Task 2 as `{ barcode: 1, venueId: 1 }`, which is NOT venueId-led. To keep this test honest for Product, Task 1 also adds `productSchema.index({ venueId: 1, active: 1 })` — the venue catalogue list query.)

- [ ] **Step 6: Run it — expect FAIL**

Run: `npx jest src/models/__tests__/tradingScope.models.test.ts --runInBand`
Expected: FAIL — "accepts a venueId alone" reports the `eventId` required error / missing owner rule, and no venueId index exists.

- [ ] **Step 7: Write the plugin**

`src/models/tradingScope.schema.ts`:

```ts
import { Schema } from 'mongoose';

/**
 * Event-or-venue ownership for cashless and stock documents (venue trading
 * spec § Architecture). Adds `venueId` and enforces EXACTLY ONE owner: a
 * document with both, or neither, fails validation. The host schema declares
 * `eventId` WITHOUT `required` — this hook is the single owner rule.
 *
 * Document validation only: an `updateOne`/`findOneAndUpdate` upsert does not
 * run it, so every upsert that can insert one of these documents must write
 * the owner itself (StockService.applyMovement does, via scopeMatch).
 */
export function applyTradingScope(schema: Schema): void {
  schema.add({ venueId: { type: Schema.Types.ObjectId, ref: 'Venue' } });
  schema.pre('validate', function (next) {
    const hasEvent = this.get('eventId') != null;
    const hasVenue = this.get('venueId') != null;
    if (hasEvent === hasVenue) {
      this.invalidate('venueId', 'exactly one of eventId or venueId is required');
    }
    next();
  });
}
```

- [ ] **Step 8: Apply it to the seven models**

For EACH model below: in the `eventId` schema field, delete `required: true` (keep `type`, `ref`, and any `index: true`); import `{ applyTradingScope }` from `@models/tradingScope.schema`; call `applyTradingScope(<schema>)` immediately before the first `<schema>.index(` line; add the listed venue index right after the existing event index.

| Model file | Schema var | Add index |
|---|---|---|
| `merchant.model.ts` | `merchantSchema` | `merchantSchema.index({ venueId: 1, status: 1 });` |
| `merchantOperator.model.ts` | `merchantOperatorSchema` | `merchantOperatorSchema.index({ venueId: 1, isActive: 1 });` |
| `product.model.ts` | `productSchema` | `productSchema.index({ venueId: 1, active: 1 });` |
| `productStock.model.ts` | `productStockSchema` | `productStockSchema.index({ venueId: 1, productId: 1 });` |
| `stockMovement.model.ts` | `stockMovementSchema` | `stockMovementSchema.index({ venueId: 1, reason: 1, at: -1 });` |
| `stockCount.model.ts` | `stockCountSchema` | `stockCountSchema.index({ venueId: 1, phase: 1, at: -1 });` |
| `stockTransfer.model.ts` | `stockTransferSchema` | `stockTransferSchema.index({ venueId: 1, at: -1 });` |

`merchantOperator.model.ts` already calls `applyOperatorCredentials(merchantOperatorSchema)`; call `applyTradingScope` right after it.

In each model's TypeScript interface (in the model file, or `src/interfaces/merchant.interface.ts` / `merchantOperator.interface.ts`), change `eventId: (mongoose.)Types.ObjectId;` to:

```ts
  /** Exactly one of eventId / venueId is set (applyTradingScope). */
  eventId?: Types.ObjectId;
  venueId?: Types.ObjectId;
```
(using `mongoose.Types.ObjectId` where the file already writes it that way; `stockCount.model.ts` declares several fields on one line — split `eventId` out onto its own lines as above).

- [ ] **Step 9: Fix the one compile error**

`npx tsc --noEmit -p .` now reports exactly one error: `src/services/merchantAuth.service.ts` — `'merchant.eventId' is possibly 'undefined'`. In `MerchantAuthService.login`, directly after the `const merchant = await Merchant.findOne(...)` / `if (!merchant) throw ...` lines, add:

```ts
    // Venue stalls' tills sign in from venue Phase 2 Task 6; until then a stall
    // with no event cannot mint a merchant token.
    if (!merchant.eventId) throw new Error('Venue tills cannot sign in yet');
```

Then `npx tsc --noEmit -p .` must be clean.

- [ ] **Step 10: Run the new tests and the neighbouring model/route suites — expect PASS**

Run: `npx jest src/utils/__tests__/tradingScope.util.test.ts src/models/__tests__/tradingScope.models.test.ts src/models/__tests__/merchant.model.test.ts src/routes/__tests__/merchantAdmin.route.test.ts src/routes/__tests__/merchantOperatorAdmin.route.test.ts src/routes/__tests__/stockAdmin.route.test.ts --runInBand`
Expected: all pass (35 new model cases + 6 util + the existing suites unchanged).

- [ ] **Step 11: Commit**

```bash
git add src/utils/tradingScope.util.ts src/models/tradingScope.schema.ts src/interfaces/merchant.interface.ts src/interfaces/merchantOperator.interface.ts src/models/merchant.model.ts src/models/merchantOperator.model.ts src/models/product.model.ts src/models/productStock.model.ts src/models/stockMovement.model.ts src/models/stockCount.model.ts src/models/stockTransfer.model.ts src/services/merchantAuth.service.ts src/utils/__tests__/tradingScope.util.test.ts src/models/__tests__/tradingScope.models.test.ts
git commit -m "feat(venue): event-or-venue ownership on the seven cashless/stock models"
```

---

## Task 2: Product barcode indexes per owner + migration script (API)

**Files:**
- Modify: `src/models/product.model.ts` (the barcode index)
- Create: `src/scripts/migrate-product-barcode-index.ts`
- Test: `src/scripts/__tests__/migrate-product-barcode-index.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Product` with `venueId`).
- Produces: `migrateProductBarcodeIndex(): Promise<{ legacyDropped: boolean }>`; Product indexes named `event_barcode_unique` and `venue_barcode_unique`.

- [ ] **Step 1: Write the failing test**

`src/scripts/__tests__/migrate-product-barcode-index.test.ts`:

```ts
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Product } from '@models/product.model';
import { migrateProductBarcodeIndex } from '../migrate-product-barcode-index';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const LEGACY = 'eventId_1_barcode_1';
const coll = () => mongoose.connection.db!.collection('products');
const id = () => new mongoose.Types.ObjectId();
const product = (owner: Record<string, unknown>, barcode = '6001240100015') =>
  Product.create({ ...owner, name: 'Coke 330ml', category: 'soft_drink', price: 1500, barcode });

async function createLegacyIndex() {
  await coll().createIndex(
    { eventId: 1, barcode: 1 },
    { name: LEGACY, unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
  );
}

describe('product barcode indexes', () => {
  afterEach(async () => {
    const names = (await coll().indexes()).map((i) => i.name);
    if (names.includes(LEGACY)) await coll().dropIndex(LEGACY);
  });

  it('the legacy index makes the same barcode at two venues collide (the bug)', async () => {
    await createLegacyIndex();
    await product({ venueId: id() });
    await expect(product({ venueId: id() })).rejects.toMatchObject({ code: 11000 });
  });

  it('the migration drops the legacy index; per-owner uniqueness then holds', async () => {
    await createLegacyIndex();
    expect(await migrateProductBarcodeIndex()).toEqual({ legacyDropped: true });
    const names = (await coll().indexes()).map((i) => i.name);
    expect(names).not.toContain(LEGACY);
    expect(names).toEqual(expect.arrayContaining(['event_barcode_unique', 'venue_barcode_unique']));

    const venueA = id(); const venueB = id(); const eventA = id();
    await product({ venueId: venueA });
    await product({ venueId: venueB });                 // other venue: allowed
    await product({ eventId: eventA });                 // an event: allowed
    await expect(product({ venueId: venueA })).rejects.toMatchObject({ code: 11000 }); // same venue
    await expect(product({ eventId: eventA })).rejects.toMatchObject({ code: 11000 }); // same event
  });

  it('is idempotent', async () => {
    expect(await migrateProductBarcodeIndex()).toEqual({ legacyDropped: false });
  });

  it('products without a barcode never collide', async () => {
    const venue = id();
    await Product.create({ venueId: venue, name: 'Ice', category: 'other', price: 500 });
    await Product.create({ venueId: venue, name: 'Cups', category: 'other', price: 100 });
    expect(await Product.countDocuments({ venueId: venue })).toBe(2);
  });
});
```

Before running, open `src/interfaces/stock.interface.ts` and replace `'soft_drink'` / `'other'` with real `ProductCategory` values if those are not members (keep one value that every product test can use).

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/scripts/__tests__/migrate-product-barcode-index.test.ts --runInBand`
Expected: FAIL — `Cannot find module '../migrate-product-barcode-index'`.

- [ ] **Step 3: Replace the product barcode index**

In `src/models/product.model.ts` replace the existing `productSchema.index({ eventId: 1, barcode: 1 }, { unique: true, partialFilterExpression: ... })` block with:

```ts
// Unique barcode per OWNER (event or venue), only for products that HAVE one.
// The legacy `eventId_1_barcode_1` indexed a venue product's missing eventId as
// null, so the same barcode at two venues collided. These replace it under NEW
// names and a reversed key order, so they can be built beside the legacy index
// on any MongoDB version (no same-name or same-key-pattern conflict);
// scripts/migrate-product-barcode-index.ts then drops the legacy one.
// partialFilterExpression (not sparse): see the {null} collision noted above.
productSchema.index(
  { barcode: 1, eventId: 1 },
  {
    name: 'event_barcode_unique',
    unique: true,
    partialFilterExpression: { barcode: { $type: 'string' }, eventId: { $exists: true } },
  },
);
productSchema.index(
  { barcode: 1, venueId: 1 },
  {
    name: 'venue_barcode_unique',
    unique: true,
    partialFilterExpression: { barcode: { $type: 'string' }, venueId: { $exists: true } },
  },
);
```

Keep the existing explanatory comment about `partialFilterExpression` vs `sparse` above it.

- [ ] **Step 4: Write the migration script**

`src/scripts/migrate-product-barcode-index.ts`:

```ts
/**
 * Venue trading Phase 2 — drop the legacy product barcode index.
 *
 * `eventId_1_barcode_1` treated a venue product's missing eventId as null, so
 * one barcode at two venues collided. Product now declares
 * `event_barcode_unique` + `venue_barcode_unique` (built by autoIndex on boot,
 * or by this script); this drops the legacy one.
 *
 * Safe to re-run. Order-independent with the deploy: the new indexes have new
 * names and key orders, so they coexist with the legacy one until it is dropped.
 *
 * Run: MONGODB_URI=… npx ts-node -r tsconfig-paths/register src/scripts/migrate-product-barcode-index.ts
 */
import mongoose from 'mongoose';
import { getDatabaseURI } from '../config/database.config';
import { Product } from '../models/product.model';

const LEGACY = 'eventId_1_barcode_1';

/** Runs against the CURRENT mongoose connection, so a test can drive it. */
export async function migrateProductBarcodeIndex(): Promise<{ legacyDropped: boolean }> {
  await Product.createIndexes();
  const indexes = await Product.collection.indexes();
  if (!indexes.some((i) => i.name === LEGACY)) {
    console.log(`ℹ️  ${LEGACY} already gone`);
    return { legacyDropped: false };
  }
  await Product.collection.dropIndex(LEGACY);
  console.log(`🧹 dropped ${LEGACY}`);
  return { legacyDropped: true };
}

async function main(): Promise<void> {
  // autoIndex:false — the explicit createIndexes above is the only build.
  await mongoose.connect(getDatabaseURI(), { autoIndex: false });
  await migrateProductBarcodeIndex();
  await mongoose.disconnect();
}

// Importing this module (from its test) must not connect or exit.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('❌ migration failed', err); process.exit(1); });
}
```

Match the import style of `src/scripts/migrate-merchant-credentials.ts` (if it imports via `../` relative paths, as above, keep that).

- [ ] **Step 5: Run the tests — expect PASS**

Run: `npx jest src/scripts/__tests__/migrate-product-barcode-index.test.ts src/routes/__tests__/stockAdmin.route.test.ts --runInBand`
Expected: PASS — 4 new tests; the existing duplicate-barcode test in `stockAdmin.route.test.ts` (same event) still answers its 400.

- [ ] **Step 6: Commit**

```bash
git add src/models/product.model.ts src/scripts/migrate-product-barcode-index.ts src/scripts/__tests__/migrate-product-barcode-index.test.ts
git commit -m "feat(venue): per-owner product barcode indexes + migration dropping the legacy one"
```

---

## Task 3: Scope middleware, venue router, venue stalls + till staff (API)

**Files:**
- Create: `src/middleware/tradingScope.middleware.ts`
- Create: `src/routes/venue.route.ts`
- Modify: `src/routes/tickets.route.ts` (mount the venue router; `eventScope` on `GET/POST /merchants`; drop the Phase 1 `router.get('/venue', …)` line)
- Modify: `src/controllers/merchantAdmin.controller.ts` (scope-aware; `loadOwnedEvent` moves OUT to the middleware)
- Modify: `src/controllers/merchantOperatorAdmin.controller.ts` (scope-aware)
- Test: `src/routes/__tests__/venueStalls.route.test.ts`

**Interfaces:**
- Consumes: Task 1 (`TradingScope`, `scopeIds`, `scopeMatch`, `belongsToScope`, models with `venueId`); Phase 1 `Venue` model + `VenueController.mine`.
- Produces (`@middleware/tradingScope.middleware`):
  - `loadOwnedEvent(req, res, eventId): Promise<any | null>` (moved verbatim from merchantAdmin.controller — now its only definition)
  - `eventScope(from: 'params' | 'query' | 'body', opts?: { requireCashless?: boolean })` — Express middleware
  - `venueScope` — Express middleware
  - `getScope(req): TradingScope` (throws if no scope middleware ran)
  - `scopeOwner(req): { event: { id: string; name: string } } | { venue: { id: string; name: string } }`
  - `resolveDocScope(req, res, doc, notFound: string): Promise<TradingScope | null>`
- Produces (`@routes/venue.route`): default-export Router, mounted at `/api/tickets/venue`. Tasks 4 and 5 append routes to it.

- [ ] **Step 1: Write the failing route tests**

`src/routes/__tests__/venueStalls.route.test.ts`:

```ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const { MANAGE_VENUE, MANAGE_STOCK, MANAGE_ACCESS } = TicketsPermission;
let seq = 0;

async function ownedVenue(opts: { status?: 'active' | 'suspended'; permissions?: string[] } = {}) {
  seq += 1;
  const vendor = await Vendor.create({ businessName: `Lounge ${seq}`, email: `lounge${seq}@x.co`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name: `Lounge ${seq}`, currency: 'SZL', status: opts.status ?? 'active', activatedBy: 'admin' });
  const token = signVendorToken(String(vendor._id), { permissions: opts.permissions ?? [MANAGE_VENUE, MANAGE_STOCK, MANAGE_ACCESS] });
  return { vendorId: String(vendor._id), venueId: String(venue._id), venueName: venue.name, auth: `Bearer ${token}` };
}
const eventStall = () => Merchant.create({ name: 'Event Bar', eventId: new mongoose.Types.ObjectId(), commissionPercent: 10 });

describe('venue stalls', () => {
  it('creates a stall owned by the venue, always at 0% commission', async () => {
    const v = await ownedVenue();
    const res = await request(app).post('/api/tickets/venue/stalls').set('Authorization', v.auth)
      .send({ name: 'Main Bar', commissionPercent: 15 });
    expect(res.status).toBe(201);
    const stored = await Merchant.findById(res.body.data.merchant._id).lean();
    expect(String(stored?.venueId)).toBe(v.venueId);
    expect(stored?.eventId).toBeUndefined();
    expect(stored?.commissionPercent).toBe(0);
  });

  it("lists only this venue's stalls", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    await Merchant.create({ name: 'A Bar', venueId: a.venueId });
    await Merchant.create({ name: 'B Bar', venueId: b.venueId });
    await eventStall();
    const res = await request(app).get('/api/tickets/venue/stalls').set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { name: string }) => m.name)).toEqual(['A Bar']);
  });

  it("renames its own stall (commission stays 0); another venue's stall and an event stall 404 untouched", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const mine = await Merchant.create({ name: 'Old', venueId: a.venueId });
    const theirs = await Merchant.create({ name: 'Theirs', venueId: b.venueId });
    const ev = await eventStall();
    const ok = await request(app).patch(`/api/tickets/venue/stalls/${mine._id}`).set('Authorization', a.auth)
      .send({ name: 'New', commissionPercent: 20 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.name).toBe('New');
    expect(ok.body.data.commissionPercent).toBe(0);
    for (const target of [theirs, ev]) {
      const res = await request(app).patch(`/api/tickets/venue/stalls/${target._id}`).set('Authorization', a.auth).send({ name: 'Hijack' });
      expect(res.status).toBe(404);
    }
    expect((await Merchant.findById(theirs._id).lean())?.name).toBe('Theirs');
    expect((await Merchant.findById(ev._id).lean())?.name).toBe('Event Bar');
  });

  it('an event route cannot reach a venue stall', async () => {
    const a = await ownedVenue();
    const mine = await Merchant.create({ name: 'Mine', venueId: a.venueId });
    const res = await request(app).patch(`/api/tickets/merchants/${mine._id}`).set('Authorization', a.auth).send({ name: 'x' });
    expect(res.status).toBe(404);
    expect((await Merchant.findById(mine._id).lean())?.name).toBe('Mine');
  });

  it('stall detail returns the stall and its VENUE (no event key)', async () => {
    const a = await ownedVenue();
    const mine = await Merchant.create({ name: 'Mine', venueId: a.venueId });
    const res = await request(app).get(`/api/tickets/venue/stalls/${mine._id}/transactions`).set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.merchant.name).toBe('Mine');
    expect(res.body.data.venue).toEqual({ id: a.venueId, name: a.venueName });
    expect(res.body.data.event).toBeUndefined();
  });

  it('a suspended venue gets 403; an account without a venue gets 404', async () => {
    const s = await ownedVenue({ status: 'suspended' });
    const suspended = await request(app).get('/api/tickets/venue/stalls').set('Authorization', s.auth);
    expect(suspended.status).toBe(403);
    expect(suspended.body.message).toBe('Venue trading is suspended');

    const organizer = await Vendor.create({ businessName: 'Gigs', email: 'gigs@x.co', password: 'secret1' });
    const none = await request(app).get('/api/tickets/venue/stalls')
      .set('Authorization', `Bearer ${signVendorToken(String(organizer._id), { permissions: [MANAGE_VENUE] })}`);
    expect(none.status).toBe(404);
    expect(none.body.message).toBe('No venue on this account');
  });

  it('stall writes need tickets:manage_venue; listing also accepts tickets:manage_stock', async () => {
    const v = await ownedVenue({ permissions: [MANAGE_STOCK] });
    expect((await request(app).post('/api/tickets/venue/stalls').set('Authorization', v.auth).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/tickets/venue/stalls').set('Authorization', v.auth)).status).toBe(200);
  });
});

describe('venue till staff', () => {
  it('issues credentials for a venue stall; the operator is owned by the venue', async () => {
    const v = await ownedVenue();
    const stall = await Merchant.create({ name: 'Main Bar', venueId: v.venueId });
    const res = await request(app).post(`/api/tickets/venue/stalls/${stall._id}/operators`).set('Authorization', v.auth)
      .send({ fullName: 'Thabo Dlamini' });
    expect(res.status).toBe(201);
    expect(res.body.data.loginCode).toEqual(expect.any(String));
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    const op = await MerchantOperator.findOne({ merchantId: stall._id }).lean();
    expect(String(op?.venueId)).toBe(v.venueId);
    expect(op?.eventId).toBeUndefined();
  });

  it('lists, renames and resets the PIN of its own operators', async () => {
    const v = await ownedVenue();
    const stall = await Merchant.create({ name: 'Main Bar', venueId: v.venueId });
    const created = await request(app).post(`/api/tickets/venue/stalls/${stall._id}/operators`).set('Authorization', v.auth).send({ fullName: 'Thabo' });
    const opId = created.body.data.operator._id;
    const list = await request(app).get(`/api/tickets/venue/stalls/${stall._id}/operators`).set('Authorization', v.auth);
    expect(list.body.data.operators).toHaveLength(1);
    const renamed = await request(app).patch(`/api/tickets/venue/operators/${opId}`).set('Authorization', v.auth).send({ fullName: 'Thabo D' });
    expect(renamed.body.data.operator.fullName).toBe('Thabo D');
    const reset = await request(app).post(`/api/tickets/venue/operators/${opId}/reset-pin`).set('Authorization', v.auth).send({});
    expect(reset.status).toBe(200);
    expect(reset.body.data.pin).toMatch(/^\d{6}$/);
  });

  it("404s another venue's operator", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const theirStall = await Merchant.create({ name: 'B Bar', venueId: b.venueId });
    const made = await request(app).post(`/api/tickets/venue/stalls/${theirStall._id}/operators`).set('Authorization', b.auth).send({ fullName: 'Sipho' });
    const res = await request(app).patch(`/api/tickets/venue/operators/${made.body.data.operator._id}`).set('Authorization', a.auth).send({ fullName: 'Hijack' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueStalls.route.test.ts --runInBand`
Expected: FAIL — `/api/tickets/venue/stalls` 404s (router not mounted).

- [ ] **Step 3: Write the middleware**

`src/middleware/tradingScope.middleware.ts`:

```ts
import { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { Venue } from '@models/venue.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { TradingScope, belongsToScope } from '@utils/tradingScope.util';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

/**
 * The caller must own the event (super-admin bypasses). Returns the event, or
 * null after sending the right 4xx. Moved here from merchantAdmin.controller so
 * the scope middleware and every stall/stock handler share ONE definition.
 */
export async function loadOwnedEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  if (!eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return null; }
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  const actor = actorOf(req);
  if (!actor.isSuperAdmin && String(event.vendorId) !== actor.vendorId) {
    ApiResponseUtil.forbidden(res, 'Event belongs to a different vendor'); return null;
  }
  return event;
}

/**
 * Resolve an EVENT scope from `req[from].eventId` under the same owner check
 * the handlers used to run themselves (`requireCashless` → the stock reports'
 * stricter loadOwnedCashlessEvent).
 */
export function eventScope(from: 'params' | 'query' | 'body', opts: { requireCashless?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const source = (from === 'params' ? req.params : from === 'query' ? req.query : req.body || {}) as Record<string, unknown>;
      const eventId = String(source['eventId'] || '');
      const event = opts.requireCashless
        ? await loadOwnedCashlessEvent(req, res, eventId)
        : await loadOwnedEvent(req, res, eventId);
      if (!event) return; // already answered
      (req as any).tradingScope = { kind: 'event', eventId: String(event._id) } as TradingScope;
      (req as any).scopeEvent = event;
      next();
    } catch (e) { next(e); }
  };
}

/**
 * Resolve the signed-in vendor's VENUE scope (venue trading spec). There is no
 * id in a venue URL: the venue is the vendor's own, so another venue cannot be
 * addressed at all.
 */
export async function venueScope(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
    const venue = vendorId && mongoose.isValidObjectId(vendorId)
      ? await Venue.findOne({ vendorId }).lean()
      : null;
    if (!venue) { ApiResponseUtil.notFound(res, 'No venue on this account'); return; }
    if (venue.status !== 'active') { ApiResponseUtil.forbidden(res, 'Venue trading is suspended'); return; }
    (req as any).tradingScope = { kind: 'venue', venueId: String(venue._id) } as TradingScope;
    (req as any).scopeVenue = venue;
    next();
  } catch (e) { next(e); }
}

/** The scope a scope middleware resolved. Throws loudly if a route forgot one. */
export function getScope(req: Request): TradingScope {
  const scope = (req as any).tradingScope as TradingScope | undefined;
  if (!scope) throw new Error('trading scope not resolved — route is missing eventScope/venueScope');
  return scope;
}

/** The scope's owner as a response field: `{ event: {id,name} }` or `{ venue: {id,name} }`. */
export function scopeOwner(req: Request): { event: { id: string; name: string } } | { venue: { id: string; name: string } } {
  const scope = getScope(req);
  const doc = scope.kind === 'event' ? (req as any).scopeEvent : (req as any).scopeVenue;
  if (!doc) throw new Error('trading scope owner not loaded');
  const ref = { id: String(doc._id), name: doc.name as string };
  return scope.kind === 'event' ? { event: ref } : { venue: ref };
}

/**
 * For a handler addressed by a DOCUMENT id (a stall, product or operator's
 * stall): the document must sit inside the route's scope. A venue route
 * already resolved its scope, so a document from another venue — or from an
 * event — reads as not found. A legacy event route (`/merchants/:id`,
 * `/products/:id`) has no scope yet: it is derived from the document's eventId
 * under loadOwnedEvent, which also refuses a venue document (no eventId).
 */
export async function resolveDocScope(
  req: Request, res: Response, doc: { eventId?: unknown; venueId?: unknown }, notFound: string,
): Promise<TradingScope | null> {
  const scope = (req as any).tradingScope as TradingScope | undefined;
  if (scope) {
    if (!belongsToScope(doc, scope)) { ApiResponseUtil.notFound(res, notFound); return null; }
    return scope;
  }
  if (doc.eventId == null) { ApiResponseUtil.notFound(res, notFound); return null; }
  const event = await loadOwnedEvent(req, res, String(doc.eventId));
  if (!event) return null;
  const derived: TradingScope = { kind: 'event', eventId: String(event._id) };
  (req as any).tradingScope = derived;
  (req as any).scopeEvent = event;
  return derived;
}
```

`organizerCashless.controller` must NOT import this middleware (or anything that does) — that would be an import cycle. Check with `git grep -n "tradingScope.middleware" -- src/controllers/organizerCashless.controller.ts` → no match.

- [ ] **Step 4: Make the stall and till-staff controllers scope-aware**

`src/controllers/merchantAdmin.controller.ts` — replace the whole file with:

```ts
// api/src/controllers/merchantAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { Merchant } from '@models/merchant.model';
import { MerchantService } from '@services/merchant.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { getScope, resolveDocScope, scopeOwner } from '@middleware/tradingScope.middleware';
import { scopeIds, scopeMatch } from '@utils/tradingScope.util';

/** A commission percent clamped to 0–100, or undefined when not a number. */
function clampCommission(raw: unknown): number | undefined {
  const c = Number(raw);
  return Number.isFinite(c) ? Math.min(100, Math.max(0, c)) : undefined;
}

/**
 * Stalls (merchants) for ONE scope — an event the caller owns, or the caller's
 * own venue. Routes resolve the scope (eventScope / venueScope); handlers
 * addressed by a stall id check it with resolveDocScope.
 */
export class MerchantAdminController {
  /** GET /api/tickets/merchants?eventId= | GET /api/tickets/venue/stalls */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchants = await Merchant.find(scopeMatch(scopeIds(getScope(req)))).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, merchants);
    } catch (err) { next(err); }
  }

  /** POST /api/tickets/merchants { eventId, name, commissionPercent } | POST /api/tickets/venue/stalls { name } */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = getScope(req);
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        ApiResponseUtil.badRequest(res, 'name is required'); return;
      }
      // A venue pays Carrot off-platform (spec): its stalls never carry a
      // commission, whatever the request says.
      const commissionPercent = scope.kind === 'venue' ? 0 : (clampCommission(req.body.commissionPercent) ?? 0);

      // No credentials are issued here: a stall does not log in. The people
      // who work its till are MerchantOperators, created separately, each
      // with their own loginCode + PIN.
      const merchant = await Merchant.create({ name: name.trim(), ...scopeMatch(scopeIds(scope)), commissionPercent });
      ApiResponseUtil.created(res, { merchant });
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/merchants/:id | PATCH /api/tickets/venue/stalls/:id { name?, commissionPercent?, isActive? } */
  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['id']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Vendor not found'); return; }
      const scope = await resolveDocScope(req, res, merchant, 'Vendor not found');
      if (!scope) return; // already answered

      if (typeof req.body.name === 'string' && req.body.name.trim()) merchant.name = req.body.name.trim();
      if (scope.kind === 'event' && req.body.commissionPercent !== undefined) {
        const c = clampCommission(req.body.commissionPercent);
        if (c !== undefined) merchant.commissionPercent = c;
      }
      if ('isActive' in req.body) merchant.status = req.body.isActive ? 'active' : 'suspended';
      else if (req.body.status === 'active' || req.body.status === 'suspended') merchant.status = req.body.status;
      await merchant.save();
      ApiResponseUtil.success(res, merchant);
    } catch (err) { next(err); }
  }

  /**
   * GET /api/tickets/merchants/:id/transactions | GET /api/tickets/venue/stalls/:id/transactions
   * The stall detail page: the stall + every charge it collected + running
   * takings, with its owner as `event` or `venue`.
   */
  static async transactions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['id']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Vendor not found'); return; }
      const scope = await resolveDocScope(req, res, merchant, 'Vendor not found');
      if (!scope) return;
      const rawLimit = Number(req.query['limit']);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
      const result = await MerchantService.listTransactions({ merchantId: String(merchant._id), limit });
      ApiResponseUtil.success(res, { merchant, ...scopeOwner(req), ...result });
    } catch (err) { next(err); }
  }
}
```

`src/controllers/merchantOperatorAdmin.controller.ts`:
- Replace `import { loadOwnedEvent } from '@controllers/merchantAdmin.controller';` with:
  ```ts
  import { resolveDocScope } from '@middleware/tradingScope.middleware';
  import { scopeIds, scopeMatch } from '@utils/tradingScope.util';
  ```
- In `list`, `create`, `update` and `resetPin`, replace each
  ```ts
      const event = await loadOwnedEvent(req, res, String(merchant.eventId));
      if (!event) return;
  ```
  (the `list` copy carries a trailing comment — drop it too) with
  ```ts
      const scope = await resolveDocScope(req, res, merchant, 'Stall not found');
      if (!scope) return; // 404 (other scope) or 403 (different organizer) already answered
  ```
- In `create`, replace the `eventId: merchant.eventId,` line in `MerchantOperator.create({...})` with `...scopeMatch(scopeIds(scope)),` (an operator belongs to its stall's owner).

- [ ] **Step 5: The venue router, and the event routes' scope**

`src/routes/venue.route.ts`:

```ts
import { Router } from 'express';
import { VenueController } from '@controllers/venue.controller';
import { MerchantAdminController } from '@controllers/merchantAdmin.controller';
import { MerchantOperatorAdminController } from '@controllers/merchantOperatorAdmin.controller';
import { requireAnyPermission, requireTicketsPermission } from '@middleware/ticketsAuth.middleware';
import { venueScope } from '@middleware/tradingScope.middleware';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

/**
 * Venue trading — the signed-in vendor's OWN venue (venue trading spec).
 * Mounted at /api/tickets/venue AFTER dualAuth. No id in any URL: venueScope
 * resolves the venue from the vendor, so another venue cannot be addressed.
 * The handlers are the same ones the event routes use.
 */
const router = Router();
const { MANAGE_VENUE, MANAGE_STOCK } = TicketsPermission;

// The vendor's venue (or null) and whether the Venue section applies — auth only.
router.get('/', VenueController.mine);

router.get('/stalls', requireAnyPermission([MANAGE_VENUE, MANAGE_STOCK]), venueScope, MerchantAdminController.list);
router.post('/stalls', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantAdminController.create);
router.patch('/stalls/:id', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantAdminController.update);
router.get('/stalls/:id/transactions', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantAdminController.transactions);
router.get('/stalls/:merchantId/operators', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantOperatorAdminController.list);
router.post('/stalls/:merchantId/operators', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantOperatorAdminController.create);
router.patch('/operators/:id', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantOperatorAdminController.update);
router.post('/operators/:id/reset-pin', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantOperatorAdminController.resetPin);

export default router;
```

In `src/routes/tickets.route.ts`:
- Add imports: `import venueRoutes from '@routes/venue.route';` and `import { eventScope } from '@middleware/tradingScope.middleware';`.
- Replace the Phase 1 lines
  ```ts
  // The signed-in vendor's own venue (or null) and whether the dashboard Venue
  // section applies. Auth only — see VenueController.mine.
  router.get('/venue', VenueController.mine);
  ```
  with
  ```ts
  // Venue trading — the signed-in vendor's own venue: GET /venue plus its
  // stalls, till staff, catalogue, stock and reports (routes/venue.route.ts).
  router.use('/venue', venueRoutes);
  ```
  and remove the now-unused `VenueController` import from this file.
- Add `eventScope(...)` after the permission middleware on two existing routes:
  ```ts
  router.get('/merchants', requireAnyPermission([TicketsPermission.MANAGE_ACCESS, TicketsPermission.MANAGE_STOCK]), eventScope('query'), MerchantAdminController.list);
  router.post('/merchants', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), eventScope('body'), MerchantAdminController.create);
  ```
  (`/merchants/:id`, `/merchants/:id/transactions` and the operator routes stay as they are — their handlers use resolveDocScope.)

- [ ] **Step 6: Run the new and existing suites — expect PASS**

Run: `npx jest src/routes/__tests__/venueStalls.route.test.ts src/routes/__tests__/merchantAdmin.route.test.ts src/routes/__tests__/merchantOperatorAdmin.route.test.ts src/routes/__tests__/venueMine.route.test.ts src/routes/__tests__/merchantRevocation.route.test.ts --runInBand`
Expected: PASS — 10 new tests; every existing suite unchanged (including Phase 1's `GET /venue`). Then `npx tsc --noEmit -p .` clean.

- [ ] **Step 7: Commit**

```bash
git add src/middleware/tradingScope.middleware.ts src/routes/venue.route.ts src/routes/tickets.route.ts src/controllers/merchantAdmin.controller.ts src/controllers/merchantOperatorAdmin.controller.ts src/routes/__tests__/venueStalls.route.test.ts
git commit -m "feat(venue): scope middleware + venue stalls and till staff on the shared handlers"
```

---

## Task 4: Venue catalogue + stock operations, product images (API)

**Files:**
- Modify: `src/utils/tradingScope.util.ts` (add `ownerWord`) + its test
- Modify: `src/services/stock.service.ts`, `src/services/stockCount.service.ts`, `src/services/stockTransfer.service.ts`
- Modify: `src/controllers/stockAdmin.controller.ts`
- Modify: `src/routes/venue.route.ts`, `src/routes/tickets.route.ts`
- Modify: `src/controllers/media.controller.ts`, `src/routes/media.route.ts`
- Test: `src/routes/__tests__/venueStock.route.test.ts`, `src/routes/__tests__/venueProductImage.route.test.ts`

**Interfaces:**
- Consumes: Task 1 util + models; Task 3 `getScope`, `resolveDocScope`, `venueScope`, `eventScope`, venue router.
- Produces:
  - `ownerWord(scope: TradingScope): 'this event' | 'this venue'`
  - `StockService.applyMovement(input: MovementInput)` with `type MovementInput = ScopeIds & { merchantId; productId; delta; reason; refType?; refId?; byType; by; note?; session? }`
  - `StockCountService.recordCount(params: ScopeIds & { merchantId: string; productId: string; countedOnHand: number; phase?; byType; by })`
  - `StockTransferService.transfer(params: ScopeIds & { productId; fromMerchantId; toMerchantId; qty; byType; by; note? })`
  - Routes: `GET/POST /api/tickets/venue/products`, `PATCH /api/tickets/venue/products/:id`, `POST /venue/stock/receive`, `PATCH /venue/stock/threshold`, `POST /venue/stock/transfer`, `POST /venue/stock/count`, `GET/PUT /venue/stock/allocations` — same bodies and responses as the event routes. `POST /api/media/venue/product` → `{ media: { key, url, type: 'product' } }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/utils/__tests__/tradingScope.util.test.ts` (and add `ownerWord` to that file's import):

```ts
  it('ownerWord names the owner kind in a refusal', () => {
    expect(ownerWord({ kind: 'event', eventId: E })).toBe('this event');
    expect(ownerWord({ kind: 'venue', venueId: V })).toBe('this venue');
  });
```

`src/routes/__tests__/venueStock.route.test.ts`:

```ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';
import { StockTransfer } from '@models/stockTransfer.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 0;
async function ownedVenue() {
  seq += 1;
  const vendor = await Vendor.create({ businessName: `Lounge ${seq}`, email: `stock${seq}@x.co`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name: `Lounge ${seq}`, currency: 'SZL', activatedBy: 'admin' });
  const token = signVendorToken(String(vendor._id), { permissions: [TicketsPermission.MANAGE_STOCK] });
  return { venueId: String(venue._id), auth: `Bearer ${token}` };
}
const CASTLE = { name: 'Castle Lite 330ml', category: 'beer', price: 2500, barcode: '6001240100015', unitsPerPack: 24, packLabel: 'case' };

describe('venue catalogue', () => {
  it("creates and lists products for its own venue only", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const created = await request(app).post('/api/tickets/venue/products').set('Authorization', a.auth).send(CASTLE);
    expect(created.status).toBe(201);
    expect(String((await Product.findById(created.body.data._id).lean())?.venueId)).toBe(a.venueId);
    await Product.create({ ...CASTLE, venueId: b.venueId, barcode: '6001240100099' });
    const list = await request(app).get('/api/tickets/venue/products').set('Authorization', a.auth);
    expect(list.body.data.map((p: { name: string }) => p.name)).toEqual(['Castle Lite 330ml']);
  });

  it('the same barcode at two venues is fine; twice in one venue is refused', async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    expect((await request(app).post('/api/tickets/venue/products').set('Authorization', a.auth).send(CASTLE)).status).toBe(201);
    expect((await request(app).post('/api/tickets/venue/products').set('Authorization', b.auth).send(CASTLE)).status).toBe(201);
    const dup = await request(app).post('/api/tickets/venue/products').set('Authorization', a.auth).send(CASTLE);
    expect(dup.status).toBe(400);
    expect(dup.body.message).toBe('A product with that barcode already exists at this venue');
  });

  it("edits its own product; another venue's and the event route 404", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const mine = await Product.create({ ...CASTLE, venueId: a.venueId });
    const theirs = await Product.create({ ...CASTLE, venueId: b.venueId });
    const ok = await request(app).patch(`/api/tickets/venue/products/${mine._id}`).set('Authorization', a.auth).send({ price: 2700 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.price).toBe(2700);
    expect((await request(app).patch(`/api/tickets/venue/products/${theirs._id}`).set('Authorization', a.auth).send({ price: 1 })).status).toBe(404);
    expect((await request(app).patch(`/api/tickets/products/${mine._id}`).set('Authorization', a.auth).send({ price: 1 })).status).toBe(404);
    expect((await Product.findById(theirs._id).lean())?.price).toBe(2500);
  });
});

describe('venue stock operations', () => {
  async function stallAndProduct(v: { venueId: string }) {
    const stall = await Merchant.create({ name: 'Main Bar', venueId: v.venueId });
    const store = await Merchant.create({ name: 'Store Room', venueId: v.venueId });
    const product = await Product.create({ ...CASTLE, venueId: v.venueId });
    return { stall, store, product };
  }

  it('receives cases into a stall; the row and the journal entry are venue-owned', async () => {
    const v = await ownedVenue();
    const { stall, product } = await stallAndProduct(v);
    const res = await request(app).post('/api/tickets/venue/stock/receive').set('Authorization', v.auth)
      .send({ merchantId: String(stall._id), productId: String(product._id), quantity: 2, unit: 'pack' });
    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(48);
    const row = await ProductStock.findOne({ merchantId: stall._id, productId: product._id }).lean();
    expect(String(row?.venueId)).toBe(v.venueId);
    expect(row?.eventId).toBeUndefined();
    const move = await StockMovement.findOne({ merchantId: stall._id }).lean();
    expect(String(move?.venueId)).toBe(v.venueId);
  });

  it("refuses another venue's stall", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const { product } = await stallAndProduct(a);
    const theirStall = await Merchant.create({ name: 'B Bar', venueId: b.venueId });
    const res = await request(app).post('/api/tickets/venue/stock/receive').set('Authorization', a.auth)
      .send({ merchantId: String(theirStall._id), productId: String(product._id), quantity: 1, unit: 'unit' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('merchant does not belong to this venue');
  });

  it('transfers between its stalls, counts, sets a threshold and allocations', async () => {
    const v = await ownedVenue();
    const { stall, store, product } = await stallAndProduct(v);
    const pid = String(product._id);
    await request(app).post('/api/tickets/venue/stock/receive').set('Authorization', v.auth)
      .send({ merchantId: String(store._id), productId: pid, quantity: 24, unit: 'unit' });

    const moved = await request(app).post('/api/tickets/venue/stock/transfer').set('Authorization', v.auth)
      .send({ productId: pid, fromMerchantId: String(store._id), toMerchantId: String(stall._id), qty: 10 });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ fromOnHand: 14, toOnHand: 10 });
    expect(String((await StockTransfer.findOne({ productId: product._id }).lean())?.venueId)).toBe(v.venueId);

    const counted = await request(app).post('/api/tickets/venue/stock/count').set('Authorization', v.auth)
      .send({ merchantId: String(stall._id), productId: pid, countedOnHand: 9, phase: 'closing' });
    expect(counted.status).toBe(200);
    expect(counted.body.data).toMatchObject({ expectedOnHand: 10, countedOnHand: 9, variance: -1 });
    expect(String((await StockCount.findOne({ merchantId: stall._id }).lean())?.venueId)).toBe(v.venueId);

    const thr = await request(app).patch('/api/tickets/venue/stock/threshold').set('Authorization', v.auth)
      .send({ merchantId: String(stall._id), productId: pid, lowStockThreshold: 5 });
    expect(thr.status).toBe(200);

    const newStall = await Merchant.create({ name: 'Patio', venueId: v.venueId });
    const alloc = await request(app).put('/api/tickets/venue/stock/allocations').set('Authorization', v.auth)
      .send({ productId: pid, merchantIds: [String(stall._id), String(store._id), String(newStall._id)] });
    expect(alloc.status).toBe(200);
    const patioRow = await ProductStock.findOne({ merchantId: newStall._id }).lean();
    expect(String(patioRow?.venueId)).toBe(v.venueId);
    const list = await request(app).get('/api/tickets/venue/stock/allocations').set('Authorization', v.auth);
    expect(list.body.data.allocations[pid]).toHaveLength(3);
  });
});
```

`src/routes/__tests__/venueProductImage.route.test.ts` — first read `src/routes/__tests__/mediaItemImage.route.test.ts` and copy how it mocks `R2Service` and attaches a file; then:

```ts
// (imports + R2Service mock exactly as mediaItemImage.route.test.ts, plus Vendor/Venue + signVendorToken + TicketsPermission)
it('uploads a venue product image under venues/<venueId>/product', async () => {
  // ownedVenue() as in venueStock.route.test.ts, with permissions [MANAGE_STOCK]
  (R2Service.uploadFile as jest.Mock).mockResolvedValue({ key: 'venues/x/product/1-a.png', url: 'https://cdn/x.png' });
  const res = await request(app).post('/api/media/venue/product').set('Authorization', v.auth)
    .attach('image', Buffer.from(PNG_BYTES), 'a.png'); // PNG_BYTES: reuse the fixture/bytes the sibling test uses
  expect(res.status).toBe(200);
  expect(res.body.data.media).toEqual({ key: 'venues/x/product/1-a.png', url: 'https://cdn/x.png', type: 'product' });
  expect((R2Service.uploadFile as jest.Mock).mock.calls[0][0]).toBe(`venues/${v.venueId}/product`);
});

it('refuses an account with no venue (404) before touching R2', async () => {
  // a plain organizer token with MANAGE_STOCK
  expect(res.status).toBe(404);
  expect(R2Service.uploadFile).not.toHaveBeenCalled();
});
```
(Write both tests concretely from the sibling file's fixtures; do not leave the comments as-is.)

- [ ] **Step 2: Run them — expect FAIL**

Run: `npx jest src/utils/__tests__/tradingScope.util.test.ts src/routes/__tests__/venueStock.route.test.ts src/routes/__tests__/venueProductImage.route.test.ts --runInBand`
Expected: FAIL — `ownerWord` not exported; venue product/stock routes 404.

- [ ] **Step 3: `ownerWord`**

Append to `src/utils/tradingScope.util.ts`:

```ts
/** The owner as refusal copy: "this event" / "this venue". */
export function ownerWord(scope: TradingScope): 'this event' | 'this venue' {
  return scope.kind === 'event' ? 'this event' : 'this venue';
}
```

- [ ] **Step 4: Scope the three stock services**

`src/services/stock.service.ts`:
- Import `{ ScopeIds, scopeMatch }` from `@utils/tradingScope.util`.
- Replace `export interface MovementInput { eventId: …; merchantId: …` with:
  ```ts
  /** Exactly one owner (ScopeIds) — event callers pass `eventId` exactly as before. */
  export type MovementInput = ScopeIds & {
    merchantId: string | mongoose.Types.ObjectId;
    productId: string | mongoose.Types.ObjectId;
    delta: number;
    reason: StockMovementReason;
    refType?: string;
    refId?: string;
    byType: StockMovementByType;
    by: string;
    note?: string;
    session?: ClientSession;
  };
  ```
  (keep every doc comment that sat on the old fields).
- In `applyMovement`, replace `const eventId = toId(input.eventId);` with:
  ```ts
    // The owner, written onto the row (on upsert-insert) and the journal entry.
    const owner = scopeMatch(input);
    const ownerField = 'venueId' in owner ? 'venueId' : 'eventId';
    const ownerId = 'venueId' in owner ? owner.venueId : owner.eventId;
  ```
- In the `ProductStock.findOneAndUpdate` pipeline replace `eventId: { $ifNull: ['$eventId', eventId] }` with `[ownerField]: { $ifNull: [`$${ownerField}`, ownerId] }`.
- In `StockMovement.create([{ eventId, merchantId, …`, replace `eventId,` with `...owner,`.

`src/services/stockCount.service.ts`:
- Import `{ ScopeIds, scopeMatch }` from `@utils/tradingScope.util`.
- Signature: `static async recordCount(params: ScopeIds & { merchantId: string; productId: string; countedOnHand: number; phase?: StockCountPhase; byType: IStockCount['byType']; by: string; })`.
- Destructure without `eventId`: `const { merchantId, productId, countedOnHand, phase = 'interim', byType, by } = params;` then `const owner = scopeMatch(params);`.
- `StockService.applyMovement({ eventId, merchantId, …` → `StockService.applyMovement({ ...owner, merchantId, …`.
- `StockCount.create([{ _id: countId, eventId, merchantId, …` → `StockCount.create([{ _id: countId, ...owner, merchantId, …`.

`src/services/stockTransfer.service.ts`: the same three edits (`ScopeIds & { productId: string; fromMerchantId: string; toMerchantId: string; qty: number; byType: IStockTransfer['byType']; by: string; note?: string }`; both `applyMovement` calls and `StockTransfer.create` use `...owner` in place of `eventId`).

Every existing event caller (`merchant.controller.ts`, `table.service.ts`, `merchant.service.ts`, `seedCashlessDemo.ts`) still passes `eventId` and compiles unchanged — confirm with `npx tsc --noEmit -p .`.

- [ ] **Step 5: Make the stock admin handlers scope-aware**

In `src/controllers/stockAdmin.controller.ts`:
- Delete the local `loadOwnedEvent` function and the `Event` model import. Keep `actorOf` (used for `by`).
- Add imports: `import { getScope, resolveDocScope } from '@middleware/tradingScope.middleware';` and `import { belongsToScope, ownerWord, scopeIds, scopeMatch } from '@utils/tradingScope.util';`.
- Move the trailing `import mongoose from 'mongoose'; function movementRef() …` (with its comment) to the top of the file with the other imports.
- In EVERY handler, replace
  ```ts
        const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
        if (!event) return;
  ```
  with
  ```ts
        const scope = getScope(req);
        const match = scopeMatch(scopeIds(scope));
  ```
  (drop `match` in a handler that does not use it).
- `updateProduct`: replace `const event = await loadOwnedEvent(req, res, String(product.eventId)); if (!event) return;` with `const scope = await resolveDocScope(req, res, product, 'Product not found'); if (!scope) return;`.
- Then apply these exact replacements throughout the file:

| Old | New |
|---|---|
| `Product.create({ ...value, eventId: event._id })` | `Product.create({ ...value, ...match })` |
| `'A product with that barcode already exists at this event'` (both copies) | `` `A product with that barcode already exists at ${ownerWord(scope)}` `` |
| `Product.find({ eventId: event._id })` | `Product.find(match)` |
| `!merchant \|\| String(merchant.eventId) !== String(event._id)` | `!merchant \|\| !belongsToScope(merchant, scope)` |
| `!product \|\| String(product.eventId) !== String(event._id)` | `!product \|\| !belongsToScope(product, scope)` |
| `!m \|\| String(m.eventId) !== String(event._id)` | `!m \|\| !belongsToScope(m, scope)` |
| `'merchant does not belong to this event'` | `` `merchant does not belong to ${ownerWord(scope)}` `` |
| `'product does not belong to this event'` | `` `product does not belong to ${ownerWord(scope)}` `` |
| `'a merchant does not belong to this event'` | `` `a merchant does not belong to ${ownerWord(scope)}` `` |
| `'one or more stalls do not belong to this event'` | `` `one or more stalls do not belong to ${ownerWord(scope)}` `` |
| `eventId: String(event._id),` (in `applyMovement` / `recordCount` calls) | `...scopeIds(scope),` |
| `StockTransferService.transfer({ eventId: String(event._id), …` | `StockTransferService.transfer({ ...scopeIds(scope), …` |
| `$setOnInsert: { eventId: event._id, onHand: 0 }` (setThreshold AND setAllocations) | `$setOnInsert: { ...match, onHand: 0 }` |
| `Product.find({ eventId: event._id }, { _id: 1 })` | `Product.find(match, { _id: 1 })` |
| `{ eventId: event._id, productId: { $in: products.map((p) => p._id) } }` | `{ ...match, productId: { $in: products.map((p) => p._id) } }` |
| `{ _id: { $in: wanted }, eventId: event._id }` | `{ _id: { $in: wanted }, ...match }` |
| `ProductStock.find({ eventId: event._id, productId: product._id })` | `ProductStock.find({ ...match, productId: product._id })` |

Update the handler doc comments to name both routes, e.g. `/** POST /api/tickets/events/:eventId/products | POST /api/tickets/venue/products */`. `git grep -n "event\._id\|eventId" -- src/controllers/stockAdmin.controller.ts` must return nothing afterwards.

- [ ] **Step 6: Routes**

`src/routes/tickets.route.ts` — add `eventScope('params')` after the permission middleware on each of these existing routes (order: permission, then scope, then handler):
`POST /events/:eventId/products`, `GET /events/:eventId/products`, `POST /events/:eventId/stock/receive`, `PATCH /events/:eventId/stock/threshold`, `POST /events/:eventId/stock/transfer`, `POST /events/:eventId/stock/count`, `GET /events/:eventId/stock/allocations`, `PUT /events/:eventId/stock/allocations`. Leave `PATCH /products/:id` as is (resolveDocScope).

`src/routes/venue.route.ts` — add `import { StockAdminController } from '@controllers/stockAdmin.controller';` and, before `export default`:

```ts
router.get('/products', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.listProducts);
router.post('/products', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.createProduct);
router.patch('/products/:id', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.updateProduct);
router.post('/stock/receive', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.receiveStock);
router.patch('/stock/threshold', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.setThreshold);
router.post('/stock/transfer', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.transferStock);
router.post('/stock/count', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.recordCount);
router.get('/stock/allocations', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.listAllocations);
router.put('/stock/allocations', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.setAllocations);
```

- [ ] **Step 7: Venue product images**

`src/controllers/media.controller.ts` — add (imports: `getScope` from `@middleware/tradingScope.middleware`; `R2Service` is already imported):

```ts
  /**
   * POST /api/media/venue/product — a venue catalogue image. venueScope has
   * already resolved the caller's own venue; stored under venues/<id>/product.
   */
  static async uploadVenueProductImage(req: Request, res: Response): Promise<any> {
    try {
      const scope = getScope(req);
      if (scope.kind !== 'venue') throw new Error('uploadVenueProductImage needs a venue scope');
      const file = req.file;
      if (!file) return ApiResponseUtil.validationError(res, 'No file uploaded');
      const { key, url } = await R2Service.uploadFile(
        `venues/${scope.venueId}/product`, file.originalname || 'product', file.buffer, file.mimetype,
      );
      ApiResponseUtil.success(res, { media: { key, url, type: 'product' } }, 'Image uploaded successfully');
    } catch (error: any) {
      console.error('Upload venue product image error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to upload image');
    }
  }
```

`src/routes/media.route.ts` — directly after the `/events/:eventId/product` route (imports: `requireTicketsPermission` from `@middleware/ticketsAuth.middleware`, `venueScope` from `@middleware/tradingScope.middleware`, `TicketsPermission` from `@interfaces/ticketsPermission.interface` — add only those not already imported):

```ts
/**
 * @route   POST /api/media/venue/product
 * @desc    Upload a product image for the caller's own venue catalogue
 * @access  Private (Vendor with a venue; tickets:manage_stock)
 */
router.post(
  '/venue/product',
  authenticateTickets,
  requireTicketsPermission(TicketsPermission.MANAGE_STOCK),
  venueScope,
  itemImageUpload.single('image'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadVenueProductImage,
);
```

- [ ] **Step 8: Run new + existing stock suites — expect PASS**

Run: `npx jest src/utils/__tests__/tradingScope.util.test.ts src/routes/__tests__/venueStock.route.test.ts src/routes/__tests__/venueProductImage.route.test.ts src/routes/__tests__/stockAdmin.route.test.ts src/routes/__tests__/mediaItemImage.route.test.ts src/routes/__tests__/merchantStockWrite.route.test.ts src/routes/__tests__/merchantStockAccess.route.test.ts src/routes/__tests__/merchantStockScoping.route.test.ts --runInBand`
Also run every existing test file under `src/services/__tests__/` whose name starts with `stock` (list them with `ls src/services/__tests__ | grep -i stock`).
Expected: all pass; existing suites unchanged. `npx tsc --noEmit -p .` clean.

- [ ] **Step 9: Commit**

```bash
git add src/utils/tradingScope.util.ts src/utils/__tests__/tradingScope.util.test.ts src/services/stock.service.ts src/services/stockCount.service.ts src/services/stockTransfer.service.ts src/controllers/stockAdmin.controller.ts src/routes/venue.route.ts src/routes/tickets.route.ts src/controllers/media.controller.ts src/routes/media.route.ts src/routes/__tests__/venueStock.route.test.ts src/routes/__tests__/venueProductImage.route.test.ts
git commit -m "feat(venue): venue catalogue, stock operations and product images on the shared stock code"
```

---

## Task 5: Venue stock reports — board, dashboard, movements, range reconciliation, PDF (API)

**Files:**
- Modify: `src/utils/eventTime.util.ts` (add `startOfLocalDay`) + test
- Modify: `src/services/stockReport.service.ts`
- Modify: `src/services/stockReconciliationPdf.service.ts` (header field `venue` → `subtitle`)
- Modify: `src/controllers/stockReport.controller.ts` (replace the whole file)
- Modify: `src/routes/tickets.route.ts`, `src/routes/venue.route.ts`
- Modify (mechanical call-shape edits only): `src/services/__tests__/stockReport.board.test.ts`, `stockReport.dashboard.test.ts`, `stockReport.reconciliation.test.ts`, `stockReconciliationPdf.service.test.ts`
- Test: `src/services/__tests__/stockReport.venue.test.ts`, `src/utils/__tests__/eventTime.startOfLocalDay.test.ts`, `src/routes/__tests__/venueStockReports.route.test.ts`

**Interfaces:**
- Consumes: Task 1 util; Task 3 `getScope`, `scopeOwner`, `eventScope`, `venueScope`; Task 4 venue router.
- Produces:
  - `startOfLocalDay(now: Date): Date`
  - `type ReconWindow = { doorsAt: Date } | { from: Date; to: Date }` (exported from stockReport.service)
  - `StockReportService.board(ids: ScopeIds)`, `.dashboard(ids: ScopeIds)`, `.movements(params: ScopeIds & { productId?; merchantId?; cursor?; limit? })`, `.reconciliation(ids: ScopeIds, window: ReconWindow)` — output shapes unchanged
  - `StockReconciliationPdfService.buildPdfBuffer(header: { name: string; subtitle?: string }, data, generatedAt?)`
  - Routes: `GET /api/tickets/venue/stock/{board,dashboard,movements,reconciliation,reconciliation.pdf}` — reconciliation takes optional `?from=&to=` ISO instants (default today, Africa/Mbabane); responses carry `venue: { id, name }` where the event routes carry `event: { id, name }`.

- [ ] **Step 1: Write the failing tests**

`src/utils/__tests__/eventTime.startOfLocalDay.test.ts`:

```ts
import { startOfLocalDay } from '@utils/eventTime.util';

describe('startOfLocalDay (Africa/Mbabane, UTC+2)', () => {
  it('23:30 local is still that day', () => {
    expect(startOfLocalDay(new Date('2026-10-02T21:30:00Z')).toISOString()).toBe('2026-10-01T22:00:00.000Z');
  });
  it('00:30 local is the next day', () => {
    expect(startOfLocalDay(new Date('2026-10-02T22:30:00Z')).toISOString()).toBe('2026-10-02T22:00:00.000Z');
  });
});
```

`src/services/__tests__/stockReport.venue.test.ts` (writes the journal directly so every timestamp is controlled):

```ts
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';
import { ProductStock } from '@models/productStock.model';
import { Product } from '@models/product.model';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { StockMovementReason as R } from '@interfaces/stock.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const oid = () => new mongoose.Types.ObjectId();
const at = (iso: string) => new Date(iso);
// The trading day 2 Oct 2026 in Eswatini: [00:00, 24:00) local = [Oct 1 22:00Z, Oct 2 22:00Z).
const FROM = at('2026-10-01T22:00:00Z');
const TO = at('2026-10-02T22:00:00Z');

async function seedVenue() {
  const venueId = oid();
  const stall = await Merchant.create({ name: 'Main Bar', venueId });
  const product = await Product.create({ name: 'Castle Lite', category: 'beer', price: 2500, venueId });
  const base = { venueId, merchantId: stall._id, productId: product._id, byType: 'Organizer', by: 'x' };
  return { venueId, stall, product, base };
}

describe('venue range reconciliation', () => {
  it('opens from the balance at the start of the day, closes on the balance at its end', async () => {
    const { venueId, base } = await seedVenue();
    const closingId = oid();
    await StockMovement.insertMany([
      { ...base, delta: 10, reason: R.RECEIVE, balanceAfter: 10, at: at('2026-10-01T07:00:00Z') }, // yesterday
      { ...base, delta: -2, reason: R.SALE, balanceAfter: 8, at: at('2026-10-01T18:00:00Z') },     // yesterday
      { ...base, delta: 5, reason: R.RECEIVE, balanceAfter: 13, at: at('2026-10-02T08:00:00Z') },
      { ...base, delta: -3, reason: R.SALE, balanceAfter: 10, at: at('2026-10-02T13:00:00Z') },
      { ...base, delta: -1, reason: R.COUNT_ADJUST, balanceAfter: 9, refType: 'stock_count', refId: String(closingId), at: at('2026-10-02T20:00:00Z') },
      { ...base, delta: 4, reason: R.RECEIVE, balanceAfter: 13, at: at('2026-10-03T07:00:00Z') },  // tomorrow
    ]);
    await StockCount.create({ ...base, _id: closingId, expectedOnHand: 10, countedOnHand: 9, variance: -1, phase: 'closing', at: at('2026-10-02T20:00:00Z') });
    await ProductStock.create({ venueId, merchantId: base.merchantId, productId: base.productId, onHand: 13 });

    const out = await StockReportService.reconciliation({ venueId }, { from: FROM, to: TO });
    expect(out.perBar).toHaveLength(1);
    expect(out.perBar[0]).toMatchObject({
      opening: 8, added: 5, sold: 3, countAdjust: -1, transferIn: 0, transferOut: 0,
      expectedClosing: 9, physicalCount: 9, variance: -1,
    });
    expect(out.total).toMatchObject({ opening: 8, added: 5, sold: 3, expectedClosing: 9 });
  });

  it('an opening count in the range is the baseline (its own adjustment excluded)', async () => {
    const { venueId, base } = await seedVenue();
    const openingId = oid();
    const closingId = oid();
    await StockMovement.insertMany([
      { ...base, delta: 10, reason: R.RECEIVE, balanceAfter: 10, at: at('2026-10-01T07:00:00Z') },
      { ...base, delta: -2, reason: R.SALE, balanceAfter: 8, at: at('2026-10-01T18:00:00Z') },
      { ...base, delta: -1, reason: R.COUNT_ADJUST, balanceAfter: 7, refType: 'stock_count', refId: String(openingId), at: at('2026-10-02T06:00:00Z') },
      { ...base, delta: 5, reason: R.RECEIVE, balanceAfter: 12, at: at('2026-10-02T08:00:00Z') },
      { ...base, delta: -3, reason: R.SALE, balanceAfter: 9, at: at('2026-10-02T13:00:00Z') },
      { ...base, delta: -1, reason: R.COUNT_ADJUST, balanceAfter: 8, refType: 'stock_count', refId: String(closingId), at: at('2026-10-02T20:00:00Z') },
    ]);
    await StockCount.create([
      { ...base, _id: openingId, expectedOnHand: 8, countedOnHand: 7, variance: -1, phase: 'opening', at: at('2026-10-02T06:00:00Z') },
      { ...base, _id: closingId, expectedOnHand: 9, countedOnHand: 8, variance: -1, phase: 'closing', at: at('2026-10-02T20:00:00Z') },
    ]);
    await ProductStock.create({ venueId, merchantId: base.merchantId, productId: base.productId, onHand: 8 });

    const out = await StockReportService.reconciliation({ venueId }, { from: FROM, to: TO });
    expect(out.perBar[0]).toMatchObject({
      opening: 7, added: 5, sold: 3, countAdjust: -1, expectedClosing: 8, physicalCount: 8, variance: -1,
    });
  });

  it('a stocked bar-product with no movement in the range still appears, carried at its balance', async () => {
    const { venueId, base } = await seedVenue();
    await StockMovement.create({ ...base, delta: 6, reason: R.RECEIVE, balanceAfter: 6, at: at('2026-09-30T10:00:00Z') });
    await ProductStock.create({ venueId, merchantId: base.merchantId, productId: base.productId, onHand: 6 });
    const out = await StockReportService.reconciliation({ venueId }, { from: FROM, to: TO });
    expect(out.perBar[0]).toMatchObject({ opening: 6, added: 0, sold: 0, expectedClosing: 6, physicalCount: null });
  });
});

describe('a venue never sees event sales', () => {
  it('board and dashboard ignore every event charge', async () => {
    await MerchantCharge.create({
      merchantId: oid(), eventId: oid(), walletId: oid(), bandUid: 'B1', amount: 2500, fee: 0, netAmount: 2500,
      clientTxnId: 'c1', status: 'completed', staffName: 'S',
      items: [{ productId: oid(), name: 'Coke', unitPrice: 2500, qty: 1, lineTotal: 2500 }],
    });
    const venueId = oid();
    expect(await StockReportService.board({ venueId })).toEqual({ perBar: [], byProduct: [] });
    const dash = await StockReportService.dashboard({ venueId });
    expect(dash.bestSellers).toEqual([]);
    expect(dash.salesByBar).toEqual([]);
  });
});
```

(If `StockMovement`/`StockCount` require a field not set above, add it from the schema — do not loosen the schema.)

`src/routes/__tests__/venueStockReports.route.test.ts` (`connectLedgerTestDb`; `ownedVenue()` as in Task 4's test but with permissions `[MANAGE_STOCK, VIEW_REVENUE]`):

```ts
describe('venue stock reports', () => {
  it("board lists its own stock only, tagged with the venue", async () => {
    // seed: venue A stall + product, POST /api/tickets/venue/stock/receive 6 units; venue B has its own stocked product
    const res = await request(app).get('/api/tickets/venue/stock/board').set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.venue).toEqual({ id: a.venueId, name: a.venueName });
    expect(res.body.data.perBar.map((r: any) => r.productName)).toEqual(['Castle Lite 330ml']);
  });

  it('reconciliation defaults to today and counts a receive made now as added', async () => {
    // after the receive above:
    const res = await request(app).get('/api/tickets/venue/stock/reconciliation').set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.perBar[0]).toMatchObject({ opening: 0, added: 6, expectedClosing: 6 });
  });

  it('rejects a bad or inverted range', async () => {
    const bad = await request(app).get('/api/tickets/venue/stock/reconciliation?from=nope').set('Authorization', a.auth);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('from and to must be ISO dates');
    const inverted = await request(app)
      .get('/api/tickets/venue/stock/reconciliation?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')
      .set('Authorization', a.auth);
    expect(inverted.status).toBe(400);
    expect(inverted.body.message).toBe('from must be before to');
  });

  it('serves the reconciliation PDF named after the venue', async () => {
    const res = await request(app).get('/api/tickets/venue/stock/reconciliation.pdf').set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('stock-reconciliation-Lounge-');
  });

  it('movements and dashboard answer for the venue; reports need tickets:view_revenue', async () => {
    expect((await request(app).get('/api/tickets/venue/stock/movements').set('Authorization', a.auth)).status).toBe(200);
    expect((await request(app).get('/api/tickets/venue/stock/dashboard').set('Authorization', a.auth)).status).toBe(200);
    // token with only MANAGE_STOCK:
    expect((await request(app).get('/api/tickets/venue/stock/board').set('Authorization', stockOnly.auth)).status).toBe(403);
  });
});
```
Write the seeding concretely (helpers as in `venueStock.route.test.ts`); the comments above mark what each test must set up, not text to leave in the file. Venue names are `Lounge <n>`, so the PDF filename slug starts `stock-reconciliation-Lounge-`.

- [ ] **Step 2: Run them — expect FAIL**

Run: `npx jest src/utils/__tests__/eventTime.startOfLocalDay.test.ts src/services/__tests__/stockReport.venue.test.ts src/routes/__tests__/venueStockReports.route.test.ts --runInBand`
Expected: FAIL — `startOfLocalDay` not exported; `reconciliation({venueId}, …)` treats the object as an event id; venue report routes 404.

- [ ] **Step 3: `startOfLocalDay`**

Append to `src/utils/eventTime.util.ts`:

```ts
/**
 * Midnight at the start of `now`'s day in Africa/Mbabane, as an instant.
 * Eswatini is UTC+2 all year (no DST), so the offset is fixed.
 */
export function startOfLocalDay(now: Date): Date {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: EVENT_TIMEZONE }); // YYYY-MM-DD
  return new Date(`${ymd}T00:00:00+02:00`);
}
```

- [ ] **Step 4: Scope the report service**

In `src/services/stockReport.service.ts`:
- Import `{ ScopeIds, scopeMatch }` from `@utils/tradingScope.util`.
- `board(eventId: string)` → `board(ids: ScopeIds)`; `dashboard(eventId: string)` → `dashboard(ids: ScopeIds)`; in each replace `const eid = oid(eventId);` with `const match = scopeMatch(ids);`, every `{ eventId: eid }` filter with `match`, and every `{ eventId: eid, …rest }` with `{ ...match, …rest }`.
- `movements(params: { eventId: string; … })` → `movements(params: ScopeIds & { productId?: string; merchantId?: string; cursor?: string; limit?: number })`; destructure without `eventId`; `const q: any = { eventId: oid(eventId) };` → `const q: any = { ...scopeMatch(params) };`.
- Reconciliation: export `export type ReconWindow = { doorsAt: Date } | { from: Date; to: Date };` and restructure so both modes share ONE copy of the row/fold/rollup logic:

```ts
const reconKey = (m: unknown, p: unknown) => `${m}|${p}`;

// inside the class:

  /**
   * Opening → Added → Transfers → Sold → Expected → Physical → Variance per
   * bar-product, rolled up per product + a grand total. An EVENT reconciles
   * from its doors (`doorsAt`); a VENUE over a time range — see
   * rangeReconciliation for why the opening differs.
   */
  static async reconciliation(ids: ScopeIds, window: ReconWindow) {
    return 'doorsAt' in window
      ? StockReportService.doorsReconciliation(ids, window.doorsAt)
      : StockReportService.rangeReconciliation(ids, window.from, window.to);
  }
```

  Then:
  1. Rename the existing `reconciliation(eventId: string, startTime: Date)` to `private static async doorsReconciliation(ids: ScopeIds, startTime: Date)`, keep its doc comment, replace `const eid = oid(eventId);` with `const match = scopeMatch(ids);` and every `eventId: eid` with `...match`.
  2. Extract from it, VERBATIM, five private static helpers and call them from `doorsReconciliation`:
     - `openingScope(openings: any[])` → the `const scope = openings.length === 0 ? {} : { $or: [...] }` expression.
     - `reconRows(products: any[], merchants: any[])` → returns `{ rows: Map<string, any>, ensure(merchantId: string, productId: string): any }` (the `productName`/`merchantName` maps, `rowByKey` and `ensure`).
     - `foldByReason(byReason: any[], ensure)` → the `switch (g._id.reason)` loop.
     - `applyCounts(counts: any[], ensure)` → the final `for (const c of counts)` loop.
     - `rollup(rows: Map<string, any>)` → `perBar` sort, `byProduct`, `total`; returns `{ perBar, byProduct, total }`.
     Use `reconKey` where the method had its local `key`. `doorsReconciliation`'s behaviour must not change — `stockReport.reconciliation.test.ts` proves it.
  3. Add the range mode:

```ts
  /**
   * A venue's reconciliation over [from, to). A venue trades every day, so a
   * range starts with stock already on the shelf: without an opening count,
   * `opening` is each bar-product's balance at `from` (balanceAfter of its last
   * movement before `from`), and `expectedClosing` is its balance at `to` — not
   * the live onHand, which would count anything after the range. Movements and
   * counts inside the range fold exactly as an event's do, including the
   * opening-count baseline rule.
   */
  private static async rangeReconciliation(ids: ScopeIds, from: Date, to: Date) {
    const match = scopeMatch(ids);
    const inRange = { at: { $gte: from, $lt: to } };

    const counts = await StockCount.aggregate([
      { $match: { ...match, ...inRange, phase: { $in: ['opening', 'closing'] } } },
      { $sort: { at: -1 } },
      { $group: { _id: { merchantId: '$merchantId', productId: '$productId', phase: '$phase' }, countId: { $first: '$_id' }, at: { $first: '$at' }, countedOnHand: { $first: '$countedOnHand' }, variance: { $first: '$variance' } } },
    ]);
    const openings = counts.filter((c: any) => c._id.phase === 'opening');
    const openingKeys = new Set(openings.map((c: any) => reconKey(c._id.merchantId, c._id.productId)));
    const scope = StockReportService.openingScope(openings);

    const balanceBefore = (t: Date) => StockMovement.aggregate([
      { $match: { ...match, at: { $lt: t } } },
      { $sort: { at: -1, _id: -1 } },
      { $group: { _id: { merchantId: '$merchantId', productId: '$productId' }, balance: { $first: '$balanceAfter' } } },
    ]);

    const [byReason, receives, atFrom, atTo, stockRows, products, merchants] = await Promise.all([
      StockMovement.aggregate([
        { $match: { ...match, ...inRange, ...scope } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId', reason: '$reason' }, qty: { $sum: '$delta' } } },
      ]),
      StockMovement.aggregate([
        { $match: { ...match, ...inRange, reason: StockMovementReason.RECEIVE, ...scope } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId' }, qty: { $sum: '$delta' } } },
      ]),
      balanceBefore(from),
      balanceBefore(to),
      ProductStock.find(match).lean(),
      Product.find(match).select('name').lean(),
      Merchant.find(match).select('name').lean(),
    ]);

    const { rows, ensure } = StockReportService.reconRows(products, merchants);
    // Every stocked bar-product appears, even with no movement in the range.
    for (const s of stockRows) ensure(String(s.merchantId), String(s.productId));
    for (const b of atFrom) {
      if (!openingKeys.has(reconKey(b._id.merchantId, b._id.productId))) {
        ensure(String(b._id.merchantId), String(b._id.productId)).opening = b.balance;
      }
    }
    for (const b of atTo) ensure(String(b._id.merchantId), String(b._id.productId)).expectedClosing = b.balance;
    StockReportService.foldByReason(byReason, ensure);
    for (const g of receives) ensure(String(g._id.merchantId), String(g._id.productId)).added += g.qty;
    StockReportService.applyCounts(counts, ensure);
    return StockReportService.rollup(rows);
  }
```

  If `oid` is no longer used anywhere in the file afterwards, delete it.

- [ ] **Step 5: The PDF header**

In `src/services/stockReconciliationPdf.service.ts`: rename the header type (currently `ReconciliationPdfEvent`, with `name` and `venue?`) to

```ts
/** The PDF's identity block: the event or venue name, and a line under it. */
export interface ReconciliationPdfHeader {
  name: string;
  /** An event's venue, or a venue report's date range. */
  subtitle?: string;
}
```
and replace every `event.venue` with `event.subtitle` (rename the parameter `event` → `header` throughout the file while you are in it). In `stockReconciliationPdf.service.test.ts`, the only allowed edit is the call shape: `{ name: …, venue: … }` → `{ name: …, subtitle: … }`.

- [ ] **Step 6: Replace the report controller**

`src/controllers/stockReport.controller.ts` — replace the whole file with:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { getScope, scopeOwner } from '@middleware/tradingScope.middleware';
import { StockReportService, ReconWindow } from '@services/stockReport.service';
import { StockReconciliationPdfService } from '@services/stockReconciliationPdf.service';
import { EVENT_TIMEZONE, startOfLocalDay } from '@utils/eventTime.util';
import { scopeIds } from '@utils/tradingScope.util';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A download filename an organiser can file without renaming: the event or
 * venue, then the date it describes. Anything outside [A-Za-z0-9-] is stripped,
 * so a name carrying a quote or a slash cannot break out of the
 * Content-Disposition header.
 */
function reconciliationFilename(ownerName: string): string {
  const slug = ownerName.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'stock';
  const date = new Date().toLocaleDateString('en-CA', { timeZone: EVENT_TIMEZONE }); // YYYY-MM-DD
  return `stock-reconciliation-${slug}-${date}.pdf`;
}

/**
 * The reconciliation window. An event reconciles from its doors (startTime).
 * A venue takes `?from=&to=` ISO instants, defaulting to today in
 * Africa/Mbabane; `to` defaults to a day after `from`. Null after a 400.
 */
function reconWindow(req: Request, res: Response): ReconWindow | null {
  const scope = getScope(req);
  if (scope.kind === 'event') return { doorsAt: (req as any).scopeEvent.startTime };
  const parse = (v: unknown) => (v === undefined ? undefined : new Date(String(v)));
  const from = parse(req.query['from']) ?? startOfLocalDay(new Date());
  const to = parse(req.query['to']) ?? new Date(from.getTime() + DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    ApiResponseUtil.badRequest(res, 'from and to must be ISO dates'); return null;
  }
  if (from.getTime() >= to.getTime()) { ApiResponseUtil.badRequest(res, 'from must be before to'); return null; }
  return { from, to };
}

/** "1 Oct 2026, 00:00 – 2 Oct 2026, 00:00" in Eswatini time — a venue PDF's subtitle. */
function rangeLabel(from: Date, to: Date): string {
  const f = (d: Date) => d.toLocaleString('en-GB', {
    timeZone: EVENT_TIMEZONE, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${f(from)} – ${f(to)}`;
}

/**
 * Stock reporting for an event (design 2026-08-13, Slice 4) or a venue (venue
 * trading Phase 2). Read-only. The route's scope middleware has already
 * asserted ownership (and, for events, cashless); VIEW_REVENUE-gated at the route.
 */
export class StockReportController {
  /** GET /api/tickets/events/:eventId/stock/board | GET /api/tickets/venue/stock/board */
  static async board(req: Request, res: Response): Promise<any> {
    try {
      const data = await StockReportService.board(scopeIds(getScope(req)));
      return ApiResponseUtil.success(res, { ...scopeOwner(req), ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock board', 500);
    }
  }

  /** GET …/stock/reconciliation (venue: ?from=&to=) */
  static async reconciliation(req: Request, res: Response): Promise<any> {
    try {
      const window = reconWindow(req, res);
      if (!window) return;
      const data = await StockReportService.reconciliation(scopeIds(getScope(req)), window);
      return ApiResponseUtil.success(res, { ...scopeOwner(req), ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load reconciliation', 500);
    }
  }

  /**
   * GET …/stock/reconciliation.pdf — the SAME reconciliation as above, rendered
   * for printing, so the page handed to a stall manager cannot disagree with
   * the one on screen.
   */
  static async reconciliationPdf(req: Request, res: Response): Promise<any> {
    try {
      const window = reconWindow(req, res);
      if (!window) return;
      const data = await StockReportService.reconciliation(scopeIds(getScope(req)), window);
      const owner = scopeOwner(req);
      const name = 'event' in owner ? owner.event.name : owner.venue.name;
      const subtitle = 'doorsAt' in window ? (req as any).scopeEvent.venue : rangeLabel(window.from, window.to);
      const buffer = await StockReconciliationPdfService.buildPdfBuffer({ name, subtitle }, data);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${reconciliationFilename(name)}"`);
      return res.send(buffer);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to build the reconciliation PDF', 500);
    }
  }

  /** GET …/stock/dashboard */
  static async dashboard(req: Request, res: Response): Promise<any> {
    try {
      const data = await StockReportService.dashboard(scopeIds(getScope(req)));
      return ApiResponseUtil.success(res, { ...scopeOwner(req), ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock dashboard', 500);
    }
  }

  /** GET …/stock/movements?productId=&merchantId=&cursor=&limit= */
  static async movements(req: Request, res: Response): Promise<any> {
    try {
      const hex24 = /^[0-9a-fA-F]{24}$/;
      const productId = req.query.productId ? String(req.query.productId) : undefined;
      const merchantId = req.query.merchantId ? String(req.query.merchantId) : undefined;
      const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
      if (productId && !hex24.test(productId)) { ApiResponseUtil.badRequest(res, 'invalid productId'); return; }
      if (merchantId && !hex24.test(merchantId)) { ApiResponseUtil.badRequest(res, 'invalid merchantId'); return; }
      if (cursor && !hex24.test(cursor)) { ApiResponseUtil.badRequest(res, 'invalid cursor'); return; }
      let limit: number | undefined;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isFinite(limit) || limit < 1) { ApiResponseUtil.badRequest(res, 'invalid limit'); return; }
      }
      const data = await StockReportService.movements({ ...scopeIds(getScope(req)), productId, merchantId, cursor, limit });
      return ApiResponseUtil.success(res, data);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock movements', 500);
    }
  }
}
```

Before replacing, diff the old file's comments against this one and carry over any explanatory comment this version dropped.

- [ ] **Step 7: Routes**

`src/routes/tickets.route.ts` — add `eventScope('params', { requireCashless: true })` after the permission middleware on the five existing routes `/events/:eventId/stock/board`, `/stock/reconciliation`, `/stock/reconciliation.pdf`, `/stock/dashboard`, `/stock/movements`.

`src/routes/venue.route.ts` — add `import { StockReportController } from '@controllers/stockReport.controller';`, extend the destructure to `const { MANAGE_VENUE, MANAGE_STOCK, VIEW_REVENUE } = TicketsPermission;`, and append:

```ts
router.get('/stock/board', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.board);
router.get('/stock/reconciliation', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.reconciliation);
router.get('/stock/reconciliation.pdf', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.reconciliationPdf);
router.get('/stock/dashboard', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.dashboard);
router.get('/stock/movements', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.movements);
```

- [ ] **Step 8: Mechanical call-shape edits in the existing service tests**

Only these edits are allowed in existing tests:
- `stockReport.board.test.ts`: `StockReportService.board(X)` → `StockReportService.board({ eventId: X })`.
- `stockReport.dashboard.test.ts`: `StockReportService.dashboard(X)` → `StockReportService.dashboard({ eventId: X })`.
- `stockReport.reconciliation.test.ts`: `StockReportService.reconciliation(X, T)` → `StockReportService.reconciliation({ eventId: X }, { doorsAt: T })`.
- `stockReport.movements.test.ts`: none needed (it already passes `{ eventId, … }`).
No assertion may change.

- [ ] **Step 9: Run new + existing report suites — expect PASS**

Run: `npx jest src/utils/__tests__/eventTime.startOfLocalDay.test.ts src/services/__tests__/stockReport.venue.test.ts src/routes/__tests__/venueStockReports.route.test.ts src/services/__tests__/stockReport.board.test.ts src/services/__tests__/stockReport.dashboard.test.ts src/services/__tests__/stockReport.movements.test.ts src/services/__tests__/stockReport.reconciliation.test.ts src/services/__tests__/stockReconciliationPdf.service.test.ts src/routes/__tests__/stockReportBoard.route.test.ts src/routes/__tests__/stockReportDashboard.route.test.ts src/routes/__tests__/stockReportMovements.route.test.ts src/routes/__tests__/stockReportReconciliation.route.test.ts src/routes/__tests__/stockReportReconciliationPdf.route.test.ts --runInBand`
Expected: all pass. `npx tsc --noEmit -p .` clean.

- [ ] **Step 10: Commit**

```bash
git add src/utils/eventTime.util.ts src/services/stockReport.service.ts src/services/stockReconciliationPdf.service.ts src/controllers/stockReport.controller.ts src/routes/tickets.route.ts src/routes/venue.route.ts src/services/__tests__/ src/utils/__tests__/eventTime.startOfLocalDay.test.ts src/routes/__tests__/venueStockReports.route.test.ts
git commit -m "feat(venue): venue stock reports with a date-range reconciliation and PDF"
```

---

## Task 6: Venue tills — sign-in, stock counting, refusals (API)

**Files:**
- Modify: `src/interfaces/merchant.interface.ts` (`MerchantToken`)
- Modify: `src/services/merchantAuth.service.ts` (replace the Task 1 guard)
- Modify: `src/middleware/merchantAuth.middleware.ts`
- Modify: `src/controllers/merchant.controller.ts`
- Modify: `src/services/posCatalog.service.ts` (`forMerchant`)
- Test: `src/routes/__tests__/venueTill.route.test.ts`

**Interfaces:**
- Consumes: Task 1 util (`requireScopeOf`, `scopeIds`, `scopeMatch`, `belongsToScope`) + Task 4 `ownerWord`; Task 3 operators created with `venueId`; Task 4 scoped stock services.
- Produces:
  - `MerchantToken`: `eventId?: string; eventName?: string; venueId?: string; venueName?: string` (exactly one of eventId / venueId)
  - Login response `operator` carries `venueId` + `venueName` for a venue till (and `eventId` + `eventName` for an event till, unchanged)
  - `PosCatalogService.forMerchant(merchantId: string, ids: ScopeIds)`

- [ ] **Step 1: Write the failing tests**

`src/routes/__tests__/venueTill.route.test.ts`:

```ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockCount } from '@models/stockCount.model';
import { StockMovement } from '@models/stockMovement.model';
import { ProductCategory } from '@interfaces/stock.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 950001;

async function venueTill() {
  const vendor = await Vendor.create({ businessName: 'Kwa-Linda', email: `till${seq}@x.co`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name: 'Kwa-Linda Lounge', currency: 'SZL', activatedBy: 'admin' });
  const stall = await Merchant.create({ name: 'Main Bar', venueId: venue._id });
  await Merchant.create({ name: 'Store Room', venueId: venue._id });
  const loginCode = String(seq++);
  await MerchantOperator.create({
    fullName: 'Nomsa', merchantId: stall._id, venueId: venue._id, loginCode, pin: '111111',
    grants: [OperatorGrant.MANAGE_STOCK],
  });
  const product = await Product.create({
    venueId: venue._id, name: 'Castle Lite 330ml', category: ProductCategory.BEER, price: 2500, unitsPerPack: 24, packLabel: 'case',
  });
  await ProductStock.create({ venueId: venue._id, merchantId: stall._id, productId: product._id, onHand: 10 });
  const login = await request(app).post('/api/operator/login').send({ loginCode, pin: '111111' });
  return { venue, stall, product, loginCode, login, auth: `Bearer ${login.body.data?.accessToken}` };
}

describe('venue till', () => {
  it('signs in carrying the venue, not an event', async () => {
    const t = await venueTill();
    expect(t.login.status).toBe(200);
    expect(t.login.body.data.type).toBe('merchant');
    expect(t.login.body.data.operator).toMatchObject({ venueId: String(t.venue._id), venueName: 'Kwa-Linda Lounge' });
    expect(t.login.body.data.operator.eventId).toBeUndefined();
    const decoded = jwt.verify(t.login.body.data.accessToken, JWT_SECRET) as Record<string, unknown>;
    expect(decoded['venueId']).toBe(String(t.venue._id));
    expect(decoded['eventId']).toBeUndefined();
  });

  it('sees its stall stock and counts it; the count is venue-owned', async () => {
    const t = await venueTill();
    const stock = await request(app).get('/api/merchant/stock').set('Authorization', t.auth);
    expect(stock.status).toBe(200);
    expect(JSON.stringify(stock.body.data)).toContain('Castle Lite 330ml');
    const count = await request(app).post('/api/merchant/stock/count').set('Authorization', t.auth)
      .send({ productId: String(t.product._id), countedOnHand: 8 });
    expect(count.status).toBe(200);
    expect(count.body.data).toMatchObject({ expectedOnHand: 10, countedOnHand: 8, variance: -2 });
    expect(String((await StockCount.findOne({ merchantId: t.stall._id }).lean())?.venueId)).toBe(String(t.venue._id));
  });

  it('receives a case into its stall and lists only its venue stalls', async () => {
    const t = await venueTill();
    const rec = await request(app).post('/api/merchant/stock/receive').set('Authorization', t.auth)
      .send({ productId: String(t.product._id), quantity: 1, unit: 'pack' });
    expect(rec.status).toBe(200);
    expect(String((await StockMovement.findOne({ merchantId: t.stall._id }).lean())?.venueId)).toBe(String(t.venue._id));
    await Merchant.create({ name: 'Other Venue Bar', venueId: (await Venue.create({ vendorId: (await Vendor.create({ businessName: 'X', email: 'x@x.co', password: 'secret1' }))._id, name: 'X', currency: 'ZAR', activatedBy: 'admin' }))._id });
    const stalls = await request(app).get('/api/merchant/stalls').set('Authorization', t.auth);
    expect(stalls.status).toBe(200);
    expect(JSON.stringify(stalls.body.data)).toContain('Store Room');
    expect(JSON.stringify(stalls.body.data)).not.toContain('Other Venue Bar');
  });

  it("refuses another venue's product", async () => {
    const t = await venueTill();
    const other = await Product.create({ venueId: (await Venue.create({ vendorId: (await Vendor.create({ businessName: 'Y', email: 'y@y.co', password: 'secret1' }))._id, name: 'Y', currency: 'ZAR', activatedBy: 'admin' }))._id, name: 'Coke', category: ProductCategory.SOFT_DRINK, price: 1500 });
    const res = await request(app).post('/api/merchant/stock/count').set('Authorization', t.auth)
      .send({ productId: String(other._id), countedOnHand: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('product does not belong to this venue');
  });

  it('refuses tag charges and table service at a venue till', async () => {
    const t = await venueTill();
    const charge = await request(app).post('/api/merchant/charge').set('Authorization', t.auth)
      .send({ bandUid: '04A1B2C3', amount: 2500, clientTxnId: 'x1' });
    expect(charge.status).toBe(403);
    expect(charge.body.message).toBe("Tag payments aren't used at venues");
    const tables = await request(app).get('/api/merchant/tables').set('Authorization', t.auth);
    expect(tables.status).toBe(403);
    expect(tables.body.message).toBe('Venue table service is not available yet');
  });

  it('a suspended venue refuses sign-in and every request from an issued token', async () => {
    const t = await venueTill();
    await Venue.updateOne({ _id: t.venue._id }, { $set: { status: 'suspended' } });
    const again = await request(app).post('/api/operator/login').send({ loginCode: t.loginCode, pin: '111111' });
    expect(again.status).toBe(401);
    expect(again.body.message).toBe('Venue trading is suspended');
    const stock = await request(app).get('/api/merchant/stock').set('Authorization', t.auth);
    expect(stock.status).toBe(401);
    expect(stock.body.message).toBe('Venue trading is suspended');
  });
});
```

Adjust the `/charge` body to whatever `chargeSchema` requires (read `src/validators/merchant.validator.ts`) so the request reaches the venue refusal — the refusal is checked BEFORE body validation (Step 4), so any body works; keep a plausible one.

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueTill.route.test.ts --runInBand`
Expected: FAIL — login answers 401 `Venue tills cannot sign in yet` (the Task 1 guard).

- [ ] **Step 3: Token + sign-in**

`src/interfaces/merchant.interface.ts` — in `MerchantToken`, replace `eventId: string;` and the `eventName?` field with:

```ts
  /** Exactly one of eventId / venueId — the stall's owner. */
  eventId?: string;
  /** The event's display name, for UI headers (event tills). */
  eventName?: string;
  venueId?: string;
  /** The venue's display name, for UI headers (venue tills). */
  venueName?: string;
```

`src/services/merchantAuth.service.ts` — imports: add `import { Venue } from '@models/venue.model';` and `import { requireScopeOf } from '@utils/tradingScope.util';`. Delete the Task 1 guard (`if (!merchant.eventId) throw new Error('Venue tills cannot sign in yet');` and its comment). Replace the block from `await clearPinLockout(...)` through the end of the `return { … }` with:

```ts
    // The stall's owner decides what the till shows and may do.
    const scope = requireScopeOf(merchant);
    let owner: { eventId: string; eventName?: string } | { venueId: string; venueName: string };
    if (scope.kind === 'venue') {
      const venue = await Venue.findById(scope.venueId).select('name status').lean();
      // A suspended venue's people are signed out with it — refused loudly.
      if (!venue || venue.status !== 'active') throw new Error('Venue trading is suspended');
      owner = { venueId: scope.venueId, venueName: venue.name };
    } else {
      // Best effort: a missing/deleted event must not block login, it just
      // means eventName comes back undefined and the UI falls back to the id.
      const event = await Event.findById(scope.eventId).select('name').lean();
      owner = { eventId: scope.eventId, ...(event?.name ? { eventName: event.name } : {}) };
    }

    await clearPinLockout(MerchantOperator, operator._id as any);

    // The role is the floor (every person on a till can charge); grants are
    // the per-person extras. Re-derived from the row on every request too —
    // see authenticateMerchant — so this is the POS's copy, not the gate.
    // deriveMerchantPermissions is the single definition of that formula,
    // shared with authenticateMerchant precisely so the two cannot drift.
    const permissions = deriveMerchantPermissions((operator as any).grants);

    const payload: MerchantToken = {
      scope: 'merchant',
      merchantId: (merchant._id as any).toString(),
      merchantOperatorId: (operator._id as any).toString(),
      operatorName: operator.fullName,
      name: merchant.name,
      ...owner,
      permissions,
    };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    return {
      accessToken,
      operator: {
        merchantId: payload.merchantId,
        merchantOperatorId: payload.merchantOperatorId,
        operatorName: operator.fullName,
        name: merchant.name,
        ...owner,
        // The POS renders from this (which tabs and actions to show). It is NOT
        // authorization — authenticateMerchant re-derives the same set from the
        // operator row on every request, and that is the only thing the server
        // trusts. Returned here so the client need not decode its own JWT.
        permissions,
      },
    };
```

(The venue check runs before `clearPinLockout`, so a suspended venue's correct PIN neither signs in nor resets the lockout counter.)

`src/middleware/merchantAuth.middleware.ts` — import `Venue`; in the `Promise.all`, add a third read and a check:

```ts
  let venue: { status?: string } | null = null;
  try {
    [operator, merchant, venue] = await Promise.all([
      MerchantOperator.findById(decoded.merchantOperatorId)
        .select('isActive grants')
        .lean<{ isActive?: boolean; grants?: string[] } | null>(),
      Merchant.findById(decoded.merchantId).select('status').lean<{ status?: string } | null>(),
      decoded.venueId
        ? Venue.findById(decoded.venueId).select('status').lean<{ status?: string } | null>()
        : Promise.resolve(null),
    ]);
  } catch (e) {
    next(e);
    return;
  }

  if (!operator || !operator.isActive) { ApiResponseUtil.unauthorized(res, 'Operator deactivated'); return; }
  if (!merchant || merchant.status !== 'active') { ApiResponseUtil.unauthorized(res, 'Merchant suspended'); return; }
  if (decoded.venueId && (!venue || venue.status !== 'active')) {
    ApiResponseUtil.unauthorized(res, 'Venue trading is suspended'); return;
  }
```
(declare `venue` next to the existing `operator` / `merchant` declarations, in the same style.)

- [ ] **Step 4: Scope the till handlers**

`src/services/posCatalog.service.ts` — `forMerchant(merchantId: string, eventId: string)` → `forMerchant(merchantId: string, ids: ScopeIds)`, and in its `Product.find({ eventId, active: true, … })` replace `eventId,` with `...scopeMatch(ids),` (import `ScopeIds`, `scopeMatch`).

`src/controllers/merchant.controller.ts`:
- Imports: `import { belongsToScope, ownerWord, requireScopeOf, scopeIds, scopeMatch } from '@utils/tradingScope.util';`.
- Above the class:

```ts
const NO_TAGS_AT_VENUES = "Tag payments aren't used at venues";
const NO_VENUE_TABLES = 'Venue table service is not available yet';

/**
 * The till's event, or null after a 403 for a VENUE till. Tag charges and
 * table service are event features in venue Phase 2; refusing explicitly
 * beats letting a venue token reach event-only queries with no event.
 */
function eventTill(req: Request, res: Response, refusal: string): string | null {
  const { eventId } = (req as any).merchant as MerchantToken;
  if (eventId) return eventId;
  ApiResponseUtil.forbidden(res, refusal);
  return null;
}
```
- `charge`: as its FIRST statement inside `try`, add `const eventId = eventTill(req, res, NO_TAGS_AT_VENUES); if (!eventId) return;`, and remove `eventId` from the later `const { merchantId, eventId, merchantOperatorId, operatorName } = merchant;` destructure.
- `tables` and `handOutTable`: the same, with `NO_VENUE_TABLES`, removing `eventId` from their destructures.
- `stock`: `PosCatalogService.forMerchant(merchantId, eventId)` → `PosCatalogService.forMerchant(merchantId, scopeIds(requireScopeOf(m)))` where `m` is the destructured token (rename to keep it, e.g. `const m = (req as any).merchant as MerchantToken; const { merchantId } = m;`).
- `stalls`: `Merchant.find({ eventId, status: 'active' })` → `Merchant.find({ ...scopeMatch(scopeIds(requireScopeOf(m))), status: 'active' })`.
- `recordCount`, `resolveProductAndUnits`, `receiveStock`, `wasteStock`, `transferStock`: compute `const scope = requireScopeOf(m);` and then
  - `String(product.eventId) !== String(eventId)` → `!belongsToScope(product, scope)`
  - `String(destination.eventId) !== String(eventId)` → `!belongsToScope(destination, scope)`
  - `'product does not belong to this event'` → `` `product does not belong to ${ownerWord(scope)}` `` (same for any other "…this event" copy in these handlers)
  - the `eventId,` / `eventId:` owner passed to `StockCountService.recordCount`, `StockService.applyMovement`, `StockTransferService.transfer` → `...scopeIds(scope),`
- `listTransactions` is merchantId-scoped and needs no change.

`git grep -n "eventId" -- src/controllers/merchant.controller.ts` afterwards: only the three `eventTill` uses and the event-only code inside `charge` / `tables` / `handOutTable`.

- [ ] **Step 5: Run new + existing till suites — expect PASS**

Run: `npx jest src/routes/__tests__/venueTill.route.test.ts src/routes/__tests__/merchantCharge.route.test.ts src/routes/__tests__/merchantChargeItems.route.test.ts src/routes/__tests__/merchantRevocation.route.test.ts src/routes/__tests__/merchantStockAccess.route.test.ts src/routes/__tests__/merchantStockScoping.route.test.ts src/routes/__tests__/merchantStockWrite.route.test.ts src/routes/__tests__/merchantTransactions.route.test.ts src/routes/__tests__/operatorLoginRegisterRole.route.test.ts --runInBand`
Plus any test whose name contains `posCatalog` or `merchantAuth` (`git ls-files src | grep -iE "posCatalog|merchantAuth" | grep test`).
Expected: all pass; existing suites unchanged. `npx tsc --noEmit -p .` clean.

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/merchant.interface.ts src/services/merchantAuth.service.ts src/middleware/merchantAuth.middleware.ts src/controllers/merchant.controller.ts src/services/posCatalog.service.ts src/routes/__tests__/venueTill.route.test.ts
git commit -m "feat(venue): venue tills sign in, count and receive stock; tag charges and tables refused"
```

---

## Task 7: Dashboard — scope-aware stock client and panels (events unchanged)

**Files (in `dashboard-venue-wt`):**
- Create: `src/lib/stockScope.ts` + `src/lib/__tests__/stockScope.test.ts`
- Modify: `src/lib/money.ts` (add `fmtCents`; `fmtR` delegates to it)
- Modify: `src/lib/api.ts` (`merchants`, `merchantOperators`, `stock` blocks; stock-report + product-image methods move from `events` into `stock`; `MerchantDetail` type)
- Modify: `src/components/cashless/EventCataloguePanel.tsx`, `src/components/cashless/EventStallsPanel.tsx`, `src/components/cashless/ProductStockDialog.tsx`, `src/components/EventStockReport.tsx`, `src/components/StallOperatorsPanel.tsx`, `src/components/EventMenuTab.tsx`, `src/pages/StallDetailPage.tsx`, and every place that renders those components with `eventId=` (find them with `git grep -nE "<(EventCataloguePanel|EventStallsPanel|EventStockReport|ProductStockDialog|StallOperatorsPanel)" -- src`)
- Modify (mechanical only): the existing tests that render these components or mock the moved client methods
- Test: `src/components/__tests__/EventStockReportVenueRange.test.tsx`, `src/components/__tests__/EventStallsPanelVenue.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–5 API routes.
- Produces:
  - `type StockScope = { kind: 'event'; eventId: string } | { kind: 'venue' }`; `stockBase(scope)`, `scopeKey(scope)`, `stallPath(scope, merchantId)`
  - `fmtCents(cents: number, currency: Currency): string`
  - `apiClient.merchants.{list(scope), create(scope, data), update(scope, id, data), transactions(scope, id, limit?)}`
  - `apiClient.merchantOperators.{list(scope, merchantId), create(scope, merchantId, data), update(scope, id, data), resetPin(scope, id)}`
  - `apiClient.stock.{listProducts(scope), createProduct(scope, data), updateProduct(scope, productId, data), receive(scope, data), getAllocations(scope), setAllocations(scope, data), transfer(scope, data), recordCount(scope, data), setThreshold(scope, data), board(scope), reconciliation(scope, range?), reconciliationPdf(scope, range?), dashboard(scope), movements(scope, params?), uploadProductImage(scope, file)}` where `range?: { from: string; to: string }` (ISO instants; venues only)
  - Components: `EventCataloguePanel({ scope, currency? })`, `EventStallsPanel({ scope })`, `ProductStockDialog({ scope, currency?, … })`, `EventStockReport({ scope, currency? })`, `StallOperatorsPanel({ scope, merchantId })`; `currency` defaults to `'ZAR'` (today's Rand display).
  - `MerchantDetail.event?` and `MerchantDetail.venue?` (exactly one present)

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/stockScope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stockBase, scopeKey, stallPath } from '@/lib/stockScope';
import { fmtCents, fmtR } from '@/lib/money';

describe('stockScope', () => {
  it('builds event and venue API bases', () => {
    expect(stockBase({ kind: 'event', eventId: 'e1' })).toBe('/tickets/events/e1');
    expect(stockBase({ kind: 'venue' })).toBe('/tickets/venue');
  });
  it('keys react-query caches per scope', () => {
    expect(scopeKey({ kind: 'event', eventId: 'e1' })).toBe('event:e1');
    expect(scopeKey({ kind: 'venue' })).toBe('venue');
  });
  it('routes a stall to its detail page', () => {
    expect(stallPath({ kind: 'event', eventId: 'e1' }, 'm1')).toBe('/events/e1/stalls/m1');
    expect(stallPath({ kind: 'venue' }, 'm1')).toBe('/venue/stalls/m1');
  });
});

describe('fmtCents', () => {
  it('formats in the given currency; fmtR stays Rand', () => {
    expect(fmtCents(1250, 'SZL')).toBe('E12.50');
    expect(fmtCents(1250, 'ZAR')).toBe('R12.50');
    expect(fmtR(1250)).toBe('R12.50');
  });
});
```

`src/components/__tests__/EventStallsPanelVenue.test.tsx` — modelled on the existing EventStallsPanel test setup (find it with `ls src/components/__tests__ | grep -i stall`; if none exists, model on `EventCataloguePanel.test.tsx`'s QueryClient + MemoryRouter + `vi.mock('@/lib/api')` setup):

```tsx
// @vitest-environment jsdom
// (imports + vi.mock('@/lib/api') with merchants: { list, create, update } mocks, QueryClientProvider + MemoryRouter render helper)
it('a venue lists its stalls, hides the commission field and creates without one', async () => {
  (apiClient.merchants.list as any).mockResolvedValue([{ _id: 'm1', name: 'Main Bar', commissionPercent: 0, status: 'active' }]);
  (apiClient.merchants.create as any).mockResolvedValue({ merchant: { _id: 'm2', name: 'Patio' } });
  renderPanel({ kind: 'venue' });
  expect(await screen.findByText('Main Bar')).toBeTruthy();
  expect(apiClient.merchants.list).toHaveBeenCalledWith({ kind: 'venue' });
  expect(screen.queryByText(/% commission/)).toBeNull();
  // open the add form exactly the way the existing stall test does, then:
  expect(screen.queryByLabelText('Commission %')).toBeNull();
  // fill the name 'Patio' and submit as the existing stall test does
  await waitFor(() => expect(apiClient.merchants.create).toHaveBeenCalledWith({ kind: 'venue' }, { name: 'Patio' }));
});
```
Write the open/fill/submit steps concretely by copying the selectors the panel actually renders (read `EventStallsPanel.tsx`); no comment lines may remain.

`src/components/__tests__/EventStockReportVenueRange.test.tsx` — modelled on `EventStockReportPdf.test.tsx`'s mocks, but mocking `apiClient.stock.{dashboard, reconciliation, reconciliationPdf, movements}`:

```tsx
it('a venue reconciliation defaults to today and refetches for a chosen day', async () => {
  // render <EventStockReport scope={{ kind: 'venue' }} currency="SZL" /> and open the Reconciliation view the way EventStockReportTabs.test.tsx does
  await waitFor(() => expect(apiClient.stock.reconciliation).toHaveBeenCalled());
  const [scopeArg, rangeArg] = (apiClient.stock.reconciliation as any).mock.calls[0];
  expect(scopeArg).toEqual({ kind: 'venue' });
  expect(rangeArg.to > rangeArg.from).toBe(true);
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } });
  await waitFor(() => expect(apiClient.stock.reconciliation).toHaveBeenLastCalledWith(
    { kind: 'venue' }, { from: '2026-10-01T00:00:00+02:00', to: '2026-10-02T00:00:00+02:00' },
  ));
});

it('an event reconciliation shows no date range and passes no range', async () => {
  // render with scope={{ kind: 'event', eventId: 'e1' }}, open Reconciliation
  await waitFor(() => expect(apiClient.stock.reconciliation).toHaveBeenCalledWith({ kind: 'event', eventId: 'e1' }, undefined));
  expect(screen.queryByLabelText('From')).toBeNull();
});
```
Write the render/open steps concretely from the sibling test; no comment lines may remain.

- [ ] **Step 2: Run them — expect FAIL**

Run: `cd ~/Documents/omevision/contracts/carrot-tickets/dashboard-venue-wt && npx vitest run src/lib/__tests__/stockScope.test.ts src/components/__tests__/EventStallsPanelVenue.test.tsx src/components/__tests__/EventStockReportVenueRange.test.tsx`
Expected: FAIL — `@/lib/stockScope` missing; `fmtCents` missing; panels take `eventId`.

- [ ] **Step 3: `stockScope` + `fmtCents`**

`src/lib/stockScope.ts`:

```ts
/**
 * Who a stall/stock screen is for: one event, or the signed-in vendor's own
 * venue (venue trading). A venue needs no id — the API resolves it from the
 * session, so another venue can never be addressed.
 */
export type StockScope = { kind: 'event'; eventId: string } | { kind: 'venue' };

/** API prefix for scope-owned stock routes: `/tickets/events/:id` or `/tickets/venue`. */
export function stockBase(scope: StockScope): string {
  return scope.kind === 'event' ? `/tickets/events/${scope.eventId}` : '/tickets/venue';
}

/** A stable react-query key segment for the scope. */
export function scopeKey(scope: StockScope): string {
  return scope.kind === 'event' ? `event:${scope.eventId}` : 'venue';
}

/** Where a stall's detail page lives for this scope. */
export function stallPath(scope: StockScope, merchantId: string): string {
  return scope.kind === 'event' ? `/events/${scope.eventId}/stalls/${merchantId}` : `/venue/stalls/${merchantId}`;
}
```

`src/lib/money.ts` — replace `fmtR`'s body so the currency-aware formatter is the one definition:

```ts
import { currencySymbol, type Currency } from '@/lib/currency';

/** Integer cents with the currency's symbol: "E12.50" / "R12.50". */
export function fmtCents(cents: number, currency: Currency): string {
  return `${currencySymbol(currency)}${((cents ?? 0) / 100).toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Rand display — the cashless panels' long-standing default. */
export function fmtR(cents: number): string {
  return fmtCents(cents, 'ZAR');
}
```
(keep `fmtR`'s existing doc comment; check `src/lib/currency.ts` does not import `src/lib/money.ts`, to avoid a cycle).

- [ ] **Step 4: The client**

In `src/lib/api.ts`, import `{ stockBase, type StockScope }` from `@/lib/stockScope`. Then:

(a) Replace the whole `merchants = { … };` block with:

```ts
  merchants = {
    /** The stalls in one scope (event: ?eventId=; venue: the vendor's own). */
    list: async (scope: StockScope): Promise<MerchantRow[]> =>
      this.request<MerchantRow[]>(
        scope.kind === 'event' ? `/tickets/merchants?eventId=${scope.eventId}` : `/tickets/venue/stalls`,
      ),

    /** A venue stall never carries a commission — the API stores 0 regardless. */
    create: async (
      scope: StockScope,
      data: { name: string; commissionPercent?: number },
    ): Promise<{ merchant: MerchantRow }> =>
      this.request<{ merchant: MerchantRow }>(
        scope.kind === 'event' ? `/tickets/merchants` : `/tickets/venue/stalls`,
        {
          method: 'POST',
          body: JSON.stringify(scope.kind === 'event' ? { eventId: scope.eventId, ...data } : data),
        },
      ),

    update: async (
      scope: StockScope,
      id: string,
      data: { name?: string; commissionPercent?: number; isActive?: boolean },
    ): Promise<MerchantRow> =>
      this.request<MerchantRow>(
        scope.kind === 'event' ? `/tickets/merchants/${id}` : `/tickets/venue/stalls/${id}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      ),

    transactions: async (scope: StockScope, id: string, limit = 100): Promise<MerchantDetail> =>
      this.request<MerchantDetail>(
        `${scope.kind === 'event' ? `/tickets/merchants/${id}` : `/tickets/venue/stalls/${id}`}/transactions?limit=${limit}`,
      ),
  };
```

(b) Replace the whole `merchantOperators = { … };` block (keep its comment) with the same four methods taking `scope` first: event paths exactly as today; venue paths `/tickets/venue/stalls/${merchantId}/operators` (list, create), `/tickets/venue/operators/${id}` (update), `/tickets/venue/operators/${id}/reset-pin` (resetPin). Same bodies and return types as today.

(c) Replace the whole `stock = { … };` block (keep its comment, adding "— for ONE event or the vendor's venue") with methods taking `scope: StockScope` first, built on `stockBase(scope)`:
- `listProducts(scope)` → GET `${stockBase(scope)}/products`; `createProduct(scope, data)` → POST same.
- `updateProduct(scope, productId, data)` → PATCH `scope.kind === 'event' ? /tickets/products/${productId} : /tickets/venue/products/${productId}`.
- `receive`, `getAllocations`, `setAllocations`, `transfer`, `recordCount`, `setThreshold` → `${stockBase(scope)}/stock/<same suffix as today>` with today's methods, bodies and return types.
- Moved here from `events` (delete them there): 
  ```ts
    board: async (scope: StockScope): Promise<StockBoard> =>
      this.request<StockBoard>(`${stockBase(scope)}/stock/board`),

    /** A venue may pass a range (ISO instants); an event reconciles from its doors and ignores it. */
    reconciliation: async (scope: StockScope, range?: { from: string; to: string }): Promise<StockReconciliation> =>
      this.request<StockReconciliation>(`${stockBase(scope)}/stock/reconciliation${rangeQuery(scope, range)}`),

    /** The same reconciliation as a printable PDF — bytes, so it goes via `fetchPdf`. */
    reconciliationPdf: async (scope: StockScope, range?: { from: string; to: string }): Promise<Blob> =>
      this.fetchPdf(`${stockBase(scope)}/stock/reconciliation.pdf${rangeQuery(scope, range)}`, { method: 'GET' }),

    dashboard: async (scope: StockScope): Promise<StockDashboard> =>
      this.request<StockDashboard>(`${stockBase(scope)}/stock/dashboard`),

    movements: async (
      scope: StockScope,
      params: { productId?: string; merchantId?: string; cursor?: string; limit?: number } = {},
    ): Promise<StockMovementsPage> => {
      // body of today's getEventStockMovements, with `/tickets/events/${id}` → `${stockBase(scope)}`
    },

    uploadProductImage: async (scope: StockScope, file: File): Promise<string> => {
      // body of today's events.uploadProductImage, with the fetch URL
      // `${this.baseUrl}${scope.kind === 'event' ? `/media/events/${scope.eventId}/product` : '/media/venue/product'}`
    },
  ```
  Write the two bodies out in full from today's methods (the comments above say exactly what changes; do not leave them as comments).
- Add near the other module-level helpers in `api.ts`:
  ```ts
  /** `?from=&to=` for a venue range; empty for an event or no range. */
  function rangeQuery(scope: StockScope, range?: { from: string; to: string }): string {
    if (scope.kind !== 'venue' || !range) return '';
    return `?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`;
  }
  ```
- Delete `events.getEventStockBoard`, `getEventStockReconciliation`, `getEventStockReconciliationPdf`, `getEventStockDashboard`, `getEventStockMovements` and `events.uploadProductImage` (DRY — no aliases). `uploadMenuItemImage` stays.

(d) `MerchantDetail`: `event: { id: string; name: string };` → 
```ts
  /** Exactly one: the stall's event, or its venue. */
  event?: { id: string; name: string };
  venue?: { id: string; name: string };
```

- [ ] **Step 5: The components**

Apply these exact transformations:

`EventCataloguePanel.tsx` — signature `export function EventCataloguePanel({ scope, currency = 'ZAR' }: { scope: StockScope; currency?: Currency })`; then
- every query key `[…, eventId]` → `[…, scopeKey(scope)]` (`'stock-products'`, `'merchants'`, `'event-stock-allocations'`, `'stock-board'` — including the `invalidateQueries` calls);
- delete every `enabled: !!eventId` line (the scope is always set);
- `apiClient.stock.<fn>(eventId, …)` → `apiClient.stock.<fn>(scope, …)`; `apiClient.stock.updateProduct(id, …)` → `apiClient.stock.updateProduct(scope, id, …)`;
- `apiClient.merchants.list(eventId)` → `apiClient.merchants.list(scope)`;
- `apiClient.events.getEventStockBoard(eventId)` → `apiClient.stock.board(scope)`;
- `apiClient.events.uploadProductImage(eventId, file)` → `apiClient.stock.uploadProductImage(scope, file)`;
- `<EventStockReport eventId={eventId} />` → `<EventStockReport scope={scope} currency={currency} />`; `<ProductStockDialog eventId={eventId}` → `<ProductStockDialog scope={scope} currency={currency}`;
- `fmtR(x)` → `fmtCents(x, currency)`;
- update the doc comment that says the panel "takes the event it lives under" to "takes the scope (event or venue) it lives under".
`git grep -n "eventId" -- src/components/cashless/EventCataloguePanel.tsx` must be empty afterwards.

`EventStallsPanel.tsx` — `({ scope }: { scope: StockScope })`; query key `['merchants', scopeKey(scope)]`; `merchants.list(scope)`; create → `apiClient.merchants.create(scope, scope.kind === 'event' ? { name, commissionPercent: Number(form.commissionPercent) || 0 } : { name })`; update calls → `merchants.update(scope, id, …)`; card navigation → `navigate(stallPath(scope, v._id))`; render the Commission % field, the "% commission" line and the "each with a commission cut" sentence only when `scope.kind === 'event'`.

`ProductStockDialog.tsx` — props `scope: StockScope; currency?: Currency` (default `'ZAR'`) replacing `eventId`; key `['stock-movements', scopeKey(scope), product?._id]`; `apiClient.stock.movements(scope, { productId: product!._id, limit: 50 })`; `fmtR` → `fmtCents(…, currency)`.

`EventStockReport.tsx` — `export function EventStockReport({ scope, currency = 'ZAR' }: { scope: StockScope; currency?: Currency })`; pass `scope` + `currency` to `DashboardSection`, `ReconciliationSection`, `MovementsSection`; keys `[…, scopeKey(scope)]`; calls `apiClient.stock.dashboard(scope)`, `.reconciliation(scope, range)`, `.reconciliationPdf(scope, range)`, `.movements(scope, …)`; `fmtR` → `fmtCents(…, currency)`. In `ReconciliationSection`, for `scope.kind === 'venue'` only, add the range picker above the table:

```tsx
  // Venue reports are by day (Eswatini, UTC+2): an inclusive From–To date pair.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Mbabane' });
  const [fromDay, setFromDay] = useState(today);
  const [toDay, setToDay] = useState(today);
  const range = scope.kind === 'venue' ? dayRange(fromDay, toDay) : undefined;
  // query key: ['event-stock-recon', scopeKey(scope), range?.from, range?.to]
```
```tsx
      {scope.kind === 'venue' && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="recon-from">From</Label>
            <Input id="recon-from" type="date" value={fromDay} max={toDay} onChange={(e) => setFromDay(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="recon-to">To</Label>
            <Input id="recon-to" type="date" value={toDay} min={fromDay} onChange={(e) => setToDay(e.target.value)} />
          </div>
        </div>
      )}
```
with, at module level:
```ts
/** Inclusive local days → the API's [from, to) instants (Eswatini is UTC+2, no DST). */
function dayRange(fromDay: string, toDay: string): { from: string; to: string } {
  const next = new Date(`${toDay}T00:00:00+02:00`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toLocaleDateString('en-CA', { timeZone: 'Africa/Mbabane' });
  return { from: `${fromDay}T00:00:00+02:00`, to: `${nextDay}T00:00:00+02:00` };
}
```
(import `Input`/`Label` from `@/components/ui/*` if the file does not already). The PDF button passes the same `range`.

`StallOperatorsPanel.tsx` — add a `scope: StockScope` prop; every `apiClient.merchantOperators.<fn>(…)` call gets `scope` as its first argument.

`EventMenuTab.tsx` (event-only) — `apiClient.merchants.list(eventId)` → `apiClient.merchants.list({ kind: 'event', eventId })`; `apiClient.stock.listProducts(eventId)` → `apiClient.stock.listProducts({ kind: 'event', eventId })`; and its `['merchants', eventId]` / `['stock-products', eventId]` keys → `['merchants', scopeKey({ kind: 'event', eventId })]` / `['stock-products', scopeKey({ kind: 'event', eventId })]` so it shares the catalogue panel's cache entries.

`StallDetailPage.tsx` — derive the scope from the route (the venue route arrives in Task 8): `const { id = '', merchantId = '' } = useParams(); const scope: StockScope = id ? { kind: 'event', eventId: id } : { kind: 'venue' };`; `merchants.transactions(scope, merchantId)`; `<StallOperatorsPanel scope={scope} merchantId={…} />`; back button → `navigate(scope.kind === 'event' ? \`/events/${id}?tab=cashless&sub=stalls\` : '/venue?tab=stalls')`; the header name `data.event?.name ?? data.venue?.name`.

Every other render site found by the `git grep` in **Files** → `scope={{ kind: 'event', eventId }}` in place of `eventId={eventId}`.

- [ ] **Step 6: Mechanical edits to existing tests**

In existing test files, ONLY these edits are allowed:
- `<Component eventId="X" …>` → `<Component scope={{ kind: 'event', eventId: 'X' }} …>` for the five components above.
- Mocks `events: { getEventStockBoard, getEventStockReconciliation, getEventStockReconciliationPdf, getEventStockDashboard, getEventStockMovements, uploadProductImage }` → the same mock functions under `stock: { board, reconciliation, reconciliationPdf, dashboard, movements, uploadProductImage }` (merge into an existing `stock` mock object where the file has one).
- Call expectations on these client methods: a leading `'X'` id argument → `{ kind: 'event', eventId: 'X' }`; a reconciliation/PDF call gains a trailing `undefined` range argument; `updateProduct('p', …)` → `updateProduct({ kind: 'event', eventId: 'X' }, 'p', …)`; `merchants.create({ eventId: 'X', ...rest })` → `merchants.create({ kind: 'event', eventId: 'X' }, { ...rest })`; `merchants.update('id', data)` / `merchants.transactions('id', …)` / `merchantOperators.<fn>(…)` → the same call with `{ kind: 'event', eventId: 'X' }` prepended.
- Test titles/comments that name a moved method may be renamed to match.
No other assertion may change.

- [ ] **Step 7: Run the whole dashboard suite + typecheck — expect PASS**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.app.json`
Expected: every file passes (3 new test files included), tsc clean. `git grep -n "getEventStock\|events.uploadProductImage" -- src` returns nothing.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "feat(venue): scope-aware stock client and panels (event behaviour unchanged)"
```

---

## Task 8: Dashboard — Venue page tabs + venue stall detail route

**Files (in `dashboard-venue-wt`):**
- Modify: `src/pages/VenuePage.tsx`, `src/App.tsx`
- Test: `src/pages/__tests__/VenuePageTabs.test.tsx`, `src/pages/__tests__/StallDetailPageVenue.test.tsx`

**Interfaces:**
- Consumes: Task 7 components with `scope` + `currency`; Phase 1 `useMyVenue`, `canManageVenue`; `hasPermission` + `TicketsPermission.MANAGE_STOCK`.
- Produces: `/venue?tab=stalls|catalogue` (default `stalls`) and `/venue/stalls/:merchantId`.

- [ ] **Step 1: Write the failing tests**

`src/pages/__tests__/VenuePageTabs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthUser } from '@/types';

let currentUser: AuthUser | null = { _id: 'v1' } as AuthUser;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: currentUser }) }));
vi.mock('@/lib/api', () => ({ apiClient: { venue: { mine: vi.fn() } } }));
vi.mock('@/components/cashless/EventStallsPanel', () => ({
  EventStallsPanel: (p: { scope: unknown }) => <div>stalls-panel {JSON.stringify(p.scope)}</div>,
}));
vi.mock('@/components/cashless/EventCataloguePanel', () => ({
  EventCataloguePanel: (p: { scope: unknown; currency?: string }) => <div>catalogue-panel {JSON.stringify(p.scope)} {p.currency}</div>,
}));

import { apiClient } from '@/lib/api';
import { VenuePage } from '@/pages/VenuePage';

const ACTIVE = { eligible: true, venue: { id: 'ven1', name: 'Kwa-Linda Lounge', currency: 'SZL', status: 'active', activatedAt: '2026-10-01T08:00:00.000Z' } };

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[url]}><VenuePage /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { vi.clearAllMocks(); currentUser = { _id: 'v1' } as AuthUser; });
afterEach(cleanup);

describe('VenuePage — trading tabs', () => {
  it('an active venue opens on Stalls, scoped to the venue', async () => {
    (apiClient.venue.mine as any).mockResolvedValue(ACTIVE);
    renderAt('/venue');
    expect(await screen.findByText('stalls-panel {"kind":"venue"}')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Stalls' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Catalogue & stock' })).toBeTruthy();
  });

  it('?tab=catalogue shows the catalogue in the venue currency', async () => {
    (apiClient.venue.mine as any).mockResolvedValue(ACTIVE);
    renderAt('/venue?tab=catalogue');
    expect(await screen.findByText('catalogue-panel {"kind":"venue"} SZL')).toBeTruthy();
  });

  it('a suspended or not-yet-on venue shows no trading tabs', async () => {
    (apiClient.venue.mine as any).mockResolvedValue({ eligible: true, venue: null });
    renderAt('/venue');
    expect(await screen.findByText("Venue trading isn't on yet")).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Stalls' })).toBeNull();
  });

  it('a team member without tickets:manage_stock sees Stalls but not Catalogue', async () => {
    currentUser = { permissions: ['tickets:manage_venue'] } as unknown as AuthUser;
    (apiClient.venue.mine as any).mockResolvedValue(ACTIVE);
    renderAt('/venue');
    expect(await screen.findByRole('tab', { name: 'Stalls' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Catalogue & stock' })).toBeNull();
  });
});
```
(Stalls needs `tickets:manage_venue`, Catalogue needs `tickets:manage_stock`; the page itself already requires `manage_venue` — Phase 1 — so there is no Catalogue-only view to test.)

`src/pages/__tests__/StallDetailPageVenue.test.tsx` — modelled on the existing StallDetailPage test if one exists (`ls src/pages/__tests__ | grep -i stall`), else on `VenuePage.test.tsx`'s setup, with `apiClient.merchants.transactions` and `apiClient.merchantOperators.list` mocked:

```tsx
it('the venue stall route loads the stall through the venue scope and returns to the venue', async () => {
  (apiClient.merchants.transactions as any).mockResolvedValue({
    merchant: { _id: 'm1', name: 'Main Bar', commissionPercent: 0, status: 'active' },
    venue: { id: 'ven1', name: 'Kwa-Linda Lounge' },
    transactions: [], summary: { totalCharged: 0, totalNet: 0, totalFee: 0, count: 0 },
  });
  (apiClient.merchantOperators.list as any).mockResolvedValue({ operators: [] });
  // render <Routes><Route path="/venue/stalls/:merchantId" element={<StallDetailPage />} /><Route path="/venue" element={<div>venue-home</div>} /></Routes> at '/venue/stalls/m1'
  expect(await screen.findByText('Main Bar')).toBeTruthy();
  expect(apiClient.merchants.transactions).toHaveBeenCalledWith({ kind: 'venue' }, 'm1');
  expect(apiClient.merchantOperators.list).toHaveBeenCalledWith({ kind: 'venue' }, 'm1');
  // click the page's back control (find it by the label the page renders) and assert venue-home is shown
});
```
Write the render and back-click steps concretely; no comment lines may remain.

- [ ] **Step 2: Run them — expect FAIL**

Run: `npx vitest run src/pages/__tests__/VenuePageTabs.test.tsx src/pages/__tests__/StallDetailPageVenue.test.tsx`
Expected: FAIL — no tabs; no `/venue/stalls/:merchantId` handling.

- [ ] **Step 3: The tabs**

In `src/pages/VenuePage.tsx`, inside the ACTIVE branch, render the existing details card and then:

```tsx
      <VenueTradingTabs currency={v.currency} />
```
and add to the file:

```tsx
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EventStallsPanel } from '@/components/cashless/EventStallsPanel';
import { EventCataloguePanel } from '@/components/cashless/EventCataloguePanel';
import { hasPermission, TicketsPermission } from '@/lib/permissions';
import type { Currency } from '@/lib/currency';

const VENUE: { kind: 'venue' } = { kind: 'venue' };

/**
 * The venue's day-to-day trading: its stalls (with each stall's till staff on
 * the stall page) and its catalogue + stock — the same panels an event uses,
 * scoped to the venue. Tab in ?tab= so a refresh or shared link keeps it.
 */
function VenueTradingTabs({ currency }: { currency: Currency }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const showStalls = canManageVenue(user);
  const showCatalogue = hasPermission(user, TicketsPermission.MANAGE_STOCK);
  const fallback = showStalls ? 'stalls' : 'catalogue';
  const requested = params.get('tab');
  const tab = requested === 'catalogue' && showCatalogue ? 'catalogue'
    : requested === 'stalls' && showStalls ? 'stalls' : fallback;
  return (
    <Tabs value={tab} onValueChange={(t) => setParams({ tab: t })} className="space-y-4">
      <TabsList>
        {showStalls && <TabsTrigger value="stalls">Stalls</TabsTrigger>}
        {showCatalogue && <TabsTrigger value="catalogue">Catalogue &amp; stock</TabsTrigger>}
      </TabsList>
      {showStalls && <TabsContent value="stalls"><EventStallsPanel scope={VENUE} /></TabsContent>}
      {showCatalogue && <TabsContent value="catalogue"><EventCataloguePanel scope={VENUE} currency={currency} /></TabsContent>}
    </Tabs>
  );
}
```
(`useAuth` and `canManageVenue` are already imported by VenuePage.)

- [ ] **Step 4: The route**

In `src/App.tsx`, next to `<Route path="venue" element={<VenuePage />} />`, add:

```tsx
                  <Route path="venue/stalls/:merchantId" element={<StallDetailPage />} />
```
(StallDetailPage already derives `{ kind: 'venue' }` when there is no `:id` — Task 7.)

- [ ] **Step 5: Run the dashboard suite + typecheck + build — expect PASS**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.app.json && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/pages/VenuePage.tsx src/App.tsx src/pages/__tests__/VenuePageTabs.test.tsx src/pages/__tests__/StallDetailPageVenue.test.tsx
git commit -m "feat(venue): Stalls and Catalogue & stock tabs on the Venue page + venue stall detail"
```

---

## Task 9: POS — a venue till opens on its Stock page

**Files (in `pos-venue-wt`, created per the worktree table):**
- Modify: `lib/api.dart` (`MerchantOperator`)
- Create: `lib/pages/cashless/till_header.dart` (the header + sign-out, extracted from ChargePage)
- Modify: `lib/pages/charge_page.dart` (use the shared header)
- Modify: `lib/pages/merchant_shell.dart`
- Test: `test/merchant_operator_venue_test.dart`, `test/merchant_shell_venue_test.dart`

**Interfaces:**
- Consumes: Task 6 login response (`operator.venueId`, `operator.venueName`).
- Produces: `MerchantOperator.venueId`, `.venueName`, `bool get isVenue`, `String? get ownerName`; `TillHeader({required VoidCallback? onSignOut})`; `Future<void> signOutToLogin(BuildContext context)`.

Rules: never `flutter run`, never build an APK. Only `flutter analyze` and `flutter test <files>`.

- [ ] **Step 1: Write the failing tests**

`test/merchant_operator_venue_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:carrot_tickets_pos/api.dart';

void main() {
  test('a venue till session carries the venue, not an event', () {
    final op = MerchantOperator.fromJson({
      'merchantId': 'm1', 'name': 'Main Bar', 'operatorName': 'Nomsa',
      'venueId': 'v1', 'venueName': 'Kwa-Linda Lounge',
    });
    expect(op.isVenue, isTrue);
    expect(op.venueId, 'v1');
    expect(op.ownerName, 'Kwa-Linda Lounge');
    final round = MerchantOperator.fromJson(op.toJson());
    expect(round.isVenue, isTrue);
    expect(round.venueName, 'Kwa-Linda Lounge');
  });

  test('an event till session is unchanged', () {
    final op = MerchantOperator.fromJson({
      'merchantId': 'm1', 'name': 'Main Bar', 'eventId': 'e1', 'eventName': 'Bushfire',
    });
    expect(op.isVenue, isFalse);
    expect(op.eventId, 'e1');
    expect(op.ownerName, 'Bushfire');
  });
}
```

`test/merchant_shell_venue_test.dart` — set the session the way the existing merchant tests do (read `test/merchant_shell_hardware_scan_test.dart` / `test/session_routing_test.dart` for how `Session.merchantOperator` and the token are seeded), then:

```dart
// imports as merchant_shell_hardware_scan_test.dart
final _requested = <String>[];

Future<http.Response> _backend(http.Request req) async {
  _requested.add(req.url.path);
  if (req.url.path.endsWith('/merchant/stock')) {
    return _ok({'stock': [
      {'productId': 'p1', 'name': 'Castle Lite', 'price': 2500, 'onHand': 10, 'status': 'in_stock'},
    ]});
  }
  return http.Response('{"success":false,"message":"unrouted"}', 404, headers: {'content-type': 'application/json'});
}

void main() {
  testWidgets('a venue till shows its stock with the venue header and no bottom nav', (tester) async {
    Session.merchantOperator = MerchantOperator(
      merchantId: 'm1', name: 'Main Bar', eventId: '', operatorName: 'Nomsa',
      venueId: 'v1', venueName: 'Kwa-Linda Lounge',
    );
    await http.runWithClient(() async {
      await tester.pumpWidget(const MaterialApp(home: MerchantShell()));
      await tester.pumpAndSettle();
      expect(find.byType(NavigationBar), findsNothing);
      expect(find.text('Main Bar'), findsOneWidget);
      expect(find.text('Kwa-Linda Lounge'), findsOneWidget);
      expect(find.text('Castle Lite'), findsOneWidget);
      expect(find.byTooltip('Sign out'), findsOneWidget);
      expect(_requested.any((p) => p.endsWith('/merchant/tables')), isFalse,
          reason: 'a venue till must not poll table service it cannot use');
    }, () => MockClient(_backend));
  });
}
```
(Complete the `_ok` helper and imports exactly as in the sibling test.)

- [ ] **Step 2: Run them — expect FAIL**

Run: `cd ~/Documents/omevision/contracts/carrot-tickets/pos-venue-wt && flutter test test/merchant_operator_venue_test.dart test/merchant_shell_venue_test.dart`
Expected: FAIL — `venueId` / `isVenue` do not exist.

- [ ] **Step 3: `MerchantOperator`**

In `lib/api.dart`, extend the class (keep its doc comment, adding: "[venueId]/[venueName] mark a VENUE till (venue trading): such a session has no event, and [eventId] is empty."):

```dart
  final String? venueId;
  final String? venueName;

  /// A venue till (no event): it counts and moves stock; tag charges and
  /// table service are refused by the API.
  bool get isVenue => (venueId ?? '').isNotEmpty;

  /// The event or venue name for headers; null when the session lacks it.
  String? get ownerName => isVenue ? venueName : eventName;
```
— add both to the constructor (`this.venueId, this.venueName`), to `fromJson` (trimmed, empty → null, the same way `eventName` is parsed) and to `toJson` (`'venueId': venueId, 'venueName': venueName`).

- [ ] **Step 4: Extract the till header**

Create `lib/pages/cashless/till_header.dart` holding the header ChargePage builds today (stall name, owner line, operator line, sign-out button) as `class TillHeader extends StatelessWidget { const TillHeader({super.key, required this.onSignOut}); final VoidCallback? onSignOut; … }`, reading `Session.merchantOperator`, with ONE change: the owner line shows `merchant.ownerName` with `Icons.storefront_outlined` for a venue and `Icons.event_outlined` for an event. Move the existing comments with the code. Add:

```dart
/// Clears the till session and returns to the login screen.
Future<void> signOutToLogin(BuildContext context) async {
  await Session.clear();
  if (!context.mounted) return;
  Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const LoginPage()));
}
```

In `lib/pages/charge_page.dart`: `_header()` returns `TillHeader(onSignOut: _busy ? null : _signOut)`; `_signOut` keeps its `TagReader.cancel()` line and then calls `await signOutToLogin(context);` in place of its own `Session.clear()` + navigation. Existing ChargePage tests must pass unchanged.

- [ ] **Step 5: The venue shell**

In `lib/pages/merchant_shell.dart`:
- Add `bool get _isVenue => Session.merchantOperator?.isVenue ?? false;`.
- `initState`: `if (!_isVenue) _pending.start();` (a venue till must not poll tables it cannot use).
- At the top of `build`:

```dart
    // A venue till (venue trading Phase 2) only counts and moves stock: tag
    // charges and table service are event features the API refuses for it. A
    // NavigationBar needs two destinations, so the Stock page stands alone,
    // under the same till header (and sign-out) the Charge tab uses.
    if (_isVenue) {
      return Scaffold(
        backgroundColor: CashlessColors.cream,
        body: SafeArea(
          child: Column(
            children: [
              TillHeader(onSignOut: () => signOutToLogin(context)),
              const Expanded(child: MerchantStockPage()),
            ],
          ),
        ),
      );
    }
```

- [ ] **Step 6: Analyze + run the POS tests — expect PASS**

Run: `flutter analyze && flutter test`
Expected: analyze reports no new issues versus `origin/main` (compare counts if the base already has some); every test passes, including the two new files and the existing merchant shell / charge page tests.

- [ ] **Step 7: Commit**

```bash
git add lib/api.dart lib/pages/cashless/till_header.dart lib/pages/charge_page.dart lib/pages/merchant_shell.dart test/merchant_operator_venue_test.dart test/merchant_shell_venue_test.dart
git commit -m "feat(venue): a venue till opens on its Stock page under the shared till header"
```

---

## Task 10: Whole-phase verification

No new code. Read every count.

- [ ] **Step 1: API** — `cd api-venue-wt`:
```bash
npx jest src/utils/__tests__ src/models/__tests__ src/scripts/__tests__/migrate-product-barcode-index.test.ts src/services/__tests__/stock.service.test.ts src/services/__tests__/stockCount.service.test.ts src/services/__tests__/stockTransfer.service.test.ts src/services/__tests__/stockAlert.service.test.ts src/services/__tests__/stockLedger.property.test.ts src/services/__tests__/stockReport.board.test.ts src/services/__tests__/stockReport.dashboard.test.ts src/services/__tests__/stockReport.movements.test.ts src/services/__tests__/stockReport.reconciliation.test.ts src/services/__tests__/stockReport.venue.test.ts src/services/__tests__/stockReconciliationPdf.service.test.ts src/routes/__tests__/venue src/routes/__tests__/stockAdmin.route.test.ts src/routes/__tests__/stockReport src/routes/__tests__/merchant src/routes/__tests__/operatorLoginRegisterRole.route.test.ts src/routes/__tests__/mediaItemImage.route.test.ts src/routes/__tests__/adminVenues.route.test.ts --runInBand
npx tsc --noEmit -p .
```
- [ ] **Step 2: Dashboard** — `cd dashboard-venue-wt && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && npm run build`
- [ ] **Step 3: POS** — `cd pos-venue-wt && flutter analyze && flutter test`
- [ ] **Step 4: Report, do not deploy.** Report branches, commits and counts. Deploy order when approved: run `src/scripts/migrate-product-barcode-index.ts` against dev then prod (order-independent, but before venues add barcoded products); API (dev: `gcloud run deploy carrot-tickets-api-dev --source .` from a clean `origin/dev` checkout; prod: trigger `carrot-tickets-api-main-deploy`) and wait for 100% traffic; then the dashboard; the POS needs a new APK build, made only on request.
