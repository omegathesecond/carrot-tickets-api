# Venue Trading Phase 3A — Selling API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a venue sell: waiters open tables, send rounds to the bar, take cash/card payments with tips and splits; tills hand out rounds and take counter sales; the dashboard reads every payment and table — all through the API.

**Architecture:** `Waiter`, `Table` and `MerchantCharge` join the event-or-venue ownership Phase 2 introduced; a new `VenuePayment` records money taken. Event code paths are left as they are — venue behaviour lives in new services (`VenueTableService`, `VenueSaleService`, `VenuePaymentService`) and new controllers, and each existing staff route picks its handler by the token's kind (`byWaiterKind`), so an event waiter never reaches venue code and a venue waiter never reaches event code. A round, a payment and a counter sale are each ONE MongoDB transaction and each replays on a retried `clientTxnId`.

**Tech Stack:** Express 4.21, Mongoose 7.8, Joi, Jest + supertest + mongodb-memory-server (replica set for anything that moves stock or money).

**Spec:** `docs/superpowers/specs/2026-10-01-venue-trading-design.md` — section "Phase 3 — Selling" including "Dashboard — Transactions and Waiters", plus "Decisions taken" and "Failure modes".

This is plan **3A (API)** of Phase 3. Plans **3B (dashboard)** and **3C (POS)** are written after this one is built, against the real endpoints. Work in `/Users/lasliegeorgesjr/Documents/omevision/contracts/carrot-tickets/api-venue-wt` (branch `feat/venue-trading`).

## Global Constraints

- **Owners.** Every `Table`, `MerchantCharge` and `VenuePayment` has EXACTLY ONE owner: `Table` / `MerchantCharge` exactly one of `eventId` / `venueId` (message `exactly one of eventId or venueId is required`); `VenuePayment` always a `venueId`. A `Waiter` with `scope: 'organizer'` has exactly one of `eventId` / `venueId`; a `scope: 'platform'` waiter has neither.
- **Events do not change.** Existing event URLs, permissions, response shapes, copy and behaviour stay as they are. Every existing waiter / table / handover / charge / report / till test passes with NO edits except the mechanical ones a task lists: Task 5 (`TableService.list(` call shape, `PosCatalogService.forEvent` → `forScope`), Task 7 (`venueTill.route.test.ts` tables refusal copy), Task 9 (`StockAlertService.evaluateAfterSale` argument). Never an assertion change beyond those.
- **Money.** Integer minor units everywhere. A venue charge has `fee: 0` and `netAmount === amount`. Tips are stored per tender and are NEVER part of `applied`, a charge, or a sales total.
- **Where venue routes live.** Dashboard: `/api/tickets/venue/*` (no venue id in the URL — the venue is the logged-in vendor's). Waiter app: `/api/waiter/*`. Till: `/api/merchant/*`. Staff routes take the venue from the TOKEN, never from the URL or body.
- **Isolation.** A table, waiter, payment, stall or product of another venue, or of an event, addressed by id → **404** (dashboard) or the handler's "not found" answer — never a leak, never a write.
- **Suspended venue.** Staff sign-in and every staff request → **401** `Venue trading is suspended`. Dashboard routes → **403** `Venue trading is suspended` (existing `venueScope`).
- **Kind refusals (exact copy).** A venue waiter on an event-only route → **403** `That isn't used at venues`. An event waiter or event till on a venue-only route → **403** `That is a venue feature`. A venue till on `/merchant/charge` → **403** `Tag payments aren't used at venues` (unchanged). A venue till on `/merchant/tables` → **403** `Venue tills hand out orders, not tables`.
- **Fail loudly.** No fallback data that mimics success; no backward-compatibility shims; DRY — reuse existing services and helpers, never copy a block.
- **Handlers never throw.** Express 4 does not await async handlers: every handler catches and ANSWERS (`ApiResponseUtil.*`) or calls `next(err)`. Never `throw e` out of a handler. Never call `String()` / `.trim()` on an unchecked `req.query` value — read query text through `textParam` (Task 11).
- **Tests.** Targeted files only: `npx jest <files> --runInBand`; read the COUNTS. Anything that moves stock or money uses `connectLedgerTestDb` (replica set, `beforeAll(connectLedgerTestDb, 60000)`). Never run the full API suite (unreliable on this machine; main has 3 known failures). `npx tsc --noEmit -p .` must be clean.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push, merge or deploy.

## Review Focus

Inputs the spec implies and a person will hit, each pinned by a test in the task that owns the code:

1. **A retry after a timeout.** The app resends the same round, payment or counter sale with the same `clientTxnId` → the first result comes back; stock and money move once. (Tasks 6, 8, 9.)
2. **Two devices pay the same balance at the same moment** → one succeeds; the other gets **409** — `the bill changed — check the balance` while the table is still open, `table is already settled` once the winner closed it. The table closes once and charges are written once. (Task 8.)
3. **A table opened by mistake, nothing on it** → the waiter can cancel it without a manager; a table with anything on it, or anything paid, cannot be cancelled from the POS. (Task 5.)
4. **Changing a bill that is already partly dealt with** → a line whose round has been handed out, or that is partly paid, cannot be removed; a line cannot be paid past its quantity. (Tasks 7, 8.)
5. **The venue is suspended mid-shift** → a waiter's already-issued token stops working on its next request, and a correct PIN at a suspended venue neither signs in nor resets the lockout counter. (Task 3.)

## File Structure

New files:

| File | Responsibility |
|---|---|
| `src/interfaces/venuePayment.interface.ts` | `IVenuePayment`, `IVenueTender`, `TenderMethod` |
| `src/models/venuePayment.model.ts` | The payment document + its indexes and sum checks |
| `src/scripts/migrate-venue-selling-indexes.ts` | Build the Phase 3 indexes; drop the legacy table-label index |
| `src/middleware/waiterKind.middleware.ts` | `byWaiterKind`, `refuse`, the two refusal strings |
| `src/utils/tenders.util.ts` | `sumTenders`, `normalizeTenders` |
| `src/utils/queryParams.util.ts` | `textParam`, `enumParam` (moved out of the organizers controller) |
| `src/validators/venueSelling.validator.ts` | Joi schemas: round, payment, counter sale |
| `src/services/venueTable.service.ts` | Rounds, handover, line removal, table payments, table views |
| `src/services/venueSale.service.ts` | Counter sales |
| `src/services/venuePayment.service.ts` | Payment list / totals / detail for the dashboard |
| `src/controllers/venueWaiter.controller.ts` | Venue waiter app handlers |
| `src/controllers/venueTill.controller.ts` | Venue till handlers (orders queue, hand-out, counter sale) |
| `src/controllers/venueTables.controller.ts` | Dashboard tables (list, detail, walkout) |
| `src/controllers/venuePayments.controller.ts` | Dashboard payments (list, detail) |
| `src/__tests__/helpers/venueFloor.ts` | Test fixtures: a venue, stalls, waiters, tills, owner tokens |

Modified files: `src/models/{waiter,table,merchantCharge}.model.ts` and their interfaces; `src/services/{waiterAuth,merchantAuth,table,posCatalog,stockAlert}.service.ts`; `src/middleware/{waiterAuth,merchantAuth}.middleware.ts`; `src/controllers/{waiter,waiterAdmin,merchant,adminOrganizers,stockReport}.controller.ts`; `src/routes/{waiter,merchant,venue}.route.ts`; `package.json`; the spec's Deploy notes.

---

### Task 1: Venue ownership on Waiter, Table, MerchantCharge; the VenuePayment model

**Files:**
- Modify: `src/models/waiter.model.ts`, `src/interfaces/waiter.interface.ts`
- Modify: `src/models/table.model.ts`, `src/interfaces/table.interface.ts`
- Modify: `src/models/merchantCharge.model.ts`
- Create: `src/interfaces/venuePayment.interface.ts`, `src/models/venuePayment.model.ts`
- Test: `src/models/__tests__/venueSelling.models.test.ts`

**Interfaces:**
- Consumes: `applyTradingScope(schema)` and `VENUE_ONLY_INDEX` from `@models/tradingScope.schema` (the plugin adds `venueId` and rejects a document with both or neither owner — so it CANNOT be used on `Waiter`, whose platform waiters have neither).
- Produces:
  - `IWaiter.venueId?: Types.ObjectId`
  - `ITable`: `eventId?`, `venueId?`, `orders?: ITableOrder[]`, `paidTotal?: number`; `ITableLine`: `orderId?: Types.ObjectId`, `paidQty?: number`
  - `ITableOrder { _id; merchantId; lineIds: Types.ObjectId[]; clientTxnId: string; status: 'sent' | 'handed_out' | 'collected'; sentAt: Date; sentBy: string; handedOutAt?; handedOutBy?; acceptedAt?; acceptedBy? }`, `TableOrderStatus`
  - `IMerchantCharge`: `eventId?`, `venueId?`, `walletId?`, `bandUid?`
  - `VenuePayment` model, `IVenuePayment`, `IVenueTender { method: TenderMethod; amount: number; tip: number; reference?: string }`, `TenderMethod = 'cash' | 'card'`

- [ ] **Step 1: Write the failing test**

`src/models/__tests__/venueSelling.models.test.ts`:

```ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Waiter } from '@models/waiter.model';
import { Table } from '@models/table.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { VenuePayment } from '@models/venuePayment.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const oid = () => new mongoose.Types.ObjectId();
const waiter = (extra: Record<string, unknown>) => ({
  fullName: 'Sipho', loginCode: `W${Math.random().toString(36).slice(2, 7).toUpperCase()}`, pin: '123456', scope: 'organizer', vendorId: oid(), ...extra,
});
const errorsOf = (doc: mongoose.Document) => Object.keys(doc.validateSync()?.errors ?? {});

describe('Waiter — event or venue', () => {
  it('accepts an organizer waiter owned by a venue and no event', async () => {
    const venueId = oid();
    const w = await Waiter.create(waiter({ venueId }));
    expect(String(w.venueId)).toBe(String(venueId));
    expect(w.eventId).toBeUndefined();
  });
  it('still requires an owner for an organizer waiter', () => {
    expect(errorsOf(new Waiter(waiter({})))).toContain('eventId');
  });
  it('refuses a waiter with both an event and a venue', () => {
    const doc = new Waiter(waiter({ eventId: oid(), venueId: oid() }));
    expect(doc.validateSync()?.errors['venueId']?.message).toBe('exactly one of eventId or venueId is required');
  });
  it('keeps a platform waiter ownerless, and refuses to give it a venue', async () => {
    await expect(Waiter.create({ ...waiter({}), scope: 'platform', vendorId: undefined })).resolves.toBeTruthy();
    const doc = new Waiter({ ...waiter({ venueId: oid() }), scope: 'platform' });
    expect(doc.validateSync()?.errors['venueId']?.message).toBe('a platform waiter cannot belong to a venue');
  });
  it('never moves a waiter to another venue', async () => {
    const w = await Waiter.create(waiter({ venueId: oid() }));
    const before = String(w.venueId);
    w.venueId = oid();
    await w.save();
    expect(String((await Waiter.findById(w._id))!.venueId)).toBe(before);
  });
});

describe('Table — event or venue', () => {
  const table = (extra: Record<string, unknown>) => ({ label: '7', status: 'open', openedBy: 'w1', items: [], subtotal: 0, ...extra });

  it('needs exactly one owner', () => {
    expect(new Table(table({})).validateSync()?.errors['venueId']?.message).toBe('exactly one of eventId or venueId is required');
    expect(new Table(table({ eventId: oid(), venueId: oid() })).validateSync()?.errors['venueId']?.message).toBe('exactly one of eventId or venueId is required');
  });
  it('lets two venues, and an event, each have an open table 7 — but not one venue twice', async () => {
    const [a, b] = [oid(), oid()];
    await Table.create(table({ venueId: a, orders: [], paidTotal: 0 }));
    await Table.create(table({ venueId: b, orders: [], paidTotal: 0 }));
    await Table.create(table({ eventId: oid() }));
    await expect(Table.create(table({ venueId: a, orders: [], paidTotal: 0 }))).rejects.toMatchObject({ code: 11000 });
  });
  it('frees a venue label once the table is no longer open', async () => {
    const venueId = oid();
    const first = await Table.create(table({ venueId, orders: [], paidTotal: 0 }));
    await Table.updateOne({ _id: first._id }, { $set: { status: 'settled' } });
    await expect(Table.create(table({ venueId, orders: [], paidTotal: 0 }))).resolves.toBeTruthy();
  });
  it('leaves an event table without the venue-only fields', async () => {
    const t = (await Table.create(table({ eventId: oid() }))).toObject();
    expect(t.orders).toBeUndefined();
    expect(t.paidTotal).toBeUndefined();
  });
  it('stores a round: an order row and lines that point at it', async () => {
    const orderId = oid();
    const merchantId = oid();
    const t = await Table.create(table({
      venueId: oid(), paidTotal: 0,
      items: [{ merchantId, productId: oid(), name: 'Castle', unitPrice: 2500, qty: 2, addedBy: 'w1', orderId, paidQty: 0 }],
      orders: [{ _id: orderId, merchantId, lineIds: [], clientTxnId: 'r1', sentAt: new Date(), sentBy: 'w1' }],
      subtotal: 5000,
    }));
    expect(t.orders![0]!.status).toBe('sent');
    expect(String(t.items[0]!.orderId)).toBe(String(orderId));
    expect(new Table(table({ venueId: oid(), orders: [{ merchantId, clientTxnId: 'r1', sentAt: new Date(), sentBy: 'w1', status: 'paid' }] }))
      .validateSync()?.errors['orders.0.status']).toBeTruthy();
  });
});

describe('MerchantCharge — event or venue', () => {
  const charge = (extra: Record<string, unknown>) => ({ merchantId: oid(), amount: 5000, fee: 0, netAmount: 5000, clientTxnId: 'c1', staffName: 'Nomsa', ...extra });

  it('accepts a venue charge with no wallet and no band', async () => {
    const c = await MerchantCharge.create(charge({ venueId: oid() }));
    expect(c.walletId).toBeUndefined();
    expect(c.bandUid).toBeUndefined();
  });
  it('still requires a wallet and a band on an event charge', () => {
    const errors = errorsOf(new MerchantCharge(charge({ eventId: oid() })));
    expect(errors).toEqual(expect.arrayContaining(['walletId', 'bandUid']));
  });
  it('needs exactly one owner', () => {
    expect(new MerchantCharge(charge({})).validateSync()?.errors['venueId']?.message).toBe('exactly one of eventId or venueId is required');
  });
});

describe('VenuePayment', () => {
  const venueId = oid();
  const payment = (extra: Record<string, unknown>) => ({
    venueId, source: 'table', tableId: oid(), tableLabel: '7', merchantIds: [oid()], clientTxnId: 'p1',
    tenders: [{ method: 'cash', amount: 3000, tip: 0 }, { method: 'card', amount: 4500, tip: 500, reference: '0192' }],
    applied: 7500, tips: 500, takenBy: 'w1', takenByType: 'Waiter', staffName: 'Sipho', at: new Date(), ...extra,
  });

  it('stores mixed tenders with a tip on one of them', async () => {
    const p = await VenuePayment.create(payment({}));
    expect(p.tenders.map((t) => t.method)).toEqual(['cash', 'card']);
    expect(p.tenders[1]!.reference).toBe('0192');
  });
  it('refuses totals that do not match the tenders', () => {
    expect(new VenuePayment(payment({ applied: 7000 })).validateSync()?.errors['applied']?.message).toBe('applied must equal the sum of tender amounts');
    expect(new VenuePayment(payment({ tips: 0 })).validateSync()?.errors['tips']?.message).toBe('tips must equal the sum of tender tips');
  });
  it('refuses a payment that takes nothing off the bill', () => {
    expect(errorsOf(new VenuePayment(payment({ tenders: [{ method: 'cash', amount: 0, tip: 500 }], applied: 0, tips: 500 })))).toContain('applied');
  });
  it('needs a table for a table payment and a stall charge for a counter sale', () => {
    expect(errorsOf(new VenuePayment(payment({ tableId: undefined })))).toContain('tableId');
    expect(errorsOf(new VenuePayment(payment({ source: 'counter', tableId: undefined, tableLabel: undefined })))).toEqual(expect.arrayContaining(['merchantChargeId', 'merchantName']));
  });
  it('is unique per venue and client transaction id', async () => {
    await VenuePayment.create(payment({}));
    await expect(VenuePayment.create(payment({}))).rejects.toMatchObject({ code: 11000 });
    await expect(VenuePayment.create(payment({ venueId: oid() }))).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/models/__tests__/venueSelling.models.test.ts --runInBand`
Expected: FAIL — `Cannot find module '@models/venuePayment.model'`.

- [ ] **Step 3: Waiter**

`src/interfaces/waiter.interface.ts` — in `IWaiter`, after `eventId?`, add:

```ts
  /** The venue this waiter works (venue trading). An organizer waiter has exactly one of eventId / venueId. */
  venueId?: Types.ObjectId;
```

`src/models/waiter.model.ts` — import `VENUE_ONLY_INDEX` from `@models/tradingScope.schema`. Change the `eventId` field's `required` and add `venueId` after it:

```ts
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    index: true,
    immutable: true,
    // An organizer waiter works ONE event or ONE venue; a platform waiter neither.
    required: function (this: { scope?: string; venueId?: unknown }) { return this.scope === 'organizer' && this.venueId == null; },
  },
  venueId: { type: Schema.Types.ObjectId, ref: 'Venue', immutable: true },
```

After `applyOperatorCredentials(waiterSchema);` add:

```ts
// applyTradingScope is NOT used here: it refuses a document with neither
// owner, and a platform waiter legitimately has neither.
waiterSchema.pre('validate', function (next) {
  const hasVenue = this.get('venueId') != null;
  if (hasVenue && this.get('eventId') != null) {
    this.invalidate('venueId', 'exactly one of eventId or venueId is required');
  }
  if (hasVenue && this.get('scope') === 'platform') {
    this.invalidate('venueId', 'a platform waiter cannot belong to a venue');
  }
  next();
});
```

and beside the other indexes: `waiterSchema.index({ venueId: 1, isActive: 1 }, VENUE_ONLY_INDEX);`

- [ ] **Step 4: Table**

`src/interfaces/table.interface.ts` — add:

```ts
export type TableOrderStatus = 'sent' | 'handed_out' | 'collected';

/** One stall's share of one round at a VENUE table (venue trading Phase 3). */
export interface ITableOrder {
  _id: Types.ObjectId;
  merchantId: Types.ObjectId;
  lineIds: Types.ObjectId[];
  /** The round's idempotency key — shared by every order row the round created. */
  clientTxnId: string;
  status: TableOrderStatus;
  sentAt: Date;
  sentBy: string;
  handedOutAt?: Date;
  handedOutBy?: string;
  acceptedAt?: Date;
  acceptedBy?: string;
}
```

In `ITableLine` add `orderId?: Types.ObjectId;` and `paidQty?: number;` (venue lines only). In `ITable` change `eventId: Types.ObjectId;` to `eventId?: Types.ObjectId;` and add:

```ts
  venueId?: Types.ObjectId;
  /** VENUE tables only: the rounds sent to each stall. Event tables use `fulfilment`. */
  orders?: ITableOrder[];
  /** VENUE tables only: what has been paid so far (a venue bill takes several payments). */
  paidTotal?: number;
```

`src/models/table.model.ts`:
- Import `applyTradingScope, VENUE_ONLY_INDEX` from `@models/tradingScope.schema`.
- `tableLineSchema`: add `orderId: { type: Schema.Types.ObjectId },` and `paidQty: { type: Number, min: 0, validate: { validator: Number.isInteger, message: 'paidQty must be a whole number' } },` (NO default — an event line never carries them).
- Add before `tableSchema`:

```ts
// A venue round, one row per stall. `_id` stays ON: the till and the waiter
// address a row by it (an event fulfilment row is keyed by its stall instead).
const tableOrderSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  lineIds: { type: [Schema.Types.ObjectId], default: [] },
  clientTxnId: { type: String, required: true, trim: true },
  status: { type: String, enum: ['sent', 'handed_out', 'collected'], default: 'sent', required: true },
  sentAt: { type: Date, required: true },
  sentBy: { type: String, required: true },
  handedOutAt: { type: Date },
  handedOutBy: { type: String, trim: true },
  acceptedAt: { type: Date },
  acceptedBy: { type: String, trim: true },
});
```

- In `tableSchema`: `eventId` loses `required: true` (keep `ref` and `index: true`); add

```ts
  // Venue tables only — `default: undefined` so an event table is stored and
  // returned exactly as before.
  orders: { type: [tableOrderSchema], default: undefined },
  paidTotal: { type: Number, min: 0, validate: integerCents },
```

- After the schema: `applyTradingScope(tableSchema);`
- REPLACE the unique partial index `{ eventId: 1, label: 1 }` (keep its comment, adding the sentence "Named and label-led so they can coexist with the legacy `eventId_1_label_1`, which treats a venue table's missing eventId as null — see src/scripts/migrate-venue-selling-indexes.ts.") with:

```ts
tableSchema.index(
  { label: 1, eventId: 1 },
  { name: 'event_open_label_unique', unique: true, partialFilterExpression: { status: 'open', eventId: { $exists: true } } },
);
tableSchema.index(
  { label: 1, venueId: 1 },
  { name: 'venue_open_label_unique', unique: true, partialFilterExpression: { status: 'open', venueId: { $exists: true } } },
);
tableSchema.index({ venueId: 1, status: 1, createdAt: -1 }, VENUE_ONLY_INDEX);
// The stall's queue: "venue tables with a round for MY stall in this state".
tableSchema.index({ venueId: 1, 'orders.merchantId': 1, 'orders.status': 1 }, VENUE_ONLY_INDEX);
```

- [ ] **Step 5: MerchantCharge**

`src/models/merchantCharge.model.ts`:
- Interface: `eventId?: Types.ObjectId; venueId?: Types.ObjectId; walletId?: Types.ObjectId; bandUid?: string;` (update the comments: "absent on a venue charge — cash/card, no wallet").
- Schema: `eventId` loses `required: true`; `walletId` and `bandUid` become required only for an event charge:

```ts
  walletId: { type: Schema.Types.ObjectId, index: true, required: function (this: { eventId?: unknown }) { return this.eventId != null; } },
  bandUid: { type: String, trim: true, required: function (this: { eventId?: unknown }) { return this.eventId != null; } },
```

- After the schema: `applyTradingScope(merchantChargeSchema);` and `merchantChargeSchema.index({ venueId: 1, createdAt: -1 }, VENUE_ONLY_INDEX);`

- [ ] **Step 6: VenuePayment**

`src/interfaces/venuePayment.interface.ts`:

```ts
import { Document, Types } from 'mongoose';

export type TenderMethod = 'cash' | 'card';
export const TENDER_METHODS: readonly TenderMethod[] = ['cash', 'card'] as const;

/** One way a payment was made. `amount` comes off the bill; `tip` never does. */
export interface IVenueTender {
  method: TenderMethod;
  amount: number;
  tip: number;
  /** A card slip reference. Card only. */
  reference?: string;
}

export type VenuePaymentSource = 'table' | 'counter';

/** Money a venue took: a table payment (one of possibly several) or a counter sale. */
export interface IVenuePayment extends Document {
  venueId: Types.ObjectId;
  source: VenuePaymentSource;
  tableId?: Types.ObjectId;
  /** Snapshot — a table label is reused once its table closes. */
  tableLabel?: string;
  merchantChargeId?: Types.ObjectId;
  /** Snapshot of the stall's name, for a counter sale. */
  merchantName?: string;
  /** The stalls with items on the bill when this was taken (one for a counter sale). */
  merchantIds: Types.ObjectId[];
  clientTxnId: string;
  tenders: IVenueTender[];
  /** Σ tender.amount — what this took off the bill. */
  applied: number;
  /** Σ tender.tip — never counted as sales. */
  tips: number;
  /** Present only when the guest paid for specific items. */
  lines?: Array<{ lineId: Types.ObjectId; qty: number }>;
  takenBy: string;
  takenByType: 'Waiter' | 'MerchantOperator';
  staffName: string;
  at: Date;
  createdAt: Date;
}
```

`src/models/venuePayment.model.ts`:

```ts
import { Schema, model } from 'mongoose';
import { IVenuePayment, TENDER_METHODS } from '@interfaces/venuePayment.interface';

const cents = { validator: Number.isSafeInteger, message: '{PATH} must be integer minor units' };

const tenderSchema = new Schema({
  method: { type: String, enum: TENDER_METHODS, required: true },
  amount: { type: Number, required: true, min: 0, validate: cents },
  tip: { type: Number, required: true, min: 0, default: 0, validate: cents },
  reference: { type: String, trim: true, maxlength: 64 },
}, { _id: false });

const forSource = (source: string) => function (this: { source?: string }) { return this.source === source; };

/**
 * Money a venue took (venue trading Phase 3). Immutable once written: a
 * mis-keyed tender is corrected by a Phase 4 shift adjustment, never by an edit.
 */
const venuePaymentSchema = new Schema<IVenuePayment>({
  venueId: { type: Schema.Types.ObjectId, ref: 'Venue', required: true },
  source: { type: String, enum: ['table', 'counter'], required: true },
  tableId: { type: Schema.Types.ObjectId, ref: 'Table', required: forSource('table') },
  tableLabel: { type: String, trim: true, required: forSource('table') },
  merchantChargeId: { type: Schema.Types.ObjectId, ref: 'MerchantCharge', required: forSource('counter') },
  merchantName: { type: String, trim: true, required: forSource('counter') },
  merchantIds: { type: [Schema.Types.ObjectId], default: [] },
  clientTxnId: { type: String, required: true, trim: true },
  tenders: { type: [tenderSchema], validate: { validator: (v: unknown[]) => v.length > 0, message: 'at least one tender is required' } },
  applied: { type: Number, required: true, min: 1, validate: cents },
  tips: { type: Number, required: true, min: 0, validate: cents },
  lines: {
    type: [new Schema({
      lineId: { type: Schema.Types.ObjectId, required: true },
      qty: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
    }, { _id: false })],
    default: undefined,
  },
  takenBy: { type: String, required: true },
  takenByType: { type: String, enum: ['Waiter', 'MerchantOperator'], required: true },
  staffName: { type: String, required: true, trim: true },
  at: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

venuePaymentSchema.pre('validate', function (next) {
  const tenders = this.tenders ?? [];
  if (this.applied !== tenders.reduce((t, x) => t + x.amount, 0)) this.invalidate('applied', 'applied must equal the sum of tender amounts');
  if (this.tips !== tenders.reduce((t, x) => t + x.tip, 0)) this.invalidate('tips', 'tips must equal the sum of tender tips');
  next();
});

// A POS retry returns the original payment.
venuePaymentSchema.index({ venueId: 1, clientTxnId: 1 }, { unique: true });
venuePaymentSchema.index({ venueId: 1, at: -1 });
venuePaymentSchema.index({ venueId: 1, tableId: 1 });

export const VenuePayment = model<IVenuePayment>('VenuePayment', venuePaymentSchema);
```

- [ ] **Step 7: Make the type-checker happy without changing behaviour**

Run `npx tsc --noEmit -p .`. `ITable.eventId`, `IMerchantCharge.walletId` and `.bandUid` are now optional, so a handful of EVENT code paths no longer compile. Fix each the same way — use the value the function already holds, never a fallback:
- in `src/services/table.service.ts`, where a call passes `eventId: table.eventId`, pass the `eventObjId` / `params.eventId` already in scope (the table was just loaded BY that event id);
- in `src/services/merchant.service.ts` (`replay`, `listTransactions`) and any wallet/tag report, where an event charge's `walletId` / `bandUid` is read, the row is an event charge by construction: widen the local/return type to `string | undefined` where it is only passed through, and where a wallet is LOOKED UP, throw `new Error('charge has no wallet')` if it is absent.
No event test may change.

- [ ] **Step 8: Run the new test + the existing model/service suites — expect PASS**

Run:
```bash
npx jest src/models/__tests__/venueSelling.models.test.ts src/models/__tests__/waiter.model.test.ts src/models/__tests__/table.model.test.ts src/models/__tests__/merchantCharge.model.test.ts src/models/__tests__/merchantChargeWaiter.test.ts src/models/__tests__/tradingScope.models.test.ts src/services/__tests__/tableAddItem.test.ts src/services/__tests__/tableRemoveItem.test.ts src/services/__tests__/tableVoid.test.ts src/services/__tests__/tableSettle.test.ts src/services/__tests__/tableFulfilment.test.ts src/services/__tests__/merchantCharge.service.test.ts src/services/__tests__/merchantCharge.items.service.test.ts src/routes/__tests__/waiterTables.route.test.ts src/routes/__tests__/tableHandover.route.test.ts src/routes/__tests__/tableReport.route.test.ts src/routes/__tests__/merchantCharge.route.test.ts src/routes/__tests__/merchantChargeItems.route.test.ts --runInBand
npx tsc --noEmit -p .
```
Expected: all pass, no existing test edited; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add src/models src/interfaces src/services/table.service.ts src/services/merchant.service.ts
git commit -m "feat(venue): venue ownership on waiters, tables and charges; the VenuePayment model"
```
(add any other file Step 7 touched.)

---

### Task 2: Index migration script

**Files:**
- Create: `src/scripts/migrate-venue-selling-indexes.ts`
- Modify: `package.json` (scripts)
- Modify: `docs/superpowers/specs/2026-10-01-venue-trading-design.md` (Deploy notes)
- Test: `src/scripts/__tests__/migrate-venue-selling-indexes.test.ts`

**Interfaces:**
- Consumes: Task 1 models. Pattern: `src/scripts/migrate-product-barcode-index.ts` (read it first — same shape, same docblock style).
- Produces: `migrateVenueSellingIndexes(): Promise<{ legacyDropped: boolean }>`, `main(): Promise<void>`, npm script `migrate:venue-selling-indexes`.

Why a script and not autoIndex: the legacy `eventId_1_label_1` unique index treats a venue table's missing `eventId` as null, so the second venue to open a "7" collides. And on dev, autoIndex was observed to build none of Phase 2's new indexes on an idle service — so this script BUILDS the Phase 3 indexes too.

- [ ] **Step 1: Write the failing test**

`src/scripts/__tests__/migrate-venue-selling-indexes.test.ts`:

```ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Table } from '@models/table.model';
import { migrateVenueSellingIndexes, main } from '../migrate-venue-selling-indexes';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const LEGACY = 'eventId_1_label_1';
const names = async () => (await Table.collection.indexes()).map((i) => i.name);
const legacy = () => Table.collection.createIndex({ eventId: 1, label: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
const venueTable = (venueId: mongoose.Types.ObjectId) => ({ venueId, label: '7', status: 'open', openedBy: 'w', items: [], subtotal: 0, orders: [], paidTotal: 0 });

describe('migrate-venue-selling-indexes', () => {
  afterEach(async () => { if ((await names()).includes(LEGACY)) await Table.collection.dropIndex(LEGACY); });

  it('with the legacy index, a second venue cannot open table 7 — the bug this fixes', async () => {
    await legacy();
    await Table.create(venueTable(new mongoose.Types.ObjectId()));
    await expect(Table.create(venueTable(new mongoose.Types.ObjectId()))).rejects.toMatchObject({ code: 11000 });
  });

  it('drops the legacy index, keeps the new ones, and the second venue can open table 7', async () => {
    await legacy();
    expect(await migrateVenueSellingIndexes()).toEqual({ legacyDropped: true });
    const after = await names();
    expect(after).not.toContain(LEGACY);
    expect(after).toEqual(expect.arrayContaining(['event_open_label_unique', 'venue_open_label_unique']));
    await Table.create(venueTable(new mongoose.Types.ObjectId()));
    await expect(Table.create(venueTable(new mongoose.Types.ObjectId()))).resolves.toBeTruthy();
  });

  it('is safe to run again', async () => {
    await legacy();
    await migrateVenueSellingIndexes();
    expect(await migrateVenueSellingIndexes()).toEqual({ legacyDropped: false });
  });

  it('refuses to run with no database named', async () => {
    const saved = process.env['MONGODB_URI'];
    delete process.env['MONGODB_URI'];
    const connect = jest.spyOn(mongoose, 'connect');
    try {
      await expect(main()).rejects.toThrow('MONGODB_URI is not set');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      if (saved !== undefined) process.env['MONGODB_URI'] = saved;
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/scripts/__tests__/migrate-venue-selling-indexes.test.ts --runInBand`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the script**

`src/scripts/migrate-venue-selling-indexes.ts`:

```ts
/**
 * Venue trading Phase 3 — build the selling indexes; drop the legacy table label index.
 *
 * `eventId_1_label_1` (unique where status:'open') treated a venue table's
 * missing eventId as null, so two venues could not both have an open "7".
 * Table now declares `event_open_label_unique` + `venue_open_label_unique`.
 *
 * This script also BUILDS the Phase 3 indexes on Table, Waiter, MerchantCharge
 * and VenuePayment: autoIndex was seen to build none of Phase 2's new indexes
 * on an idle service, so it is not relied on.
 *
 * RUN ORDER — against each environment's DB:
 *   1. AFTER the new API revision holds 100% traffic. An old revision that
 *      cold-starts still declares the legacy index, and its autoIndex would
 *      re-create `eventId_1_label_1` behind this script.
 *   2. BEFORE venue waiters open tables.
 *   3. AGAIN after any rollback → roll-forward.
 *
 * Safe to re-run: dropping is existence-guarded and createIndexes is idempotent.
 *
 *   MONGODB_URI='...' npm run migrate:venue-selling-indexes
 */
import mongoose from 'mongoose';
import { Table } from '../models/table.model';
import { Waiter } from '../models/waiter.model';
import { MerchantCharge } from '../models/merchantCharge.model';
import { VenuePayment } from '../models/venuePayment.model';

const LEGACY = 'eventId_1_label_1';

/** Runs against the CURRENT mongoose connection, so a test can drive it. */
export async function migrateVenueSellingIndexes(): Promise<{ legacyDropped: boolean }> {
  for (const model of [Table, Waiter, MerchantCharge, VenuePayment] as mongoose.Model<any>[]) {
    await model.createIndexes();
    console.log(`✅ indexes built: ${model.modelName}`);
  }
  const indexes = await Table.collection.indexes();
  if (!indexes.some((i) => i.name === LEGACY)) {
    console.log(`ℹ️  ${LEGACY} already gone`);
    return { legacyDropped: false };
  }
  await Table.collection.dropIndex(LEGACY);
  console.log(`🧹 dropped ${LEGACY}`);
  return { legacyDropped: true };
}

/** The CLI entrypoint. Exported so a test can pin the missing-URI refusal. */
export async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is not set');
  // autoIndex:false — the explicit createIndexes above is the only build.
  await mongoose.connect(uri, { autoIndex: false });
  await migrateVenueSellingIndexes();
  await mongoose.disconnect();
}

// Importing this module (from its test) must not connect or exit.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('❌ migration failed', err); process.exit(1); });
}
```

`package.json` — next to `migrate:product-barcode-index` add:
`"migrate:venue-selling-indexes": "ts-node -r tsconfig-paths/register src/scripts/migrate-venue-selling-indexes.ts"`

Spec — in "Deploy notes", after the Phase 2 migration bullet, add:

```markdown
- Phase 3's `npm run migrate:venue-selling-indexes` follows the same rule: AFTER
  the new API revision holds 100% traffic, before venue waiters open tables, and
  again after any rollback → roll-forward. It builds the Phase 3 indexes itself
  (autoIndex is not relied on) and drops the legacy `eventId_1_label_1`.
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/scripts/__tests__/migrate-venue-selling-indexes.test.ts --runInBand` → 4 passed. `npx tsc --noEmit -p .` clean.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/migrate-venue-selling-indexes.ts src/scripts/__tests__/migrate-venue-selling-indexes.test.ts package.json docs/superpowers/specs/2026-10-01-venue-trading-design.md
git commit -m "feat(venue): migration building the selling indexes and dropping the legacy table label index"
```

---

### Task 3: Venue waiters sign in; suspended venues sign them out; routes pick a handler by kind

**Files:**
- Modify: `src/interfaces/waiter.interface.ts` (`WaiterToken`), `src/interfaces/merchant.interface.ts` (`MerchantToken`)
- Modify: `src/services/waiterAuth.service.ts`, `src/services/merchantAuth.service.ts`
- Modify: `src/middleware/waiterAuth.middleware.ts`, `src/middleware/merchantAuth.middleware.ts`
- Create: `src/middleware/waiterKind.middleware.ts`
- Create: `src/controllers/venueWaiter.controller.ts`
- Modify: `src/routes/waiter.route.ts`
- Create: `src/__tests__/helpers/venueFloor.ts`
- Test: `src/routes/__tests__/venueWaiterAuth.route.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Waiter.venueId`); `Venue` model (`name`, `currency: 'SZL' | 'ZAR'`, `status`, `vendorId`); `OperatorAuthController.login` already maps a thrown service error to **401** with its message.
- Produces:
  - `WaiterToken.venueId?: string`; `MerchantToken.currency?: 'SZL' | 'ZAR'`
  - Venue waiter login `operator`: `{ id, fullName, scope, eventId: null, venueId, venueName, currency, permissions }`; venue till login `operator` gains `currency`
  - `authenticateWaiter` sets `req.waiterVenue = { _id, name, currency, vendorId, status }` for a venue token; `authenticateMerchant` sets `req.merchantVenue` (same fields) for a venue till
  - `byWaiterKind(eventHandler, venueHandler)`, `refuse(message)`, `NOT_AT_VENUES = "That isn't used at venues"`, `VENUE_ONLY = 'That is a venue feature'`
  - `GET /api/waiter/venue` → `{ venue: { id, name, currency }, permissions }`
  - Test fixtures in `src/__tests__/helpers/venueFloor.ts` (signatures in Step 1) — every later task's tests use them.

- [ ] **Step 1: Write the fixtures**

`src/__tests__/helpers/venueFloor.ts`:

```ts
/**
 * Fixtures for venue selling tests (venue trading Phase 3): a venue, its
 * stalls and stock, a waiter, a till — and tokens signed the way the real
 * login signs them. Stock moves through StockService, so a suite using
 * seedVenueStall / addVenueProduct needs connectLedgerTestDb (replica set).
 */
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { Waiter } from '@models/waiter.model';
import { StockService } from '@services/stock.service';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { signVendorToken } from './auth';

let seq = 0;
const next = () => (seq += 1);
const code = (prefix: string) => `${prefix}${String(next()).padStart(4, '0')}`;

export interface SeededVenue { vendorId: string; venueId: string; venueName: string; currency: 'SZL' | 'ZAR' }

export async function seedVenue(opts: { name?: string; currency?: 'SZL' | 'ZAR' } = {}): Promise<SeededVenue> {
  const n = next();
  const name = opts.name ?? `Lounge ${n}`;
  const vendor = await Vendor.create({ businessName: name, email: `lounge${n}@floor.test`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name, currency: opts.currency ?? 'SZL', activatedBy: 'fixture' });
  return { vendorId: String(vendor._id), venueId: String(venue._id), venueName: name, currency: venue.currency };
}

/** A product on the venue's catalogue, stocked `onHand` at `merchantId`. Returns its id. */
export async function addVenueProduct(venueId: string, merchantId: string, opts: { name: string; price: number; onHand: number }): Promise<string> {
  const product = await Product.create({ venueId, name: opts.name, category: ProductCategory.BEER, price: opts.price });
  if (opts.onHand) {
    await StockService.applyMovement({
      venueId, merchantId, productId: product._id, delta: opts.onHand,
      reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'fixture',
    });
  }
  return String(product._id);
}

/** A stall at the venue selling one product. */
export async function seedVenueStall(venueId: string, opts: { name?: string; product?: string; price: number; onHand: number }): Promise<{ merchantId: string; productId: string }> {
  const merchant = await Merchant.create({ name: opts.name ?? 'Main Bar', venueId });
  const productId = await addVenueProduct(venueId, String(merchant._id), { name: opts.product ?? 'Castle Lite', price: opts.price, onHand: opts.onHand });
  return { merchantId: String(merchant._id), productId };
}

/** A venue waiter (able to take payment unless `grants` says otherwise) and its token. */
export async function seedVenueWaiter(venue: SeededVenue, opts: { fullName?: string; grants?: OperatorGrant[] } = {}) {
  const fullName = opts.fullName ?? 'Sipho';
  const waiter = await Waiter.create({
    fullName, loginCode: code('VW'), pin: '123456', scope: 'organizer',
    vendorId: venue.vendorId, venueId: venue.venueId, grants: opts.grants ?? [OperatorGrant.SETTLE_TABLES],
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id), role: 'waiter',
    permissions: [], isSuperAdmin: false, fullName, vendorId: venue.vendorId, venueId: venue.venueId,
  }, JWT_SECRET);
  return { waiterId: String(waiter._id), loginCode: waiter.loginCode, auth: `Bearer ${token}` };
}

/** A till operator on a venue stall and its token. */
export async function seedVenueTill(venue: SeededVenue, merchantId: string, opts: { fullName?: string; grants?: OperatorGrant[] } = {}) {
  const fullName = opts.fullName ?? 'Nomsa';
  const operator = await MerchantOperator.create({
    fullName, merchantId, venueId: venue.venueId, loginCode: code('VT'), pin: '111111', grants: opts.grants ?? [],
  });
  const merchant = await Merchant.findById(merchantId).select('name').lean();
  const token = jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId: String(operator._id), operatorName: fullName,
    name: merchant?.name, venueId: venue.venueId, venueName: venue.venueName, permissions: [MerchantPermission.CHARGE],
  }, JWT_SECRET);
  return { merchantOperatorId: String(operator._id), loginCode: operator.loginCode, auth: `Bearer ${token}` };
}

const ALL = [TicketsPermission.MANAGE_VENUE, TicketsPermission.MANAGE_STOCK, TicketsPermission.VIEW_REVENUE];

/** A dashboard token for the venue's vendor. Default: every venue permission. */
export const venueDashboardAuth = (venue: SeededVenue, permissions: string[] = ALL) =>
  `Bearer ${signVendorToken(venue.vendorId, { permissions })}`;
```

- [ ] **Step 2: Write the failing test**

`src/routes/__tests__/venueWaiterAuth.route.test.ts`:

```ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, seedVenueWaiter } from '@/__tests__/helpers/venueFloor';
import { Venue } from '@models/venue.model';
import { Waiter } from '@models/waiter.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { WaiterPermission } from '@interfaces/waiter.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const login = (loginCode: string, pin = '123456') => request(app).post('/api/operator/login').send({ loginCode, pin });

async function eventWaiter() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({ vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [] });
  const waiter = await Waiter.create({ fullName: 'Thabo', loginCode: 'EW0001', pin: '123456', scope: 'organizer', vendorId, eventId: event._id });
  const token = jwt.sign({ scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id), role: 'waiter', permissions: [], isSuperAdmin: false, fullName: 'Thabo', vendorId: String(vendorId), eventId: String(event._id) }, JWT_SECRET);
  return { auth: `Bearer ${token}`, loginCode: 'EW0001' };
}

describe('venue waiter sign-in', () => {
  it('signs in carrying the venue, its currency and live permissions', async () => {
    const venue = await seedVenue({ name: 'Kwa-Linda Lounge', currency: 'SZL' });
    const w = await seedVenueWaiter(venue);
    const res = await login(w.loginCode);
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('waiter');
    expect(res.body.data.operator).toMatchObject({
      id: w.waiterId, fullName: 'Sipho', scope: 'organizer', eventId: null,
      venueId: venue.venueId, venueName: 'Kwa-Linda Lounge', currency: 'SZL',
    });
    expect(res.body.data.operator.permissions).toEqual(expect.arrayContaining([WaiterPermission.MANAGE_TABLES, WaiterPermission.SETTLE_TABLES]));
    const claims = jwt.verify(res.body.data.accessToken, JWT_SECRET) as Record<string, unknown>;
    expect(claims['venueId']).toBe(venue.venueId);
    expect(claims['eventId']).toBeUndefined();
  });

  it('an event waiter signs in exactly as before', async () => {
    const w = await eventWaiter();
    const res = await login(w.loginCode);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.operator).sort()).toEqual(['eventId', 'fullName', 'id', 'scope']);
  });

  it('a suspended venue refuses sign-in and does not reset the lockout counter', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    await login(w.loginCode, '000000');
    await Venue.updateOne({ _id: venue.venueId }, { $set: { status: 'suspended' } });
    const res = await login(w.loginCode);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Venue trading is suspended');
    expect((await Waiter.findById(w.waiterId))!.failedPinAttempts).toBe(1);
  });

  it('an issued token stops working the moment the venue is suspended', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    expect((await request(app).get('/api/waiter/venue').set('Authorization', w.auth)).status).toBe(200);
    await Venue.updateOne({ _id: venue.venueId }, { $set: { status: 'suspended' } });
    const res = await request(app).get('/api/waiter/venue').set('Authorization', w.auth);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Venue trading is suspended');
  });
});

describe('GET /api/waiter/venue and the kind refusals', () => {
  it('tells a venue waiter where they work and what they may do right now', async () => {
    const venue = await seedVenue({ name: 'Kwa-Linda Lounge', currency: 'ZAR' });
    const w = await seedVenueWaiter(venue, { grants: [] });
    const res = await request(app).get('/api/waiter/venue').set('Authorization', w.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.venue).toEqual({ id: venue.venueId, name: 'Kwa-Linda Lounge', currency: 'ZAR' });
    expect(res.body.data.permissions).not.toContain(WaiterPermission.SETTLE_TABLES);
    await Waiter.updateOne({ _id: w.waiterId }, { $set: { grants: [OperatorGrant.SETTLE_TABLES] } });
    const again = await request(app).get('/api/waiter/venue').set('Authorization', w.auth);
    expect(again.body.data.permissions).toContain(WaiterPermission.SETTLE_TABLES);
  });

  it('refuses an event waiter on the venue route', async () => {
    const w = await eventWaiter();
    const res = await request(app).get('/api/waiter/venue').set('Authorization', w.auth);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('That is a venue feature');
  });

  it.each([
    ['get', '/api/waiter/events'],
    ['get', '/api/waiter/balance?bandUid=04a1b2c3'],
    ['post', '/api/waiter/tables/000000000000000000000001/items'],
    ['post', '/api/waiter/tables/000000000000000000000001/settle'],
    ['post', '/api/waiter/tables/000000000000000000000001/stalls/000000000000000000000002/accept'],
  ] as const)('refuses a venue waiter on the event-only %s %s', async (method, url) => {
    const w = await seedVenueWaiter(await seedVenue());
    const res = await request(app)[method](url).set('Authorization', w.auth).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("That isn't used at venues");
  });
});

describe('venue till sign-in', () => {
  it('now carries the venue currency', async () => {
    const venue = await seedVenue({ currency: 'ZAR' });
    const stall = await Merchant.create({ name: 'Main Bar', venueId: venue.venueId });
    await MerchantOperator.create({ fullName: 'Nomsa', merchantId: stall._id, venueId: venue.venueId, loginCode: 'VT9001', pin: '111111' });
    const res = await login('VT9001', '111111');
    expect(res.status).toBe(200);
    expect(res.body.data.operator).toMatchObject({ venueId: venue.venueId, currency: 'ZAR' });
  });
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueWaiterAuth.route.test.ts --runInBand`
Expected: FAIL — the venue waiter login response has no `venueId`; `/api/waiter/venue` is 404.

- [ ] **Step 4: Tokens and sign-in**

`src/interfaces/waiter.interface.ts` — in `WaiterToken`, after `eventId?: string;` add `/** Set for a venue waiter; an organizer token carries exactly one of eventId / venueId. */ venueId?: string;`.

`src/interfaces/merchant.interface.ts` — in `MerchantToken`, after `venueName?` add `/** The venue's currency (venue tills), so the POS shows E or R without asking. */ currency?: 'SZL' | 'ZAR';`.

`src/services/waiterAuth.service.ts`:
- Import `Venue` from `@models/venue.model`.
- In `login`, BETWEEN the failed-PIN block and `await clearPinLockout(...)`, add:

```ts
    // A venue's people are signed out with it. Checked BEFORE the lockout is
    // cleared, so a correct PIN at a suspended venue changes nothing.
    let venue: { name: string; currency: 'SZL' | 'ZAR'; status: string } | null = null;
    if (waiter.venueId) {
      venue = await Venue.findById(waiter.venueId).select('name currency status').lean<{ name: string; currency: 'SZL' | 'ZAR'; status: string } | null>();
      if (!venue || venue.status !== 'active') throw new Error('Venue trading is suspended');
    }
```

- After the existing `if (!isSuperAdmin && waiter.eventId) payload['eventId'] = …` line add `if (waiter.venueId) payload['venueId'] = waiter.venueId.toString();`.
- Bind the permissions once (`const permissions = deriveWaiterPermissions(waiter.grants);`, used in the payload too) and return:

```ts
    return {
      accessToken,
      operator: {
        id: (waiter._id as any).toString(),
        fullName: waiter.fullName,
        scope: waiter.scope,
        eventId: waiter.eventId ? waiter.eventId.toString() : null,
        // A venue waiter's app has no event to load: the venue, its currency
        // and what this person may do come with the sign-in itself.
        ...(venue ? { venueId: waiter.venueId!.toString(), venueName: venue.name, currency: venue.currency, permissions } : {}),
      },
    };
```

- `verifyToken`: add `venueId: decoded.venueId,` to the returned object.

`src/services/merchantAuth.service.ts` — in the venue branch select `'name status currency'` and set `owner = { venueId: scope.venueId, venueName: venue.name, currency: venue.currency };` (widen the `owner` union's venue arm with `currency: 'SZL' | 'ZAR'`).

- [ ] **Step 5: Per-request venue check**

`src/middleware/waiterAuth.middleware.ts` — import `Venue`. Replace the single waiter read with:

```ts
  let waiter: { isActive?: boolean; grants?: string[] } | null;
  let venue: { _id: unknown; name: string; currency: string; vendorId: unknown; status: string } | null = null;
  try {
    [waiter, venue] = await Promise.all([
      Waiter.findById(decoded.waiterId)
        .select('isActive grants')
        .lean<{ isActive?: boolean; grants?: string[] } | null>(),
      decoded.venueId
        ? Venue.findById(decoded.venueId).select('name currency vendorId status').lean<{ _id: unknown; name: string; currency: string; vendorId: unknown; status: string } | null>()
        : Promise.resolve(null),
    ]);
  } catch (e) { next(e); return; }

  if (!waiter || !waiter.isActive) { ApiResponseUtil.unauthorized(res, 'Operator deactivated'); return; }
  // Suspending a venue signs its waiters out on their next request — the
  // token alone (7 days) would otherwise keep them trading.
  if (decoded.venueId && (!venue || venue.status !== 'active')) {
    ApiResponseUtil.unauthorized(res, 'Venue trading is suspended'); return;
  }

  (req as any).waiter = { ...decoded, permissions: deriveWaiterPermissions(waiter.grants) };
  if (venue) (req as any).waiterVenue = venue;
  next();
```
(an event token adds no read: `Promise.resolve(null)`.)

`src/middleware/merchantAuth.middleware.ts` — widen the venue read to `.select('name currency vendorId status')` (and its lean type), and after the suspended check add `if (venue) (req as any).merchantVenue = venue;`.

- [ ] **Step 6: Pick a handler by kind**

`src/middleware/waiterKind.middleware.ts`:

```ts
import { NextFunction, Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { WaiterToken } from '@interfaces/waiter.interface';

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export const NOT_AT_VENUES = "That isn't used at venues";
export const VENUE_ONLY = 'That is a venue feature';

/**
 * One URL, two kinds of waiter. An event waiter and a venue waiter share the
 * app's routes, but never each other's code: the token's kind picks the
 * handler, so an event handler can rely on an event and a venue handler on a
 * venue.
 */
export const byWaiterKind = (eventHandler: Handler, venueHandler: Handler): Handler =>
  (req, res, next) => (((req as any).waiter as WaiterToken).venueId ? venueHandler : eventHandler)(req, res, next);

/** A handler that answers 403 — for the kind a route is not for. */
export const refuse = (message: string): Handler => (_req, res) => { ApiResponseUtil.forbidden(res, message); };
```

`src/controllers/venueWaiter.controller.ts`:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { WaiterToken } from '@interfaces/waiter.interface';

export interface WaiterVenue { _id: unknown; name: string; currency: 'SZL' | 'ZAR'; vendorId: unknown; status: string }

/** The venue authenticateWaiter loaded for this request (venue waiters only). */
export const venueOf = (req: Request): WaiterVenue => (req as any).waiterVenue as WaiterVenue;
export const waiterOf = (req: Request): WaiterToken => (req as any).waiter as WaiterToken;

/**
 * The venue waiter's app (venue trading Phase 3). Reached only through
 * byWaiterKind, so every handler here has a venue. Handlers answer; they never
 * throw (Express 4 does not await them).
 */
export class VenueWaiterController {
  /** GET /api/waiter/venue — where this waiter works, and what they may do NOW. */
  static async venue(req: Request, res: Response): Promise<any> {
    const venue = venueOf(req);
    return ApiResponseUtil.success(res, {
      venue: { id: String(venue._id), name: venue.name, currency: venue.currency },
      // The row-derived set from authenticateWaiter, not the token's copy.
      permissions: waiterOf(req).permissions,
    });
  }
}
```

`src/routes/waiter.route.ts` — import `byWaiterKind, refuse, NOT_AT_VENUES, VENUE_ONLY` and `VenueWaiterController`. Wrap EVERY existing handler so a venue waiter is refused, and add the venue route. The route file becomes:

```ts
router.use(authenticateWaiter);

const notAtVenues = refuse(NOT_AT_VENUES);
const venueOnly = refuse(VENUE_ONLY);

router.get('/events',   requireWaiterPermission(WaiterPermission.VIEW_EVENTS),   byWaiterKind(WaiterController.getEvents, notAtVenues));
router.get('/venue',    requireWaiterPermission(WaiterPermission.VIEW_EVENTS),   byWaiterKind(venueOnly, VenueWaiterController.venue));
router.get('/products', requireWaiterPermission(WaiterPermission.VIEW_EVENTS),   byWaiterKind(WaiterController.getProducts, notAtVenues));
router.get('/balance',  requireWaiterPermission(WaiterPermission.VIEW_EVENTS),   byWaiterKind(WaiterController.balance, notAtVenues));
router.post('/tables',  requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.openTable, notAtVenues));
router.get('/tables',   requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.listTables, notAtVenues));
router.post('/tables/:id/items',           requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.addItem, notAtVenues));
router.delete('/tables/:id/items/:lineId', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.removeItem, notAtVenues));
router.post('/tables/:id/void',            requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.voidTable, notAtVenues));
router.post('/tables/:id/stalls/:merchantId/accept', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.acceptStall, notAtVenues));
router.post('/tables/:id/settle',          requireWaiterPermission(WaiterPermission.SETTLE_TABLES), byWaiterKind(WaiterController.settleTable, notAtVenues));
```
Keep every existing comment above its route. (Tasks 5–8 swap `notAtVenues` for the real venue handler on the shared routes.)

- [ ] **Step 7: Run new + existing auth suites — expect PASS**

Run:
```bash
npx jest src/routes/__tests__/venueWaiterAuth.route.test.ts src/routes/__tests__/waiterLogin.route.test.ts src/routes/__tests__/waiterEvents.route.test.ts src/routes/__tests__/waiterProducts.route.test.ts src/routes/__tests__/waiterTables.route.test.ts src/routes/__tests__/tableHandover.route.test.ts src/routes/__tests__/operatorLogin.route.test.ts src/routes/__tests__/venueTill.route.test.ts src/services/__tests__/merchantAuth.service.test.ts src/interfaces/__tests__/waiterPermissions.test.ts --runInBand
npx tsc --noEmit -p .
```
Expected: all pass; no existing test edited.

- [ ] **Step 8: Commit**

```bash
git add src/interfaces src/services/waiterAuth.service.ts src/services/merchantAuth.service.ts src/middleware src/controllers/venueWaiter.controller.ts src/routes/waiter.route.ts src/__tests__/helpers/venueFloor.ts src/routes/__tests__/venueWaiterAuth.route.test.ts
git commit -m "feat(venue): venue waiters sign in; a suspended venue signs them out; routes pick a handler by kind"
```

---
### Task 4: Dashboard — venue waiters (hire, list, switch payment on/off, reset PIN)

**Files:**
- Modify: `src/controllers/waiterAdmin.controller.ts`
- Modify: `src/routes/venue.route.ts`
- Test: `src/routes/__tests__/venueWaiters.route.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Waiter.venueId`); Task 3 fixtures (`seedVenue`, `venueDashboardAuth`) and venue waiter sign-in; `venueScope` (sets `req.tradingScope = { kind: 'venue', venueId }` and `req.scopeVenue`); `sanitizeGrants`, `OperatorGrant.SETTLE_TABLES`.
- Produces: `GET /api/tickets/venue/waiters` → `Waiter[]`; `POST /api/tickets/venue/waiters` `{ fullName, phoneNumber?, pin?, grants? }` → 201 `{ waiter, loginCode, pin }`; `PATCH /api/tickets/venue/waiters/:id` `{ fullName?, isActive?, grants? }` → the waiter; `POST /api/tickets/venue/waiters/:id/reset-pin` → `{ waiterId, pin }`. All need `tickets:manage_venue`. A venue waiter is created with `grants: ['settle_tables']` unless the body carries `grants`.

- [ ] **Step 1: Write the failing test**

`src/routes/__tests__/venueWaiters.route.test.ts`:

```ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedVenue, seedVenueWaiter, venueDashboardAuth } from '@/__tests__/helpers/venueFloor';
import { Venue } from '@models/venue.model';
import { Waiter } from '@models/waiter.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const URL = '/api/tickets/venue/waiters';
const eventWaiterOf = (vendorId: string) => Waiter.create({
  fullName: 'Event Thabo', loginCode: 'EVW001', pin: '123456', scope: 'organizer', vendorId, eventId: new mongoose.Types.ObjectId(),
});

describe('venue waiters (dashboard)', () => {
  it('hires a waiter who can take payment, and they can sign in', async () => {
    const venue = await seedVenue({ name: 'Kwa-Linda Lounge' });
    const res = await request(app).post(URL).set('Authorization', venueDashboardAuth(venue)).send({ fullName: 'Sipho', phoneNumber: '+26876000001' });
    expect(res.status).toBe(201);
    expect(res.body.data.loginCode).toMatch(/^[0-9A-Z]{6}$/);
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    expect(res.body.data.waiter.grants).toEqual(['settle_tables']);
    const stored = await Waiter.findById(res.body.data.waiter._id).lean();
    expect(String(stored?.venueId)).toBe(venue.venueId);
    expect(String(stored?.vendorId)).toBe(venue.vendorId);
    expect(stored?.eventId).toBeUndefined();
    const login = await request(app).post('/api/operator/login').send({ loginCode: res.body.data.loginCode, pin: res.body.data.pin });
    expect(login.status).toBe(200);
    expect(login.body.data.operator).toMatchObject({ venueId: venue.venueId, venueName: 'Kwa-Linda Lounge' });
  });

  it('can hire one who only serves', async () => {
    const venue = await seedVenue();
    const res = await request(app).post(URL).set('Authorization', venueDashboardAuth(venue)).send({ fullName: 'Lindiwe', grants: [] });
    expect(res.status).toBe(201);
    expect(res.body.data.waiter.grants).toEqual([]);
  });

  it('requires a name', async () => {
    const res = await request(app).post(URL).set('Authorization', venueDashboardAuth(await seedVenue())).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('fullName is required');
  });

  it("lists this venue's waiters only", async () => {
    const venue = await seedVenue();
    const mine = await seedVenueWaiter(venue, { fullName: 'Sipho' });
    await seedVenueWaiter(await seedVenue(), { fullName: 'Other Venue' });
    await eventWaiterOf(venue.vendorId);
    const res = await request(app).get(URL).set('Authorization', venueDashboardAuth(venue));
    expect(res.status).toBe(200);
    expect(res.body.data.map((w: { _id: string }) => w._id)).toEqual([mine.waiterId]);
  });

  it('the event waiter list never shows a venue waiter', async () => {
    const venue = await seedVenue();
    await seedVenueWaiter(venue, { fullName: 'Venue Sipho' });
    const eventWaiter = await eventWaiterOf(venue.vendorId);
    const auth = `Bearer ${signVendorToken(venue.vendorId, { permissions: [TicketsPermission.MANAGE_ACCESS] })}`;
    const res = await request(app).get('/api/tickets/waiters').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((w: { _id: string }) => w._id)).toEqual([String(eventWaiter._id)]);
  });

  it('switches taking payment off and on, and deactivates', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    const auth = venueDashboardAuth(venue);
    const off = await request(app).patch(`${URL}/${w.waiterId}`).set('Authorization', auth).send({ grants: [] });
    expect(off.status).toBe(200);
    expect(off.body.data.grants).toEqual([]);
    const on = await request(app).patch(`${URL}/${w.waiterId}`).set('Authorization', auth).send({ grants: ['settle_tables'], isActive: false });
    expect(on.body.data.grants).toEqual(['settle_tables']);
    expect(on.body.data.isActive).toBe(false);
  });

  it('resets a PIN', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    const res = await request(app).post(`${URL}/${w.waiterId}/reset-pin`).set('Authorization', venueDashboardAuth(venue)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ waiterId: w.waiterId });
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    const login = await request(app).post('/api/operator/login').send({ loginCode: w.loginCode, pin: res.body.data.pin });
    expect(login.status).toBe(200);
  });

  it("answers 404 for another venue's waiter, an event waiter and a junk id", async () => {
    const venue = await seedVenue();
    const auth = venueDashboardAuth(venue);
    const other = await seedVenueWaiter(await seedVenue());
    const eventWaiter = await eventWaiterOf(venue.vendorId);
    for (const id of [other.waiterId, String(eventWaiter._id), 'junk']) {
      const patch = await request(app).patch(`${URL}/${id}`).set('Authorization', auth).send({ isActive: false });
      expect(patch.status).toBe(404);
      const reset = await request(app).post(`${URL}/${id}/reset-pin`).set('Authorization', auth).send({});
      expect(reset.status).toBe(404);
    }
    expect((await Waiter.findById(other.waiterId))!.isActive).toBe(true);
    expect((await Waiter.findById(eventWaiter._id))!.isActive).toBe(true);
  });

  it('an event route cannot touch a venue waiter', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    const auth = `Bearer ${signVendorToken(venue.vendorId, { permissions: [TicketsPermission.MANAGE_ACCESS] })}`;
    const res = await request(app).patch(`/api/tickets/waiters/${w.waiterId}`).set('Authorization', auth).send({ isActive: false });
    expect(res.status).toBe(404);
    expect((await Waiter.findById(w.waiterId))!.isActive).toBe(true);
  });

  it('needs tickets:manage_venue; no venue is 404; a suspended venue is 403', async () => {
    const venue = await seedVenue();
    const stockOnly = await request(app).get(URL).set('Authorization', venueDashboardAuth(venue, [TicketsPermission.MANAGE_STOCK, TicketsPermission.VIEW_REVENUE]));
    expect(stockOnly.status).toBe(403);
    const noVenue = await request(app).get(URL).set('Authorization', `Bearer ${signVendorToken(String(new mongoose.Types.ObjectId()), { permissions: [TicketsPermission.MANAGE_VENUE] })}`);
    expect(noVenue.status).toBe(404);
    expect(noVenue.body.message).toBe('No venue on this account');
    await Venue.updateOne({ _id: venue.venueId }, { $set: { status: 'suspended' } });
    const suspended = await request(app).get(URL).set('Authorization', venueDashboardAuth(venue));
    expect(suspended.status).toBe(403);
    expect(suspended.body.message).toBe('Venue trading is suspended');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueWaiters.route.test.ts --runInBand`
Expected: FAIL — `/api/tickets/venue/waiters` is 404; the event list shows the venue waiter.

- [ ] **Step 3: Make the controller scope-aware**

`src/controllers/waiterAdmin.controller.ts` — imports: `TradingScope` from `@utils/tradingScope.util`, `OperatorGrant` from `@interfaces/operatorGrant.interface`, `HEX24` from `@utils/controllerHelpers.util`. Replace `scopeFilter` with:

```ts
/** The venue a `/venue/waiters` route resolved (venueScope), or null on the event routes. */
function venueIdOf(req: Request): string | null {
  const scope = (req as any).tradingScope as TradingScope | undefined;
  return scope?.kind === 'venue' ? scope.venueId : null;
}

/**
 * Waiters this request may see/manage. On a venue route: that venue's
 * (venueScope already tied it to the caller's vendor). On the event routes:
 * the caller's own organizer's — or all for platform staff — and NEVER a
 * venue's (`venueId: null` also matches "no venueId").
 */
function scopeFilter(req: Request): Record<string, unknown> {
  const venueId = venueIdOf(req);
  if (venueId) return { venueId };
  const actor = actorOf(req);
  return { ...(actor.isSuperAdmin ? {} : { scope: 'organizer', vendorId: actor.vendorId }), venueId: null };
}
```

`list` — a venue list takes no `eventId`: `const eventId = !venueIdOf(req) && req.query['eventId'] ? String(req.query['eventId']) : undefined;` (rest unchanged).

`create` — resolve the owner first, then share the tail. Directly after the `fullName` check (move that check to the top of the handler if it is not already first), add the venue branch and leave the event code as the `else`:

```ts
      const venueId = venueIdOf(req);
      let owner: { scope: 'platform' | 'organizer'; vendorId?: string; eventId?: string; venueId?: string };
      if (venueId) {
        // A venue's waiter belongs to the venue's vendor; there is no event to check.
        owner = { scope: 'organizer', vendorId: String((req as any).scopeVenue.vendorId), venueId };
      } else {
        // …the existing scope / vendorId / eventId resolution, unchanged, ending in:
        owner = { scope, vendorId, eventId };
      }

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin) ? req.body.pin : generatePin();
      const waiter = await Waiter.create({
        fullName: req.body.fullName, phoneNumber: req.body.phoneNumber, ...owner, loginCode, pin,
        // At a venue the waiter who served is the one who takes the money
        // (spec: Decisions), so taking payment is on unless the caller says otherwise.
        grants: venueId && !('grants' in req.body) ? [OperatorGrant.SETTLE_TABLES] : sanitizeGrants(req.body.grants),
      });
      ApiResponseUtil.created(res, { waiter, loginCode, pin });
```
The event branch keeps every existing early return (`'eventId is required'`, `'Event not found'`, …) exactly as it is.

`update` and `resetPin` — as their first statement inside `try`:

```ts
      // On a venue route a junk id is "no such waiter", not a cast error.
      if (venueIdOf(req) && !HEX24.test(String(req.params['id']))) { ApiResponseUtil.notFound(res, 'Waiter not found'); return; }
```
(the event routes keep their existing behaviour for a junk id.) Update the two comments that say a waiter belongs to "one event" to "one event or one venue".

`src/routes/venue.route.ts` — import `WaiterAdminController` and add, after the till-staff (`/operators`) routes:

```ts
// Waiters (venue Phase 3): the same admin handlers the event side uses.
router.get('/waiters', requireTicketsPermission(MANAGE_VENUE), venueScope, WaiterAdminController.list);
router.post('/waiters', requireTicketsPermission(MANAGE_VENUE), venueScope, WaiterAdminController.create);
router.patch('/waiters/:id', requireTicketsPermission(MANAGE_VENUE), venueScope, WaiterAdminController.update);
router.post('/waiters/:id/reset-pin', requireTicketsPermission(MANAGE_VENUE), venueScope, WaiterAdminController.resetPin);
```

- [ ] **Step 4: Run new + existing waiter admin suites — expect PASS**

Run: `npx jest src/routes/__tests__/venueWaiters.route.test.ts src/routes/__tests__/waiterAdmin.route.test.ts src/routes/__tests__/waiterLogin.route.test.ts --runInBand && npx tsc --noEmit -p .`
Expected: all pass; `waiterAdmin.route.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/waiterAdmin.controller.ts src/routes/venue.route.ts src/routes/__tests__/venueWaiters.route.test.ts
git commit -m "feat(venue): venue waiters on the dashboard — hire, list, payment switch, PIN reset"
```

---

### Task 5: A venue waiter opens tables, sees the floor and the menu, and cancels an empty table

**Files:**
- Modify: `src/services/table.service.ts` (`open`, `list`, `voidTable` take an owner; new `present`)
- Modify: `src/services/posCatalog.service.ts` (`forEvent` → `forScope`)
- Modify: `src/controllers/waiter.controller.ts` (the two call sites)
- Modify: `src/utils/controllerHelpers.util.ts` (`asyncHandler`)
- Create: `src/services/venueTable.service.ts`
- Modify: `src/controllers/venueWaiter.controller.ts`, `src/routes/waiter.route.ts`
- Modify (mechanical only): existing tests that call `TableService.list(` or `PosCatalogService.forEvent(` directly
- Test: `src/routes/__tests__/venueWaiterTables.route.test.ts`

**Interfaces:**
- Consumes: `ScopeIds`, `scopeMatch` from `@utils/tradingScope.util`; Task 1 table fields; Task 3 `byWaiterKind`, `venueOf(req)`, `waiterOf(req)`, fixtures.
- Produces:
  - `TableService.open(params: ScopeIds & { label: string; openedBy: string }): Promise<ITable>` — a venue table is created with `orders: []`, `paidTotal: 0`
  - `TableService.list(ids: ScopeIds, opts?: { status?; tab?; q?; openedBy? }): Promise<WaiterTableView[]>`
  - `TableService.voidTable(params: ScopeIds & { tableId: string; reason: string; voidedBy: string }): Promise<ITable>`
  - `TableService.present(tables: ITable[]): Promise<WaiterTableView[]>` — adds `openedByName` and each line's `merchantName`
  - `PosCatalogService.forScope(ids: ScopeIds): Promise<StallPosTile[]>`
  - `asyncHandler(fn)` — wraps an async handler so a rejection reaches the error handler
  - `VenueTableService.cancelEmptyTable(params: { venueId; tableId; reason; voidedBy }): Promise<ITable>`; `WalkoutNeedsManagerError` (message `Walkouts are closed by a manager`)
  - In `venueWaiter.controller.ts`: `mayWorkTable(req, res, tableId): Promise<boolean>` (404 `Table not found` unless it is this venue's table AND the waiter's own or the waiter is a shift lead), `presentOne(table): Promise<WaiterTableView>`, `answerTableError(res, e, fallback)`
  - Venue waiter routes: `GET /api/waiter/products`, `POST /api/waiter/tables`, `GET /api/waiter/tables?status=&q=`, `POST /api/waiter/tables/:id/void` (cancel an EMPTY table)

- [ ] **Step 1: Write the failing test**

`src/routes/__tests__/venueWaiterTables.route.test.ts`:

```ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, seedVenueStall, seedVenueWaiter } from '@/__tests__/helpers/venueFloor';
import { seedStall } from '@/__tests__/helpers/tables';
import { Table } from '@models/table.model';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const open = (auth: string, label: string) => request(app).post('/api/waiter/tables').set('Authorization', auth).send({ label });

describe('venue waiter — tables', () => {
  it('opens a venue table, ready for rounds and payments', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue, { fullName: 'Sipho' });
    const res = await open(w.auth, ' 7 ');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ label: '7', status: 'open', subtotal: 0, paidTotal: 0, orders: [], items: [], openedByName: 'Sipho' });
    const stored = await Table.findById(res.body.data._id).lean();
    expect(String(stored?.venueId)).toBe(venue.venueId);
    expect(stored?.eventId).toBeUndefined();
    expect(stored?.openedBy).toBe(w.waiterId);
  });

  it('refuses a second open table with the same number here — but not at another venue', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    expect((await open(w.auth, '7')).status).toBe(201);
    const again = await open(w.auth, '7');
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('Table 7 is already open');
    const elsewhere = await seedVenueWaiter(await seedVenue());
    expect((await open(elsewhere.auth, '7')).status).toBe(201);
  });

  it('needs a label', async () => {
    const w = await seedVenueWaiter(await seedVenue());
    const res = await open(w.auth, '   ');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('label is required');
  });

  it('shows a waiter their own tables; a shift lead sees the floor', async () => {
    const venue = await seedVenue();
    const sipho = await seedVenueWaiter(venue, { fullName: 'Sipho' });
    const lindiwe = await seedVenueWaiter(venue, { fullName: 'Lindiwe' });
    const lead = await seedVenueWaiter(venue, { fullName: 'Lead', grants: [OperatorGrant.SETTLE_TABLES, OperatorGrant.MANAGE_ALL_TABLES] });
    await open(sipho.auth, '1');
    await open(lindiwe.auth, '2');
    await open((await seedVenueWaiter(await seedVenue())).auth, '9');
    const mine = await request(app).get('/api/waiter/tables?status=open').set('Authorization', sipho.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.tables.map((t: { label: string }) => t.label)).toEqual(['1']);
    const floor = await request(app).get('/api/waiter/tables').set('Authorization', lead.auth);
    expect(floor.body.data.tables.map((t: { label: string }) => t.label).sort()).toEqual(['1', '2']);
    const searched = await request(app).get('/api/waiter/tables?q=2').set('Authorization', lead.auth);
    expect(searched.body.data.tables.map((t: { label: string }) => t.label)).toEqual(['2']);
  });

  it('refuses an unknown status filter', async () => {
    const w = await seedVenueWaiter(await seedVenue());
    const res = await request(app).get('/api/waiter/tables?status=paid').set('Authorization', w.auth);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Unknown table status');
  });
});

describe('venue waiter — menu', () => {
  it("lists the venue's stocked products with their stall — never another venue's or an event's", async () => {
    const venue = await seedVenue();
    await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
    await seedVenueStall((await seedVenue()).venueId, { name: 'Other Bar', product: 'Other Beer', price: 100, onHand: 5 });
    await seedStall({ price: 100, onHand: 5, name: 'Event Beer' });
    const w = await seedVenueWaiter(venue);
    const res = await request(app).get('/api/waiter/products').set('Authorization', w.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.products).toHaveLength(1);
    expect(res.body.data.products[0]).toMatchObject({ name: 'Castle Lite', price: 2500, onHand: 10, merchantName: 'Main Bar', status: 'in_stock' });
  });
});

describe('venue waiter — cancelling a table', () => {
  it('cancels a table opened by mistake with nothing on it', async () => {
    const w = await seedVenueWaiter(await seedVenue());
    const tableId = (await open(w.auth, '7')).body.data._id;
    const res = await request(app).post(`/api/waiter/tables/${tableId}/void`).set('Authorization', w.auth).send({ reason: 'wrong table number' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'voided', voidReason: 'wrong table number' });
    expect((await open(w.auth, '7')).status).toBe(201);
  });

  it('needs a reason', async () => {
    const w = await seedVenueWaiter(await seedVenue());
    const tableId = (await open(w.auth, '7')).body.data._id;
    const res = await request(app).post(`/api/waiter/tables/${tableId}/void`).set('Authorization', w.auth).send({});
    expect(res.status).toBe(400);
  });

  it.each([
    ['something on it', { $push: { items: { merchantId: new mongoose.Types.ObjectId(), productId: new mongoose.Types.ObjectId(), name: 'Castle', unitPrice: 2500, qty: 1, addedBy: 'w' } }, $set: { subtotal: 2500 } }],
    ['something already paid', { $set: { paidTotal: 100 } }],
  ])('refuses a table with %s — that is a manager walkout', async (_what, update) => {
    const w = await seedVenueWaiter(await seedVenue());
    const tableId = (await open(w.auth, '7')).body.data._id;
    await Table.updateOne({ _id: tableId }, update);
    const res = await request(app).post(`/api/waiter/tables/${tableId}/void`).set('Authorization', w.auth).send({ reason: 'left' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Walkouts are closed by a manager');
    expect((await Table.findById(tableId))!.status).toBe('open');
  });

  it("answers 404 for another waiter's table, another venue's table and a junk id", async () => {
    const venue = await seedVenue();
    const sipho = await seedVenueWaiter(venue);
    const lindiwe = await seedVenueWaiter(venue);
    const elsewhere = await seedVenueWaiter(await seedVenue(), { grants: [OperatorGrant.MANAGE_ALL_TABLES] });
    const tableId = (await open(sipho.auth, '7')).body.data._id;
    for (const [auth, id] of [[lindiwe.auth, tableId], [elsewhere.auth, tableId], [sipho.auth, 'junk']] as const) {
      const res = await request(app).post(`/api/waiter/tables/${id}/void`).set('Authorization', auth).send({ reason: 'x' });
      expect(res.status).toBe(404);
    }
    expect((await Table.findById(tableId))!.status).toBe('open');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueWaiterTables.route.test.ts --runInBand`
Expected: FAIL — every venue call answers 403 `That isn't used at venues` (Task 3's refusals).

- [ ] **Step 3: Owner-aware table service and catalogue**

`src/services/table.service.ts` — import `ScopeIds, scopeMatch` from `@utils/tradingScope.util`.

`open`:
```ts
  static async open(params: ScopeIds & { label: string; openedBy: string }): Promise<ITable> {
    const label = params.label.trim();
    if (!label) throw new Error('label is required');
    const owner = scopeMatch(params);
    try {
      return await Table.create({
        ...owner, label, status: 'open', openedBy: params.openedBy, items: [], subtotal: 0,
        // A venue table runs a tab: rounds, and payments against it.
        ...('venueId' in owner ? { orders: [], paidTotal: 0 } : {}),
      });
    } catch (err) {
      if ((err as { keyPattern?: Record<string, unknown> })?.keyPattern?.label) throw new TableLabelTakenError(label);
      throw err;
    }
  }
```

`list` — signature `static async list(ids: ScopeIds, opts: { status?: string; tab?: string; q?: string; openedBy?: string } = {})`; its `Table.find` filter starts `...scopeMatch(ids),` in place of `eventId: new mongoose.Types.ObjectId(eventId),`; and its name-decoration tail moves into a new public method which `list` returns through:

```ts
  /** Adds the waiter's name and each line's stall name to a batch of tables. */
  static async present(tables: ITable[]): Promise<WaiterTableView[]> {
    const [names, stalls] = await Promise.all([
      waiterNames(tables.map((t) => t.openedBy)),
      merchantNames(tables.flatMap((t) => t.items.map((i) => String(i.merchantId)))),
    ]);
    return tables.map((t) => ({
      ...t,
      openedByName: names.get(t.openedBy) ?? 'Unknown waiter',
      items: t.items.map((i) => ({
        ...i,
        merchantName: stalls.get(String(i.merchantId)) ?? 'Unknown stall',
      })),
    })) as unknown as WaiterTableView[];
  }
```
(`list` ends `return TableService.present(tables);`.)

`voidTable` — signature `static async voidTable(params: ScopeIds & { tableId: string; reason: string; voidedBy: string })`; replace both `eventId: eventObjId` filter terms with `...scopeMatch(params)`. Nothing else changes.

`src/services/posCatalog.service.ts` — rename `forEvent(eventId: string)` to `forScope(ids: ScopeIds)`: `Merchant.find({ ...scopeMatch(ids), status: 'active' })` and `Product.find({ ...scopeMatch(ids), active: true, … })`. Update its doc comment ("one event's or one venue's whole menu").

`src/controllers/waiter.controller.ts` — the two event call sites: `TableService.list({ eventId: String(event._id) }, { … })` and `PosCatalogService.forScope({ eventId: String(event._id) })`. (`TableService.open` and `voidTable` already pass an object with `eventId`.)

Mechanical test edits: `git grep -n "TableService.list(\|PosCatalogService.forEvent(" -- src` — in each existing test, `TableService.list(X, …)` → `TableService.list({ eventId: X }, …)` and `forEvent(X)` → `forScope({ eventId: X })`. No assertion changes.

- [ ] **Step 4: `asyncHandler` and the venue table service**

`src/utils/controllerHelpers.util.ts` — add (import `NextFunction, RequestHandler` from express):

```ts
/**
 * Express 4 does not await a handler. Wrapped, a rejection reaches the error
 * handler as a 500 — instead of hanging the request, or (unhandled) taking the
 * process down.
 */
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };
```

`src/services/venueTable.service.ts`:

```ts
import mongoose from 'mongoose';
import { Table } from '@models/table.model';
import { ITable } from '@interfaces/table.interface';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** A table with anything on it, or anything paid, is not the waiter's to close. */
export class WalkoutNeedsManagerError extends Error {
  constructor() {
    super('Walkouts are closed by a manager');
    this.name = 'WalkoutNeedsManagerError';
  }
}

/**
 * What a VENUE table does that an event table does not (venue trading Phase 3):
 * rounds sent to the bar, a handover per round, payments against a running
 * bill. Event tables stay in TableService; the two share open / list / void.
 */
export class VenueTableService {
  /**
   * A waiter cancels a table opened by mistake. Only an EMPTY table with
   * nothing paid: anything else is a walkout, which a manager closes from the
   * dashboard (TableService.voidTable) so the write-off has an owner.
   */
  static async cancelEmptyTable(params: { venueId: string; tableId: string; reason: string; voidedBy: string }): Promise<ITable> {
    const reason = params.reason.trim();
    if (!reason) throw new Error('reason is required');
    const mine = { _id: oid(params.tableId), venueId: oid(params.venueId) };
    const updated = await Table.findOneAndUpdate(
      { ...mine, status: 'open', items: { $size: 0 }, paidTotal: 0 },
      { $set: { status: 'voided', voidedAt: new Date(), voidReason: reason, voidedBy: params.voidedBy } },
      { new: true },
    );
    if (updated) return updated;
    const existing = await Table.findOne(mine);
    if (!existing) throw new Error('table not found');
    if (existing.status !== 'open') throw new Error(`table is not open (status: ${existing.status})`);
    throw new WalkoutNeedsManagerError();
  }
}
```

- [ ] **Step 5: The venue waiter handlers**

`src/controllers/venueWaiter.controller.ts` — add imports (`Table`, `ITable`, `WaiterPermission`, `HEX24`, `TableService`, `TableLabelTakenError`, `WaiterTableView`, `PosCatalogService`, `VenueTableService`, `WalkoutNeedsManagerError`) and, above the class:

```ts
const TABLE_STATUSES = ['open', 'settled', 'voided'] as const;
const venueIdOf = (req: Request): string => String(venueOf(req)._id);

/**
 * May this waiter work this table? Their own — or any, for a shift lead — and
 * ALWAYS one of this venue's. 404 otherwise: a waiter has no business learning
 * that an id exists. Returns true to proceed; otherwise it has answered.
 */
export async function mayWorkTable(req: Request, res: Response, tableId: string): Promise<boolean> {
  const waiter = waiterOf(req);
  const table = HEX24.test(tableId)
    ? await Table.findOne({ _id: tableId, venueId: venueOf(req)._id }, { openedBy: 1 }).lean<{ openedBy: string } | null>()
    : null;
  const allowed = !!table && (table.openedBy === waiter.waiterId || waiter.permissions.includes(WaiterPermission.MANAGE_ALL_TABLES));
  if (!allowed) ApiResponseUtil.notFound(res, 'Table not found');
  return allowed;
}

/** One table as the waiter's app shows it (names resolved). */
export async function presentOne(table: ITable): Promise<WaiterTableView> {
  const plain = (typeof (table as any).toObject === 'function' ? (table as any).toObject() : table) as ITable;
  const [view] = await TableService.present([plain]);
  return view!;
}

/** Answer a venue table error. Known cases get their status; anything else is a loud 500. */
export function answerTableError(res: Response, e: any, fallback: string): Response {
  if (e instanceof TableLabelTakenError) return ApiResponseUtil.error(res, e.message, 409);
  if (e instanceof WalkoutNeedsManagerError) return ApiResponseUtil.forbidden(res, e.message);
  const message: string = e?.message || fallback;
  if (/is required/i.test(message)) return ApiResponseUtil.badRequest(res, message);
  if (/not open/i.test(message)) return ApiResponseUtil.error(res, message, 409);
  if (/table not found/i.test(message)) return ApiResponseUtil.notFound(res, 'Table not found');
  console.error(fallback, e);
  return ApiResponseUtil.error(res, message, 500);
}
```
(Tasks 6–8 add their own error classes to `answerTableError`.)

Inside the class add:

```ts
  /** GET /api/waiter/products — the venue's whole menu, each product with its stall. */
  static async getProducts(req: Request, res: Response): Promise<any> {
    const products = await PosCatalogService.forScope({ venueId: venueIdOf(req) });
    return ApiResponseUtil.success(res, { products });
  }

  /** POST /api/waiter/tables { label } */
  static async openTable(req: Request, res: Response): Promise<any> {
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label) return ApiResponseUtil.badRequest(res, 'label is required');
    try {
      const table = await TableService.open({ venueId: venueIdOf(req), label, openedBy: waiterOf(req).waiterId });
      return ApiResponseUtil.created(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not open the table'); }
  }

  /** GET /api/waiter/tables?status=open|settled|voided&q= — own tables; the floor for a shift lead. */
  static async listTables(req: Request, res: Response): Promise<any> {
    const raw = req.query['status'];
    const status = TABLE_STATUSES.find((s) => s === raw);
    if (raw !== undefined && !status) return ApiResponseUtil.badRequest(res, 'Unknown table status');
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
    const waiter = waiterOf(req);
    const wholeFloor = waiter.permissions.includes(WaiterPermission.MANAGE_ALL_TABLES);
    const tables = await TableService.list({ venueId: venueIdOf(req) }, { status, q, ...(wholeFloor ? {} : { openedBy: waiter.waiterId }) });
    return ApiResponseUtil.success(res, { tables });
  }

  /** POST /api/waiter/tables/:id/void { reason } — cancel an EMPTY table. A walkout is a manager's. */
  static async cancelTable(req: Request, res: Response): Promise<any> {
    const tableId = String(req.params['id']);
    if (!(await mayWorkTable(req, res, tableId))) return;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    try {
      const table = await VenueTableService.cancelEmptyTable({ venueId: venueIdOf(req), tableId, reason, voidedBy: waiterOf(req).waiterId });
      return ApiResponseUtil.success(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not cancel the table'); }
  }
```

`src/routes/waiter.route.ts` — import `asyncHandler`; wrap every venue handler (including Task 3's `venue`) and swap these venue arms:

```ts
router.get('/venue',    …, byWaiterKind(venueOnly, asyncHandler(VenueWaiterController.venue)));
router.get('/products', …, byWaiterKind(WaiterController.getProducts, asyncHandler(VenueWaiterController.getProducts)));
router.post('/tables',  …, byWaiterKind(WaiterController.openTable, asyncHandler(VenueWaiterController.openTable)));
router.get('/tables',   …, byWaiterKind(WaiterController.listTables, asyncHandler(VenueWaiterController.listTables)));
router.post('/tables/:id/void', …, byWaiterKind(WaiterController.voidTable, asyncHandler(VenueWaiterController.cancelTable)));
```

- [ ] **Step 6: Run new + existing table/catalogue suites — expect PASS**

Run:
```bash
npx jest src/routes/__tests__/venueWaiterTables.route.test.ts src/routes/__tests__/venueWaiterAuth.route.test.ts src/routes/__tests__/waiterTables.route.test.ts src/routes/__tests__/waiterProducts.route.test.ts src/routes/__tests__/tableHandover.route.test.ts src/services/__tests__/tableVoid.test.ts src/services/__tests__/tableFulfilment.test.ts src/services/__tests__/tableAddItem.test.ts --runInBand
npx tsc --noEmit -p .
```
plus any test `git grep -ln "forEvent\|TableService.list" -- src` named. Expected: all pass; existing tests changed only by the two mechanical call shapes. Note: Task 3's refusal test still lists `/tables/:id/items`, `/settle`, `/stalls/…/accept`, `/events`, `/balance` — those stay refused.

- [ ] **Step 7: Commit**

```bash
git add src/services/table.service.ts src/services/posCatalog.service.ts src/services/venueTable.service.ts src/controllers/waiter.controller.ts src/controllers/venueWaiter.controller.ts src/utils/controllerHelpers.util.ts src/routes/waiter.route.ts src/routes/__tests__/venueWaiterTables.route.test.ts
git commit -m "feat(venue): a venue waiter opens tables, sees the floor and the menu, cancels an empty table"
```
(add the mechanically edited test files.)

---

### Task 6: Rounds — a waiter sends an order to the bar

**Files:**
- Create: `src/validators/venueSelling.validator.ts`
- Modify: `src/services/venueTable.service.ts`, `src/controllers/venueWaiter.controller.ts`, `src/routes/waiter.route.ts`
- Test: `src/routes/__tests__/venueRounds.route.test.ts`

**Interfaces:**
- Consumes: Task 5 (`mayWorkTable`, `presentOne`, `answerTableError`, `VenueTableService`); `StockService.applyMovement` (`MovementInput` accepts `{ venueId }`; throws `StockDeclinedError(productId, available)`); `MAX_LINES = 50`, `MAX_QTY_PER_LINE = 1000` from `@validators/merchant.validator`; `objectId` from `@validators/stock.validator`.
- Produces:
  - `roundSchema` (Joi): `{ clientTxnId: string 1–100, items: [{ merchantId, productId, qty 1–1000 }] 1–50 }`
  - `VenueTableService.sendOrder(params: { venueId: string; tableId: string; clientTxnId: string; items: RoundItem[]; sentBy: string }): Promise<ITable>`; `RoundItem { merchantId: string; productId: string; qty: number }`; `RoundOutOfStockError { reason: 'insufficient_stock'; productId; productName; available }` (message `Out of stock: <name>`)
  - `POST /api/waiter/tables/:id/orders` → 200, the table view. ONE order row per stall (`status: 'sent'`), every new line carrying its `orderId` and `paidQty: 0`.

A round is ONE transaction: the lines, the order rows and every stock movement land together, or none do. The same `clientTxnId` again returns the table as it stands — nothing is sent twice.

- [ ] **Step 1: Write the failing test**

`src/routes/__tests__/venueRounds.route.test.ts`:

```ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { addVenueProduct, seedVenue, seedVenueStall, seedVenueWaiter } from '@/__tests__/helpers/venueFloor';
import { seedStall } from '@/__tests__/helpers/tables';
import { Table } from '@models/table.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockService } from '@services/stock.service';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function floor() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const kitchen = await seedVenueStall(venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
  const waiter = await seedVenueWaiter(venue, { fullName: 'Sipho' });
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  const send = (body: unknown, auth = waiter.auth, id = tableId) => request(app).post(`/api/waiter/tables/${id}/orders`).set('Authorization', auth).send(body as object);
  return { venue, bar, kitchen, waiter, tableId, send };
}
const onHand = (s: { merchantId: string; productId: string }) => StockService.getOnHand(s.merchantId, s.productId);

describe('venue rounds', () => {
  it('sends one order per stall, takes the stock, and adds to the bill', async () => {
    const f = await floor();
    const res = await f.send({ clientTxnId: 'r1', items: [
      { ...f.bar, qty: 2 }, { ...f.kitchen, qty: 1 }, { ...f.bar, qty: 1 },
    ] });
    expect(res.status).toBe(200);
    const t = res.body.data;
    expect(t.subtotal).toBe(3 * 2500 + 9000);
    expect(t.orders).toHaveLength(2);
    expect(t.orders.every((o: { status: string; clientTxnId: string }) => o.status === 'sent' && o.clientTxnId === 'r1')).toBe(true);
    expect(t.items).toHaveLength(2);
    const beer = t.items.find((l: { name: string }) => l.name === 'Castle Lite');
    expect(beer).toMatchObject({ qty: 3, unitPrice: 2500, paidQty: 0, merchantName: 'Main Bar' });
    const barOrder = t.orders.find((o: { merchantId: string }) => o.merchantId === f.bar.merchantId);
    expect(beer.orderId).toBe(barOrder._id);
    expect(barOrder.lineIds).toEqual([beer._id]);
    expect(await onHand(f.bar)).toBe(7);
    expect(await onHand(f.kitchen)).toBe(2);
    const sale = await StockMovement.findOne({ productId: f.bar.productId, reason: 'sale' }).lean();
    expect(sale).toMatchObject({ delta: -3, refType: 'table_order', refId: barOrder._id, byType: 'Waiter', by: f.waiter.waiterId });
    expect(String(sale?.venueId)).toBe(f.venue.venueId);
  });

  it('a retried round is sent once', async () => {
    const f = await floor();
    const body = { clientTxnId: 'r1', items: [{ ...f.bar, qty: 2 }] };
    const first = await f.send(body);
    const again = await f.send(body);
    expect(again.status).toBe(200);
    expect(again.body.data.orders).toHaveLength(1);
    expect(again.body.data.subtotal).toBe(first.body.data.subtotal);
    expect(await onHand(f.bar)).toBe(8);
  });

  it('a second round adds to the same bill', async () => {
    const f = await floor();
    await f.send({ clientTxnId: 'r1', items: [{ ...f.bar, qty: 1 }] });
    const res = await f.send({ clientTxnId: 'r2', items: [{ ...f.bar, qty: 2 }] });
    expect(res.body.data.orders).toHaveLength(2);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.subtotal).toBe(7500);
  });

  it('one item out of stock rolls the whole round back, and names it', async () => {
    const f = await floor();
    const res = await f.send({ clientTxnId: 'r1', items: [{ ...f.bar, qty: 2 }, { ...f.kitchen, qty: 4 }] });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Out of stock: Burger');
    expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'insufficient_stock', productId: f.kitchen.productId, name: 'Burger', available: 3 });
    const stored = await Table.findById(f.tableId).lean();
    expect(stored?.items).toHaveLength(0);
    expect(stored?.orders).toHaveLength(0);
    expect(stored?.subtotal).toBe(0);
    expect(await onHand(f.bar)).toBe(10);
    expect(await onHand(f.kitchen)).toBe(3);
  });

  it("refuses another venue's or an event's stall and product, and a product the stall does not stock", async () => {
    const f = await floor();
    const other = await seedVenueStall((await seedVenue()).venueId, { price: 100, onHand: 5 });
    const eventStall = await seedStall({ price: 100, onHand: 5 });
    const unstocked = await addVenueProduct(f.venue.venueId, f.kitchen.merchantId, { name: 'Wine', price: 4000, onHand: 2 });
    for (const items of [[{ ...other, qty: 1 }], [{ ...eventStall, qty: 1 }], [{ merchantId: f.bar.merchantId, productId: other.productId, qty: 1 }]]) {
      const res = await f.send({ clientTxnId: `x${Math.random()}`, items });
      expect(res.status).toBe(400);
    }
    const wrongStall = await f.send({ clientTxnId: 'x9', items: [{ merchantId: f.bar.merchantId, productId: unstocked, qty: 1 }] });
    expect(wrongStall.status).toBe(400);
    expect(wrongStall.body.message).toBe('Wine is not sold at that stall');
    expect((await Table.findById(f.tableId))!.subtotal).toBe(0);
    expect(await onHand(other)).toBe(5);
  });

  it('validates the round', async () => {
    const f = await floor();
    for (const body of [
      { items: [{ ...f.bar, qty: 1 }] },
      { clientTxnId: 'r1', items: [] },
      { clientTxnId: 'r1', items: [{ ...f.bar, qty: 0 }] },
      { clientTxnId: 'r1', items: [{ ...f.bar, qty: 1001 }] },
      { clientTxnId: 'r1', items: [{ merchantId: 'junk', productId: f.bar.productId, qty: 1 }] },
    ]) {
      expect((await f.send(body)).status).toBe(400);
    }
    expect(await onHand(f.bar)).toBe(10);
  });

  it("refuses another waiter's table and a closed table", async () => {
    const f = await floor();
    const colleague = await seedVenueWaiter(f.venue);
    const notMine = await f.send({ clientTxnId: 'r1', items: [{ ...f.bar, qty: 1 }] }, colleague.auth);
    expect(notMine.status).toBe(404);
    await Table.updateOne({ _id: f.tableId }, { $set: { status: 'settled' } });
    const closed = await f.send({ clientTxnId: 'r2', items: [{ ...f.bar, qty: 1 }] });
    expect(closed.status).toBe(409);
    expect(await onHand(f.bar)).toBe(10);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueRounds.route.test.ts --runInBand`
Expected: FAIL — `POST /api/waiter/tables/:id/orders` is 404.

- [ ] **Step 3: The validator**

`src/validators/venueSelling.validator.ts`:

```ts
import Joi from 'joi';
import { objectId } from '@validators/stock.validator';
import { MAX_LINES, MAX_QTY_PER_LINE } from '@validators/merchant.validator';

/** A client-chosen idempotency key: the app sends the same one when it retries. */
const clientTxnId = Joi.string().trim().min(1).max(100).required();
const qty = Joi.number().integer().min(1).max(MAX_QTY_PER_LINE).required();

/** POST /api/waiter/tables/:id/orders */
export const roundSchema = Joi.object({
  clientTxnId,
  items: Joi.array().items(Joi.object({ merchantId: objectId.required(), productId: objectId.required(), qty })).min(1).max(MAX_LINES).required(),
});
```

- [ ] **Step 4: `sendOrder`**

`src/services/venueTable.service.ts` — add imports (`Merchant`, `Product`, `ProductStock`, `StockService`, `StockDeclinedError`, `StockMovementReason`) and, above the class:

```ts
export interface RoundItem { merchantId: string; productId: string; qty: number }

/** A round's item that the shelf could not cover — the whole round rolled back. */
export class RoundOutOfStockError extends Error {
  readonly reason = 'insufficient_stock';
  constructor(public productId: string, public productName: string, public available: number) {
    super(`Out of stock: ${productName}`);
    this.name = 'RoundOutOfStockError';
  }
}

/** Control flow: the round was already sent (a retry). Carries the table as it stands. */
class ReplayedRound extends Error {
  constructor(public table: ITable) { super('replayed round'); }
}

const sentAlready = (table: ITable, clientTxnId: string) => (table.orders ?? []).some((o) => o.clientTxnId === clientTxnId);
```

Inside the class:

```ts
  /**
   * Send a round. ONE transaction: the lines, one order row per stall, and
   * every stock movement — a single short item rolls all of it back. A retry
   * with the same clientTxnId returns the table as it stands.
   */
  static async sendOrder(params: { venueId: string; tableId: string; clientTxnId: string; items: RoundItem[]; sentBy: string }): Promise<ITable> {
    const { clientTxnId, sentBy } = params;
    const venueId = oid(params.venueId);
    const mine = { _id: oid(params.tableId), venueId };

    const table = await Table.findOne(mine);
    if (!table) throw new Error('table not found');
    if (sentAlready(table, clientTxnId)) return table;
    if (table.status !== 'open') throw new Error(`table is not open (status: ${table.status})`);

    // The same product from the same stall twice in one round is one line.
    const merged = new Map<string, RoundItem>();
    for (const item of params.items) {
      const key = `${item.merchantId}:${item.productId}`;
      merged.set(key, { ...item, qty: (merged.get(key)?.qty ?? 0) + item.qty });
    }
    const merchantIds = [...new Set(params.items.map((i) => i.merchantId))];
    const productIds = [...new Set(params.items.map((i) => i.productId))];

    const [stalls, products, stockRows] = await Promise.all([
      Merchant.find({ _id: { $in: merchantIds.map(oid) }, venueId, status: 'active' }).select('_id').lean(),
      Product.find({ _id: { $in: productIds.map(oid) }, venueId, active: true }).select('name price').lean<{ _id: mongoose.Types.ObjectId; name: string; price: number }[]>(),
      ProductStock.find({ merchantId: { $in: merchantIds.map(oid) }, productId: { $in: productIds.map(oid) } }).select('merchantId productId').lean(),
    ]);
    if (stalls.length !== merchantIds.length) throw new Error('stall not found at this venue');
    if (products.length !== productIds.length) throw new Error('product not found at this venue');
    const productById = new Map(products.map((p) => [String(p._id), p]));
    const stocked = new Set(stockRows.map((r) => `${r.merchantId}:${r.productId}`));

    const now = new Date();
    const orderIdOf = new Map(merchantIds.map((id) => [id, new mongoose.Types.ObjectId()]));
    const lines = [...merged.entries()].map(([key, item]) => {
      const product = productById.get(item.productId)!;
      if (!stocked.has(key)) throw new Error(`${product.name} is not sold at that stall`);
      return {
        _id: new mongoose.Types.ObjectId(), merchantId: oid(item.merchantId), productId: oid(item.productId),
        name: product.name, unitPrice: product.price, qty: item.qty, addedBy: sentBy, addedAt: now,
        orderId: orderIdOf.get(item.merchantId)!, paidQty: 0,
      };
    });
    const orders = merchantIds.map((merchantId) => ({
      _id: orderIdOf.get(merchantId)!, merchantId: oid(merchantId),
      lineIds: lines.filter((l) => String(l.merchantId) === merchantId).map((l) => l._id),
      clientTxnId, status: 'sent' as const, sentAt: now, sentBy,
    }));
    const total = lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);

    const session = await mongoose.startSession();
    let sent: ITable | undefined;
    try {
      await session.withTransaction(async () => {
        const updated = await Table.findOneAndUpdate(
          { ...mine, status: 'open', 'orders.clientTxnId': { $ne: clientTxnId } },
          { $push: { items: { $each: lines }, orders: { $each: orders } }, $inc: { subtotal: total, revision: 1 } },
          { new: true, session },
        );
        if (!updated) {
          const current = await Table.findOne(mine).session(session);
          if (!current) throw new Error('table not found');
          if (sentAlready(current, clientTxnId)) throw new ReplayedRound(current);
          throw new Error(`table is not open (status: ${current.status})`);
        }
        for (const line of lines) {
          try {
            await StockService.applyMovement({
              venueId, merchantId: line.merchantId, productId: line.productId, delta: -line.qty,
              reason: StockMovementReason.SALE, refType: 'table_order', refId: String(line.orderId),
              byType: 'Waiter', by: sentBy, session,
            });
          } catch (e) {
            if (e instanceof StockDeclinedError) throw new RoundOutOfStockError(String(line.productId), line.name, e.available);
            throw e;
          }
        }
        sent = updated;
      });
    } catch (e) {
      if (e instanceof ReplayedRound) return e.table;
      throw e;
    } finally {
      await session.endSession();
    }
    return sent!;
  }
```

- [ ] **Step 5: The handler and route**

`src/controllers/venueWaiter.controller.ts` — import `roundSchema`, `RoundOutOfStockError`. In `answerTableError`, before the message checks, add:

```ts
  if (e instanceof RoundOutOfStockError) {
    return ApiResponseUtil.error(res, e.message, 409, { reason: e.reason, productId: e.productId, name: e.productName, available: e.available });
  }
```
and after the `is required` check add `if (/not found at this venue|is not sold at that stall/i.test(message)) return ApiResponseUtil.badRequest(res, message);`.

Add the handler:

```ts
  /** POST /api/waiter/tables/:id/orders { clientTxnId, items: [{ merchantId, productId, qty }] } — send a round. */
  static async sendOrder(req: Request, res: Response): Promise<any> {
    const { error, value } = roundSchema.validate(req.body ?? {}, { stripUnknown: true });
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const tableId = String(req.params['id']);
    if (!(await mayWorkTable(req, res, tableId))) return;
    try {
      const table = await VenueTableService.sendOrder({ venueId: venueIdOf(req), tableId, clientTxnId: value.clientTxnId, items: value.items, sentBy: waiterOf(req).waiterId });
      return ApiResponseUtil.success(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not send the round'); }
  }
```

`src/routes/waiter.route.ts` — add:

```ts
// A round: one order per stall, sent to the bar the moment the waiter adds it (venues).
router.post('/tables/:id/orders', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(venueOnly, asyncHandler(VenueWaiterController.sendOrder)));
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx jest src/routes/__tests__/venueRounds.route.test.ts src/routes/__tests__/venueWaiterTables.route.test.ts src/routes/__tests__/waiterTables.route.test.ts --runInBand && npx tsc --noEmit -p .`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/validators/venueSelling.validator.ts src/services/venueTable.service.ts src/controllers/venueWaiter.controller.ts src/routes/waiter.route.ts src/routes/__tests__/venueRounds.route.test.ts
git commit -m "feat(venue): rounds — one atomic, retry-safe order per stall, stock taken at send"
```

---

### Task 7: Handover — the till's order queue, hand-out, the waiter's accept; removing a line

**Files:**
- Modify: `src/services/table.service.ts` (extract `advanceArrayRow`)
- Modify: `src/services/venueTable.service.ts`
- Create: `src/controllers/venueTill.controller.ts`
- Modify: `src/controllers/merchant.controller.ts` (refusal copy), `src/controllers/venueWaiter.controller.ts`
- Modify: `src/routes/merchant.route.ts`, `src/routes/waiter.route.ts`
- Modify (one assertion, listed below): `src/routes/__tests__/venueTill.route.test.ts`
- Test: `src/routes/__tests__/venueHandover.route.test.ts`

**Interfaces:**
- Consumes: Task 6 (`sendOrder`, order rows); `TableFulfilmentNotFoundError` (`no handover for this stall on that table`) and `TableFulfilmentStateError(status, expected)` (`that handover is <status>, not <expected>`) from `@services/table.service`; `req.merchantVenue` (Task 3); fixtures `seedVenueTill`.
- Produces:
  - `advanceArrayRow(params)` exported from `table.service.ts` (the guarded "move one array row from A to B" update, shared by event fulfilment and venue orders)
  - `VenueTableService.ordersForStall({ venueId, merchantId, status? }): Promise<StallOrderView[]>`, `handOutOrder({ venueId, tableId, orderId, merchantId, handedOutBy }): Promise<ITable>`, `acceptOrder({ venueId, tableId, orderId, acceptedBy }): Promise<ITable>`, `removeLine({ venueId, tableId, lineId, removedBy }): Promise<ITable>`; `LineLockedError` (409)
  - `StallOrderView { tableId; tableLabel; orderId; status; sentAt; handedOutAt?; acceptedAt?; waiterName; items: { name; qty; unitPrice }[]; total }`
  - Till: `GET /api/merchant/orders?status=sent|handed_out|collected` → `{ orders: StallOrderView[] }`; `POST /api/merchant/tables/:tableId/orders/:orderId/hand-out` → the handed-out `StallOrderView`
  - Waiter: `POST /api/waiter/tables/:id/orders/:orderId/accept` → the table view; `DELETE /api/waiter/tables/:id/items/:lineId` (venue rule) → the table view
  - In `venueTill.controller.ts`: `venueTillOf(req, res)` → `{ venueId, merchantId, merchantOperatorId, operatorName, merchantName } | null` (403 `That is a venue feature` for an event till)

- [ ] **Step 1: Write the failing test**

`src/routes/__tests__/venueHandover.route.test.ts`:

```ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, seedVenueStall, seedVenueTill, seedVenueWaiter } from '@/__tests__/helpers/venueFloor';
import { EVENT, seedStall } from '@/__tests__/helpers/tables';
import { Table } from '@models/table.model';
import { StockService } from '@services/stock.service';
import { MerchantPermission } from '@interfaces/merchant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function served() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const kitchen = await seedVenueStall(venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
  const waiter = await seedVenueWaiter(venue, { fullName: 'Sipho' });
  const barTill = await seedVenueTill(venue, bar.merchantId, { fullName: 'Nomsa' });
  const kitchenTill = await seedVenueTill(venue, kitchen.merchantId, { fullName: 'Chef' });
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  const round = await request(app).post(`/api/waiter/tables/${tableId}/orders`).set('Authorization', waiter.auth)
    .send({ clientTxnId: 'r1', items: [{ ...bar, qty: 2 }, { ...kitchen, qty: 1 }] });
  const orderOf = (merchantId: string) => round.body.data.orders.find((o: { merchantId: string }) => o.merchantId === merchantId)._id as string;
  const lineOf = (name: string) => round.body.data.items.find((l: { name: string }) => l.name === name)._id as string;
  return { venue, bar, kitchen, waiter, barTill, kitchenTill, tableId, barOrder: orderOf(bar.merchantId), kitchenOrder: orderOf(kitchen.merchantId), beerLine: lineOf('Castle Lite'), burgerLine: lineOf('Burger') };
}
const queue = (auth: string, status?: string) => request(app).get(`/api/merchant/orders${status ? `?status=${status}` : ''}`).set('Authorization', auth);
const handOut = (auth: string, tableId: string, orderId: string) => request(app).post(`/api/merchant/tables/${tableId}/orders/${orderId}/hand-out`).set('Authorization', auth).send({});
const accept = (auth: string, tableId: string, orderId: string) => request(app).post(`/api/waiter/tables/${tableId}/orders/${orderId}/accept`).set('Authorization', auth).send({});
const remove = (auth: string, tableId: string, lineId: string) => request(app).delete(`/api/waiter/tables/${tableId}/items/${lineId}`).set('Authorization', auth);

describe('the till queue', () => {
  it("shows a stall only its own orders, with the waiter's name and the lines to make", async () => {
    const s = await served();
    const res = await queue(s.barTill.auth, 'sent');
    expect(res.status).toBe(200);
    expect(res.body.data.orders).toEqual([expect.objectContaining({
      tableId: s.tableId, tableLabel: '7', orderId: s.barOrder, status: 'sent', waiterName: 'Sipho',
      items: [{ name: 'Castle Lite', qty: 2, unitPrice: 2500 }], total: 5000,
    })]);
  });

  it('refuses an unknown status, an event till, and still refuses a venue till on the event table routes', async () => {
    const s = await served();
    const bad = await queue(s.barTill.auth, 'paid');
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Unknown order status');
    const stall = await seedStall({ price: 100, onHand: 1 });
    const eventOperator = await MerchantOperator.create({ fullName: 'Op', merchantId: stall.merchantId, eventId: EVENT, loginCode: 'EVT001', pin: '111111' });
    const eventTill = `Bearer ${jwt.sign({ scope: 'merchant', merchantId: stall.merchantId, merchantOperatorId: String(eventOperator._id), operatorName: 'Op', eventId: String(EVENT), name: 'Bar', permissions: [MerchantPermission.CHARGE] }, JWT_SECRET)}`;
    const venueOnly = await queue(eventTill);
    expect(venueOnly.status).toBe(403);
    expect(venueOnly.body.message).toBe('That is a venue feature');
    const tables = await request(app).get('/api/merchant/tables').set('Authorization', s.barTill.auth);
    expect(tables.status).toBe(403);
    expect(tables.body.message).toBe('Venue tills hand out orders, not tables');
  });
});

describe('hand-out and accept', () => {
  it('walks an order sent → handed out → collected, stamping who did each', async () => {
    const s = await served();
    const out = await handOut(s.barTill.auth, s.tableId, s.barOrder);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ orderId: s.barOrder, status: 'handed_out', tableLabel: '7' });
    expect((await queue(s.barTill.auth, 'sent')).body.data.orders).toHaveLength(0);
    expect((await queue(s.barTill.auth, 'handed_out')).body.data.orders).toHaveLength(1);
    const got = await accept(s.waiter.auth, s.tableId, s.barOrder);
    expect(got.status).toBe(200);
    const order = got.body.data.orders.find((o: { _id: string }) => o._id === s.barOrder);
    expect(order).toMatchObject({ status: 'collected', handedOutBy: s.barTill.merchantOperatorId, acceptedBy: s.waiter.waiterId });
    expect(order.handedOutAt).toBeTruthy();
    expect(order.acceptedAt).toBeTruthy();
  });

  it('guards each step: no double hand-out, no accept before hand-out, no other stall', async () => {
    const s = await served();
    const early = await accept(s.waiter.auth, s.tableId, s.barOrder);
    expect(early.status).toBe(409);
    expect(early.body.message).toBe('that handover is sent, not handed_out');
    const wrongStall = await handOut(s.kitchenTill.auth, s.tableId, s.barOrder);
    expect(wrongStall.status).toBe(404);
    expect((await handOut(s.barTill.auth, s.tableId, s.barOrder)).status).toBe(200);
    const twice = await handOut(s.barTill.auth, s.tableId, s.barOrder);
    expect(twice.status).toBe(409);
    expect(twice.body.message).toBe('that handover is handed_out, not sent');
    const junk = await handOut(s.barTill.auth, 'junk', s.barOrder);
    expect(junk.status).toBe(404);
  });

  it("another venue's till and another waiter cannot move it", async () => {
    const s = await served();
    const elsewhere = await seedVenue();
    const otherStall = await seedVenueStall(elsewhere.venueId, { price: 100, onHand: 1 });
    const otherTill = await seedVenueTill(elsewhere, otherStall.merchantId);
    expect((await handOut(otherTill.auth, s.tableId, s.barOrder)).status).toBe(404);
    await handOut(s.barTill.auth, s.tableId, s.barOrder);
    const colleague = await seedVenueWaiter(s.venue);
    expect((await accept(colleague.auth, s.tableId, s.barOrder)).status).toBe(404);
    const stored = await Table.findById(s.tableId).lean();
    expect(stored?.orders?.find((o) => String(o._id) === s.barOrder)?.status).toBe('handed_out');
  });
});

describe('removing a line', () => {
  it('takes a line off while its round is still at the bar, and the stock goes back', async () => {
    const s = await served();
    const res = await remove(s.waiter.auth, s.tableId, s.beerLine);
    expect(res.status).toBe(200);
    expect(res.body.data.subtotal).toBe(9000);
    expect(res.body.data.items.map((l: { name: string }) => l.name)).toEqual(['Burger']);
    // the bar's order had only that line, so the order is gone too
    expect(res.body.data.orders.map((o: { _id: string }) => o._id)).toEqual([s.kitchenOrder]);
    expect(await StockService.getOnHand(s.bar.merchantId, s.bar.productId)).toBe(10);
    expect((await queue(s.barTill.auth, 'sent')).body.data.orders).toHaveLength(0);
  });

  it('refuses once the round has been handed out — it was served', async () => {
    const s = await served();
    await handOut(s.barTill.auth, s.tableId, s.barOrder);
    const res = await remove(s.waiter.auth, s.tableId, s.beerLine);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('that round has already been handed out');
    expect((await Table.findById(s.tableId))!.subtotal).toBe(14000);
    expect(await StockService.getOnHand(s.bar.merchantId, s.bar.productId)).toBe(8);
  });

  it('refuses a line that is partly paid', async () => {
    const s = await served();
    await Table.updateOne({ _id: s.tableId, 'items._id': s.beerLine }, { $set: { 'items.$.paidQty': 1, paidTotal: 2500 } });
    const res = await remove(s.waiter.auth, s.tableId, s.beerLine);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('that item is already paid for');
  });

  it('answers 404 for a line that is not on the table', async () => {
    const s = await served();
    const res = await remove(s.waiter.auth, s.tableId, '000000000000000000000001');
    expect(res.status).toBe(404);
  });
});
```
(also import `MerchantOperator` from `@models/merchantOperator.model` — the event till needs a real operator row, because `authenticateMerchant` re-reads it on every request.)

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueHandover.route.test.ts --runInBand`
Expected: FAIL — `/api/merchant/orders` is 404.

- [ ] **Step 3: One guarded "advance a row" for both kinds of table**

`src/services/table.service.ts` — add, above `advanceFulfilment`, and export it:

```ts
/**
 * Move ONE row of a table's array from one status to the next, atomically —
 * shared by an event table's `fulfilment` rows and a venue table's `orders`.
 * Null when nothing matched; the caller diagnoses why.
 */
export async function advanceArrayRow(params: {
  /** The table itself: its id, its owner, and any status it must be in. */
  table: Record<string, unknown>;
  array: 'fulfilment' | 'orders';
  /** What identifies the row inside the array. */
  row: Record<string, unknown>;
  from: string;
  to: string;
  stamp: Record<string, unknown>;
}): Promise<ITable | null> {
  const { table, array, row, from, to, stamp } = params;
  const set: Record<string, unknown> = { [`${array}.$[row].status`]: to };
  for (const [k, v] of Object.entries(stamp)) set[`${array}.$[row].${k}`] = v;
  const arrayFilter: Record<string, unknown> = { 'row.status': from };
  for (const [k, v] of Object.entries(row)) arrayFilter[`row.${k}`] = v;
  return Table.findOneAndUpdate(
    { ...table, [array]: { $elemMatch: { ...row, status: from } } },
    { $set: set },
    { new: true, arrayFilters: [arrayFilter] },
  );
}
```
and make `advanceFulfilment` use it — its `findOneAndUpdate` becomes:

```ts
  const updated = await advanceArrayRow({
    table: { _id: tableObjId, eventId: eventObjId, status: 'settled' },
    array: 'fulfilment', row: { merchantId: merchantObjId }, from, to, stamp,
  });
```
(its diagnosis below is unchanged; the existing `tableFulfilment` and `tableHandover` suites prove it.)

- [ ] **Step 4: Orders in the venue table service**

`src/services/venueTable.service.ts` — import `advanceArrayRow, TableFulfilmentNotFoundError, TableFulfilmentStateError` from `@services/table.service`, `Waiter` model, `TableOrderStatus`, and add above the class:

```ts
/** A line that can no longer be taken off the bill. */
export class LineLockedError extends Error {
  constructor(message: string) { super(message); this.name = 'LineLockedError'; }
}

export interface StallOrderView {
  tableId: string; tableLabel: string; orderId: string; status: TableOrderStatus;
  sentAt: Date; handedOutAt?: Date; acceptedAt?: Date; waiterName: string;
  items: Array<{ name: string; qty: number; unitPrice: number }>; total: number;
}
```

Inside the class:

```ts
  /**
   * One stall's queue: the rounds waiters have sent it, carrying only that
   * stall's own lines. `sent` reads oldest first (the next one to make).
   */
  static async ordersForStall(params: { venueId: string; merchantId: string; status?: TableOrderStatus }): Promise<StallOrderView[]> {
    const { status } = params;
    const merchantId = oid(params.merchantId);
    const tables = await Table.find({
      venueId: oid(params.venueId),
      orders: { $elemMatch: { merchantId, ...(status ? { status } : {}) } },
    }).sort({ updatedAt: -1 }).limit(200).lean<ITable[]>();

    const waiterIds = [...new Set(tables.flatMap((t) => (t.orders ?? []).map((o) => o.sentBy)))].filter((id) => mongoose.isValidObjectId(id));
    const waiters = await Waiter.find({ _id: { $in: waiterIds.map(oid) } }, { fullName: 1 }).lean<{ _id: mongoose.Types.ObjectId; fullName: string }[]>();
    const nameOf = new Map(waiters.map((w) => [String(w._id), w.fullName]));

    const views = tables.flatMap((t) => (t.orders ?? [])
      .filter((o) => String(o.merchantId) === params.merchantId && (!status || o.status === status))
      .map((o): StallOrderView => {
        const items = t.items.filter((l) => String(l.orderId) === String(o._id)).map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice }));
        return {
          tableId: String(t._id), tableLabel: t.label, orderId: String(o._id), status: o.status,
          sentAt: o.sentAt, ...(o.handedOutAt ? { handedOutAt: o.handedOutAt } : {}), ...(o.acceptedAt ? { acceptedAt: o.acceptedAt } : {}),
          waiterName: nameOf.get(o.sentBy) ?? 'Unknown waiter',
          items, total: items.reduce((sum, l) => sum + l.unitPrice * l.qty, 0),
        };
      }));
    const time = (v: StallOrderView) => new Date(v.sentAt).getTime();
    return views.sort((a, b) => (status === 'sent' ? time(a) - time(b) : time(b) - time(a)));
  }

  /** The stall hands a round over the counter. `sent` → `handed_out`. */
  static async handOutOrder(params: { venueId: string; tableId: string; orderId: string; merchantId: string; handedOutBy: string }): Promise<ITable> {
    return VenueTableService.advanceOrder({
      ...params, row: { _id: oid(params.orderId), merchantId: oid(params.merchantId) },
      from: 'sent', to: 'handed_out', stamp: { handedOutAt: new Date(), handedOutBy: params.handedOutBy },
    });
  }

  /** The waiter takes it. `handed_out` → `collected`. */
  static async acceptOrder(params: { venueId: string; tableId: string; orderId: string; acceptedBy: string }): Promise<ITable> {
    return VenueTableService.advanceOrder({
      ...params, row: { _id: oid(params.orderId) },
      from: 'handed_out', to: 'collected', stamp: { acceptedAt: new Date(), acceptedBy: params.acceptedBy },
    });
  }

  private static async advanceOrder(params: {
    venueId: string; tableId: string; orderId: string; row: Record<string, unknown>;
    from: TableOrderStatus; to: TableOrderStatus; stamp: Record<string, unknown>;
  }): Promise<ITable> {
    const mine = { _id: oid(params.tableId), venueId: oid(params.venueId) };
    const updated = await advanceArrayRow({ table: mine, array: 'orders', row: params.row, from: params.from, to: params.to, stamp: params.stamp });
    if (updated) return updated;
    // Why not? A row of another stall reads exactly like a missing one.
    const current = await Table.findOne(mine).lean<ITable | null>();
    const row = current?.orders?.find((o) => String(o._id) === params.orderId
      && (!params.row['merchantId'] || String(o.merchantId) === String(params.row['merchantId'])));
    if (!row) throw new TableFulfilmentNotFoundError();
    throw new TableFulfilmentStateError(row.status as any, params.from as any);
  }

  /**
   * Take a line off the bill — only while its round is still at the counter
   * (`sent`) and nothing has been paid against it. Its stock goes back. An
   * order left with no lines is removed with it.
   */
  static async removeLine(params: { venueId: string; tableId: string; lineId: string; removedBy: string }): Promise<ITable> {
    const venueId = oid(params.venueId);
    const mine = { _id: oid(params.tableId), venueId };
    const lineId = oid(params.lineId);

    const table = await Table.findOne(mine);
    if (!table) throw new Error('table not found');
    const line = table.items.find((l) => String(l._id) === params.lineId);
    if (!line) throw new Error('line not found on this table');
    if (table.status !== 'open') throw new Error(`table is not open (status: ${table.status})`);
    if ((line.paidQty ?? 0) > 0) throw new LineLockedError('that item is already paid for');
    const order = (table.orders ?? []).find((o) => String(o._id) === String(line.orderId));
    if (!order || order.status !== 'sent') throw new LineLockedError('that round has already been handed out');

    const session = await mongoose.startSession();
    let result: ITable | undefined;
    try {
      await session.withTransaction(async () => {
        const updated = await Table.findOneAndUpdate(
          {
            ...mine, status: 'open',
            items: { $elemMatch: { _id: lineId, paidQty: 0 } },
            orders: { $elemMatch: { _id: order._id, status: 'sent' } },
          },
          { $pull: { items: { _id: lineId }, 'orders.$[order].lineIds': lineId }, $inc: { subtotal: -(line.unitPrice * line.qty), revision: 1 } },
          { new: true, session, arrayFilters: [{ 'order._id': order._id }] },
        );
        // It moved between the read and the write: handed out, paid, or closed.
        if (!updated) throw new LineLockedError('that item can no longer be removed — refresh the table');
        const emptied = await Table.findOneAndUpdate(
          { ...mine, orders: { $elemMatch: { _id: order._id, lineIds: { $size: 0 } } } },
          { $pull: { orders: { _id: order._id } } },
          { new: true, session },
        );
        await StockService.applyMovement({
          venueId, merchantId: line.merchantId, productId: line.productId, delta: line.qty,
          reason: StockMovementReason.MANUAL, refType: 'table_line_removed', refId: params.lineId,
          byType: 'Waiter', by: params.removedBy, session,
        });
        result = emptied ?? updated;
      });
    } finally {
      await session.endSession();
    }
    return result!;
  }
```

- [ ] **Step 5: The till's handlers**

`src/controllers/venueTill.controller.ts`:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { MerchantToken } from '@interfaces/merchant.interface';
import { HEX24 } from '@utils/controllerHelpers.util';
import { VENUE_ONLY } from '@middleware/waiterKind.middleware';
import { VenueTableService } from '@services/venueTable.service';
import { TableFulfilmentNotFoundError, TableFulfilmentStateError } from '@services/table.service';

const ORDER_STATUSES = ['sent', 'handed_out', 'collected'] as const;

export interface VenueTill { venueId: string; merchantId: string; merchantOperatorId: string; operatorName: string; merchantName: string; vendorId: string }

/** The venue till behind this request — or null after a 403 for an EVENT till. */
export function venueTillOf(req: Request, res: Response): VenueTill | null {
  const m = (req as any).merchant as MerchantToken;
  if (!m.venueId) { ApiResponseUtil.forbidden(res, VENUE_ONLY); return null; }
  return {
    venueId: m.venueId, merchantId: m.merchantId, merchantOperatorId: m.merchantOperatorId,
    operatorName: m.operatorName, merchantName: m.name,
    vendorId: String(((req as any).merchantVenue as { vendorId: unknown }).vendorId),
  };
}

/**
 * The venue till (venue trading Phase 3): the rounds waiters send it, and
 * counter sales. Handlers answer; they never throw.
 */
export class VenueTillController {
  /** GET /api/merchant/orders?status= — this stall's queue. */
  static async orders(req: Request, res: Response): Promise<any> {
    const till = venueTillOf(req, res);
    if (!till) return;
    const raw = req.query['status'];
    const status = ORDER_STATUSES.find((s) => s === raw);
    if (raw !== undefined && !status) return ApiResponseUtil.badRequest(res, 'Unknown order status');
    const orders = await VenueTableService.ordersForStall({ venueId: till.venueId, merchantId: till.merchantId, status });
    return ApiResponseUtil.success(res, { orders });
  }

  /** POST /api/merchant/tables/:tableId/orders/:orderId/hand-out — the round leaves the counter. */
  static async handOut(req: Request, res: Response): Promise<any> {
    const till = venueTillOf(req, res);
    if (!till) return;
    const tableId = String(req.params['tableId']);
    const orderId = String(req.params['orderId']);
    if (!HEX24.test(tableId) || !HEX24.test(orderId)) return ApiResponseUtil.notFound(res, 'no handover for this stall on that table');
    try {
      await VenueTableService.handOutOrder({ venueId: till.venueId, tableId, orderId, merchantId: till.merchantId, handedOutBy: till.merchantOperatorId });
      const orders = await VenueTableService.ordersForStall({ venueId: till.venueId, merchantId: till.merchantId, status: 'handed_out' });
      const view = orders.find((o) => o.orderId === orderId);
      // The row was just moved by this request; not finding it is a real fault.
      if (!view) return ApiResponseUtil.error(res, 'The order was handed out but could not be read back', 500);
      return ApiResponseUtil.success(res, view);
    } catch (e: any) {
      if (e instanceof TableFulfilmentNotFoundError) return ApiResponseUtil.notFound(res, e.message);
      if (e instanceof TableFulfilmentStateError) return ApiResponseUtil.error(res, e.message, 409);
      console.error('Hand-out failed', e);
      return ApiResponseUtil.error(res, e?.message || 'Could not hand out the order', 500);
    }
  }
}
```

`src/controllers/merchant.controller.ts` — change the constant: `const NO_VENUE_TABLES = 'Venue tills hand out orders, not tables';`.

`src/routes/__tests__/venueTill.route.test.ts` — the ONE assertion that pins the old copy: `expect(tables.body.message).toBe('Venue table service is not available yet')` → `.toBe('Venue tills hand out orders, not tables')`. Nothing else in that file changes.

`src/routes/merchant.route.ts` — import `VenueTillController` and `asyncHandler`; add after the event `/tables` routes:

```ts
// Venue tills: the rounds waiters send this stall (event tills use /tables above).
router.get('/orders', requireMerchantPermission(MerchantPermission.CHARGE), asyncHandler(VenueTillController.orders));
router.post('/tables/:tableId/orders/:orderId/hand-out', requireMerchantPermission(MerchantPermission.CHARGE), asyncHandler(VenueTillController.handOut));
```

- [ ] **Step 6: The waiter's accept and remove**

`src/controllers/venueWaiter.controller.ts` — import `LineLockedError`, `TableFulfilmentNotFoundError`, `TableFulfilmentStateError`. In `answerTableError`, with the other class checks:

```ts
  if (e instanceof LineLockedError || e instanceof TableFulfilmentStateError) return ApiResponseUtil.error(res, e.message, 409);
  if (e instanceof TableFulfilmentNotFoundError) return ApiResponseUtil.notFound(res, e.message);
```
and after the `table not found` check add `if (/line not found/i.test(message)) return ApiResponseUtil.notFound(res, message);`.

Add the handlers:

```ts
  /** POST /api/waiter/tables/:id/orders/:orderId/accept — the waiter collects a handed-out round. */
  static async acceptOrder(req: Request, res: Response): Promise<any> {
    const tableId = String(req.params['id']);
    const orderId = String(req.params['orderId']);
    if (!(await mayWorkTable(req, res, tableId))) return;
    if (!HEX24.test(orderId)) return ApiResponseUtil.notFound(res, 'no handover for this stall on that table');
    try {
      const table = await VenueTableService.acceptOrder({ venueId: venueIdOf(req), tableId, orderId, acceptedBy: waiterOf(req).waiterId });
      return ApiResponseUtil.success(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not accept the order'); }
  }

  /** DELETE /api/waiter/tables/:id/items/:lineId — only while the round is still at the counter. */
  static async removeLine(req: Request, res: Response): Promise<any> {
    const tableId = String(req.params['id']);
    const lineId = String(req.params['lineId']);
    if (!(await mayWorkTable(req, res, tableId))) return;
    if (!HEX24.test(lineId)) return ApiResponseUtil.notFound(res, 'line not found on this table');
    try {
      const table = await VenueTableService.removeLine({ venueId: venueIdOf(req), tableId, lineId, removedBy: waiterOf(req).waiterId });
      return ApiResponseUtil.success(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not remove that line'); }
  }
```

`src/routes/waiter.route.ts`:

```ts
router.delete('/tables/:id/items/:lineId', …, byWaiterKind(WaiterController.removeItem, asyncHandler(VenueWaiterController.removeLine)));
router.post('/tables/:id/orders/:orderId/accept', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(venueOnly, asyncHandler(VenueWaiterController.acceptOrder)));
```

- [ ] **Step 7: Run new + existing handover suites — expect PASS**

Run:
```bash
npx jest src/routes/__tests__/venueHandover.route.test.ts src/routes/__tests__/venueRounds.route.test.ts src/routes/__tests__/venueTill.route.test.ts src/routes/__tests__/tableHandover.route.test.ts src/services/__tests__/tableFulfilment.test.ts src/routes/__tests__/waiterTables.route.test.ts --runInBand
npx tsc --noEmit -p .
```
Expected: all pass. The only existing-test edit is the one refusal string in `venueTill.route.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/services/table.service.ts src/services/venueTable.service.ts src/controllers/venueTill.controller.ts src/controllers/merchant.controller.ts src/controllers/venueWaiter.controller.ts src/routes/merchant.route.ts src/routes/waiter.route.ts src/routes/__tests__/venueHandover.route.test.ts src/routes/__tests__/venueTill.route.test.ts
git commit -m "feat(venue): handover — the till's order queue, hand-out, waiter accept; lines removable only while sent"
```

---
### Task 8: Paying a table — mixed tenders, tips, split by guest; the closing payment writes each stall its takings

**Files:**
- Create: `src/utils/tenders.util.ts`, `src/utils/__tests__/tenders.util.test.ts`
- Modify: `src/validators/venueSelling.validator.ts`
- Modify: `src/services/venueTable.service.ts`, `src/controllers/venueWaiter.controller.ts`, `src/routes/waiter.route.ts`
- Test: `src/routes/__tests__/venueTablePayments.route.test.ts`

**Interfaces:**
- Consumes: Task 1 (`VenuePayment`, `Table.paidTotal`, `items[].paidQty`, venue `MerchantCharge`); Task 6 rounds; `TableAlreadySettledError(status)` from `@services/table.service` (message `table is already settled` / `table is not open (status: <s>)`); `MAX_CHARGE_CENTS` from `@services/merchant.service`.
- Produces:
  - `TenderInput { method: 'cash' | 'card'; amount: number; tip?: number; reference?: string }`, `normalizeTenders(input): IVenueTender[]`, `sumTenders(tenders): { applied; tips; cash; card; cashTips; cardTips }`
  - Joi: `tendersSchema` (1–4 tenders; `amount` 0–`MAX_CHARGE_CENTS`; `tip` ≥ 0 default 0; `reference` ≤ 64 chars), `tablePaymentSchema { clientTxnId, tenders, lines?: [{ lineId, qty }] }`
  - `VenueTableService.pay(params: { venueId; tableId; clientTxnId; tenders: TenderInput[]; lines?: { lineId: string; qty: number }[]; takenBy: string; staffName: string }): Promise<{ payment: IVenuePayment; table: ITable; closed: boolean }>`
  - Errors: `PaymentRefusedError { reason; detail }` (400), `BillChangedError { reason: 'bill_changed' }` (409, message `the bill changed — check the balance`), `PaymentIdempotencyMismatchError { reason: 'idempotency_mismatch' }` (409)
  - `POST /api/waiter/tables/:id/payments` (needs `waiter:settle_tables`) → 200 `{ payment, table, closed }`
  - A closing payment writes, in the same transaction, one venue `MerchantCharge` per stall: `clientTxnId: '<paymentClientTxnId>:<merchantId>'`, `fee: 0`, `netAmount === amount`, `waiterId` = the table's waiter (`openedBy`), `staffName` = that waiter's name.

Rules, all enforced by ONE guarded update on the table (`status: 'open'`, the `revision` and `paidTotal` that were read):
- `applied` (Σ tender amounts) is ≥ 1 and ≤ the balance (`subtotal − paidTotal`). Anything over is a tip or change — never an overpayment.
- With `lines`: each line is paid at most up to its unpaid quantity, and the tenders must add up to exactly those items.
- A retried `clientTxnId` returns the original payment; the same id for a different table or amount is refused.
- Two payments racing for the same balance: one wins, the other gets 409 `the bill changed — check the balance`.

- [ ] **Step 1: Write the failing tests**

`src/utils/__tests__/tenders.util.test.ts`:

```ts
import { normalizeTenders, sumTenders } from '@utils/tenders.util';

describe('tenders', () => {
  it('defaults a missing tip to 0 and keeps a reference only on a card tender', () => {
    expect(normalizeTenders([
      { method: 'cash', amount: 3000, reference: 'ignored' },
      { method: 'card', amount: 4500, tip: 500, reference: ' 0192 ' },
      { method: 'card', amount: 100, reference: '  ' },
    ])).toEqual([
      { method: 'cash', amount: 3000, tip: 0 },
      { method: 'card', amount: 4500, tip: 500, reference: '0192' },
      { method: 'card', amount: 100, tip: 0 },
    ]);
  });
  it('sums what came off the bill separately from tips, by method', () => {
    expect(sumTenders([
      { method: 'cash', amount: 3000, tip: 200 }, { method: 'card', amount: 4500, tip: 500 }, { method: 'cash', amount: 500, tip: 0 },
    ])).toEqual({ applied: 8000, tips: 700, cash: 3500, card: 4500, cashTips: 200, cardTips: 500 });
  });
});
```

`src/routes/__tests__/venueTablePayments.route.test.ts`:

```ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, seedVenueStall, seedVenueWaiter, venueDashboardAuth } from '@/__tests__/helpers/venueFloor';
import { Table } from '@models/table.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { VenuePayment } from '@models/venuePayment.model';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/** Table 7: 2 beers (E25 each, Main Bar) + 1 burger (E90, Kitchen) = 14000. */
async function bill() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const kitchen = await seedVenueStall(venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
  const waiter = await seedVenueWaiter(venue, { fullName: 'Sipho' });
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  const round = await request(app).post(`/api/waiter/tables/${tableId}/orders`).set('Authorization', waiter.auth)
    .send({ clientTxnId: 'r1', items: [{ ...bar, qty: 2 }, { ...kitchen, qty: 1 }] });
  const beerLine = round.body.data.items.find((l: { name: string }) => l.name === 'Castle Lite')._id as string;
  const pay = (body: unknown, auth = waiter.auth) => request(app).post(`/api/waiter/tables/${tableId}/payments`).set('Authorization', auth).send(body as object);
  return { venue, bar, kitchen, waiter, tableId, beerLine, pay };
}
const cash = (amount: number, tip?: number) => ({ method: 'cash', amount, ...(tip ? { tip } : {}) });
const card = (amount: number, tip?: number, reference?: string) => ({ method: 'card', amount, ...(tip ? { tip } : {}), ...(reference ? { reference } : {}) });

describe('paying a venue table', () => {
  it('one payment — cash and card, with a card tip — closes the table and writes each stall its takings', async () => {
    const b = await bill();
    const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(5000), card(9000, 1000, '0192')] });
    expect(res.status).toBe(200);
    expect(res.body.data.closed).toBe(true);
    expect(res.body.data.table).toMatchObject({ status: 'settled', subtotal: 14000, paidTotal: 14000 });
    expect(res.body.data.payment).toMatchObject({ source: 'table', tableLabel: '7', applied: 14000, tips: 1000, staffName: 'Sipho', takenByType: 'Waiter' });
    expect(res.body.data.payment.tenders).toEqual([{ method: 'cash', amount: 5000, tip: 0 }, { method: 'card', amount: 9000, tip: 1000, reference: '0192' }]);

    const charges = await MerchantCharge.find({ venueId: b.venue.venueId }).lean();
    expect(charges).toHaveLength(2);
    const barCharge = charges.find((c) => String(c.merchantId) === b.bar.merchantId)!;
    expect(barCharge).toMatchObject({ amount: 5000, fee: 0, netAmount: 5000, staffName: 'Sipho', clientTxnId: `p1:${b.bar.merchantId}`, status: 'completed' });
    expect(String(barCharge.waiterId)).toBe(b.waiter.waiterId);
    expect(barCharge.walletId).toBeUndefined();
    expect(barCharge.eventId).toBeUndefined();
    expect(barCharge.items).toEqual([expect.objectContaining({ name: 'Castle Lite', qty: 2, unitPrice: 2500, lineTotal: 5000 })]);
    // tips never reach a stall's takings
    expect(charges.reduce((sum, c) => sum + c.amount, 0)).toBe(14000);
    // the table number is free again
    expect((await request(app).post('/api/waiter/tables').set('Authorization', b.waiter.auth).send({ label: '7' })).status).toBe(201);
  });

  it('a part payment leaves the table open; the rest closes it and takings are written once', async () => {
    const b = await bill();
    const first = await b.pay({ clientTxnId: 'p1', tenders: [cash(4000)] });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ closed: false, table: { status: 'open', paidTotal: 4000 } });
    expect(await MerchantCharge.countDocuments()).toBe(0);
    const rest = await b.pay({ clientTxnId: 'p2', tenders: [card(10000)] });
    expect(rest.body.data).toMatchObject({ closed: true, table: { status: 'settled', paidTotal: 14000 } });
    expect(await MerchantCharge.countDocuments()).toBe(2);
    expect(await VenuePayment.countDocuments({ tableId: b.tableId })).toBe(2);
  });

  it("pays for a guest's items and marks them paid", async () => {
    const b = await bill();
    const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(2500)], lines: [{ lineId: b.beerLine, qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.payment.lines).toEqual([{ lineId: b.beerLine, qty: 1 }]);
    expect(res.body.data.table.items.find((l: { _id: string }) => l._id === b.beerLine).paidQty).toBe(1);
    expect(res.body.data.table.paidTotal).toBe(2500);

    const tooMany = await b.pay({ clientTxnId: 'p2', tenders: [cash(5000)], lines: [{ lineId: b.beerLine, qty: 2 }] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toBe('only 1 of Castle Lite left to pay');
    expect(JSON.parse(tooMany.body.error)).toMatchObject({ reason: 'line_overpaid', unpaid: 1 });

    const wrongTotal = await b.pay({ clientTxnId: 'p3', tenders: [cash(2000)], lines: [{ lineId: b.beerLine, qty: 1 }] });
    expect(wrongTotal.status).toBe(400);
    expect(wrongTotal.body.message).toBe('the payment must equal the selected items');

    const unknownLine = await b.pay({ clientTxnId: 'p4', tenders: [cash(2500)], lines: [{ lineId: '000000000000000000000001', qty: 1 }] });
    expect(unknownLine.status).toBe(400);
    expect((await Table.findById(b.tableId))!.paidTotal).toBe(2500);
  });

  it('refuses more than the balance, and a payment that takes nothing off the bill', async () => {
    const b = await bill();
    const over = await b.pay({ clientTxnId: 'p1', tenders: [cash(15000)] });
    expect(over.status).toBe(400);
    expect(over.body.message).toBe('that is more than the balance on this table');
    expect(JSON.parse(over.body.error)).toMatchObject({ reason: 'exceeds_balance', outstanding: 14000 });
    const nothing = await b.pay({ clientTxnId: 'p2', tenders: [cash(0, 500)] });
    expect(nothing.status).toBe(400);
    expect(nothing.body.message).toBe('a payment must take something off the bill');
    for (const body of [{ tenders: [cash(100)] }, { clientTxnId: 'p3', tenders: [] }, { clientTxnId: 'p3', tenders: [{ method: 'momo', amount: 100 }] }, { clientTxnId: 'p3', tenders: [cash(-1)] }]) {
      expect((await b.pay(body)).status).toBe(400);
    }
    expect(await VenuePayment.countDocuments()).toBe(0);
    expect((await Table.findById(b.tableId))!.paidTotal).toBe(0);
  });

  it('a retried payment is taken once; the same id for a different amount is refused', async () => {
    const b = await bill();
    const body = { clientTxnId: 'p1', tenders: [cash(4000)] };
    const first = await b.pay(body);
    const again = await b.pay(body);
    expect(again.status).toBe(200);
    expect(again.body.data.payment._id).toBe(first.body.data.payment._id);
    expect(again.body.data.table.paidTotal).toBe(4000);
    expect(await VenuePayment.countDocuments()).toBe(1);
    const different = await b.pay({ clientTxnId: 'p1', tenders: [cash(5000)] });
    expect(different.status).toBe(409);
    expect(JSON.parse(different.body.error)).toMatchObject({ reason: 'idempotency_mismatch' });
  });

  it('two devices paying the whole balance at once: one wins, the table closes once', async () => {
    const b = await bill();
    const lead = await seedVenueWaiter(b.venue, { fullName: 'Lead', grants: [OperatorGrant.SETTLE_TABLES, OperatorGrant.MANAGE_ALL_TABLES] });
    const [x, y] = await Promise.all([
      b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] }),
      b.pay({ clientTxnId: 'p2', tenders: [card(14000)] }, lead.auth),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(['the bill changed — check the balance', 'table is already settled']).toContain(loser.body.message);
    expect(await VenuePayment.countDocuments()).toBe(1);
    expect(await MerchantCharge.countDocuments()).toBe(2);
    expect((await Table.findById(b.tableId))!.paidTotal).toBe(14000);
  });

  it('a balance that moved between reading the bill and paying it is refused: the bill changed', async () => {
    const b = await bill();
    const real = Table.findOneAndUpdate.bind(Table);
    // Another device's payment lands after this one read the bill, and before it writes.
    const spy = jest.spyOn(Table, 'findOneAndUpdate').mockImplementationOnce(((...args: unknown[]) =>
      Table.updateOne({ _id: b.tableId }, { $inc: { paidTotal: 1000 } }).then(() => (real as any)(...args))) as any);
    try {
      const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(4000)] });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('the bill changed — check the balance');
      expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'bill_changed' });
    } finally {
      spy.mockRestore();
    }
    expect(await VenuePayment.countDocuments()).toBe(0);
    expect((await Table.findById(b.tableId))!.paidTotal).toBe(1000);
  });

  it('a round added after the bill was quoted grows the balance — the old total no longer closes it', async () => {
    const b = await bill();
    await request(app).post(`/api/waiter/tables/${b.tableId}/orders`).set('Authorization', b.waiter.auth).send({ clientTxnId: 'r2', items: [{ ...b.bar, qty: 1 }] });
    const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ closed: false, table: { subtotal: 16500, paidTotal: 14000, status: 'open' } });
    const rest = await b.pay({ clientTxnId: 'p2', tenders: [cash(2500)] });
    expect(rest.body.data.closed).toBe(true);
    expect((await MerchantCharge.findOne({ merchantId: b.bar.merchantId }).lean())!.amount).toBe(7500);
  });

  it('needs the take-payment switch; refuses a closed table and another waiter', async () => {
    const b = await bill();
    const server = await seedVenueWaiter(b.venue, { fullName: 'Server', grants: [] });
    const noGrant = await b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] }, server.auth);
    expect(noGrant.status).toBe(403);
    expect(noGrant.body.message).toBe('Permission required: waiter:settle_tables');
    const colleague = await seedVenueWaiter(b.venue);
    expect((await b.pay({ clientTxnId: 'p2', tenders: [cash(14000)] }, colleague.auth)).status).toBe(404);
    expect(await VenuePayment.countDocuments()).toBe(0);
    await b.pay({ clientTxnId: 'p3', tenders: [cash(14000)] });
    const closed = await b.pay({ clientTxnId: 'p4', tenders: [cash(100)] });
    expect(closed.status).toBe(409);
    expect(closed.body.message).toBe('table is already settled');
  });

  it('once the table is paid, the stock board shows what was sold', async () => {
    const b = await bill();
    await b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] });
    const board = await request(app).get('/api/tickets/venue/stock/board').set('Authorization', venueDashboardAuth(b.venue));
    expect(board.status).toBe(200);
    expect(board.body.data.byProduct.find((r: { productId: string }) => r.productId === b.bar.productId)).toMatchObject({ unitsSold: 2, revenue: 5000, totalOnHand: 8 });
  });
});
```

- [ ] **Step 2: Run them — expect FAIL**

Run: `npx jest src/utils/__tests__/tenders.util.test.ts src/routes/__tests__/venueTablePayments.route.test.ts --runInBand`
Expected: FAIL — `@utils/tenders.util` missing; `/payments` is 404.

- [ ] **Step 3: Tenders**

`src/utils/tenders.util.ts`:

```ts
import { IVenueTender, TenderMethod } from '@interfaces/venuePayment.interface';

/** A tender as the POS sends it. */
export interface TenderInput { method: TenderMethod; amount: number; tip?: number; reference?: string }

/** As stored: a tip defaults to 0; a slip reference is kept only on a card tender, and only if there is one. */
export function normalizeTenders(input: TenderInput[]): IVenueTender[] {
  return input.map((t) => {
    const reference = t.method === 'card' ? (t.reference ?? '').trim() : '';
    return { method: t.method, amount: t.amount, tip: t.tip ?? 0, ...(reference ? { reference } : {}) };
  });
}

export interface TenderSums { applied: number; tips: number; cash: number; card: number; cashTips: number; cardTips: number }

/** `applied` is what came off the bill; tips are counted apart, per method (the day close needs both). */
export function sumTenders(tenders: ReadonlyArray<{ method: TenderMethod; amount: number; tip: number }>): TenderSums {
  const sums: TenderSums = { applied: 0, tips: 0, cash: 0, card: 0, cashTips: 0, cardTips: 0 };
  for (const t of tenders) {
    sums.applied += t.amount;
    sums.tips += t.tip;
    sums[t.method] += t.amount;
    sums[t.method === 'cash' ? 'cashTips' : 'cardTips'] += t.tip;
  }
  return sums;
}
```

`src/validators/venueSelling.validator.ts` — add (imports: `TENDER_METHODS` from `@interfaces/venuePayment.interface`, `MAX_CHARGE_CENTS` from `@services/merchant.service`):

```ts
const money = Joi.number().integer().min(0).max(MAX_CHARGE_CENTS);

/** One or more ways a payment was made. A tip rides on its tender. */
export const tendersSchema = Joi.array().items(Joi.object({
  method: Joi.string().valid(...TENDER_METHODS).required(),
  amount: money.required(),
  tip: money.default(0),
  reference: Joi.string().trim().max(64).allow(''),
})).min(1).max(4).required();

/** POST /api/waiter/tables/:id/payments — `lines` only when the guest pays for specific items. */
export const tablePaymentSchema = Joi.object({
  clientTxnId,
  tenders: tendersSchema,
  lines: Joi.array().items(Joi.object({ lineId: objectId.required(), qty })).min(1).max(MAX_LINES),
});
```

- [ ] **Step 4: `pay`**

`src/services/venueTable.service.ts` — imports: `VenuePayment`, `MerchantCharge`, `IVenuePayment`, `TableAlreadySettledError`, `TenderInput, normalizeTenders, sumTenders`. Above the class:

```ts
/** A payment the bill does not allow. 400 — nothing is written. */
export class PaymentRefusedError extends Error {
  constructor(message: string, public reason: string, public detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PaymentRefusedError';
  }
}

/** The balance moved while this payment was being taken: a round landed, or someone else paid. */
export class BillChangedError extends Error {
  readonly reason = 'bill_changed';
  constructor() { super('the bill changed — check the balance'); this.name = 'BillChangedError'; }
}

export class PaymentIdempotencyMismatchError extends Error {
  readonly reason = 'idempotency_mismatch';
  constructor() { super('that payment id was already used for a different payment'); this.name = 'PaymentIdempotencyMismatchError'; }
}

/** Control flow: this clientTxnId already committed (a retry). */
class ReplayedPayment extends Error {}

export interface TablePayment { payment: IVenuePayment; table: ITable; closed: boolean }
```

Inside the class:

```ts
  /**
   * Take a payment against a venue table. ONE transaction: the guarded table
   * update, the VenuePayment and — when it brings the bill to zero — one
   * MerchantCharge per stall. A table takes any number of payments; the one
   * that pays it off closes it, exactly once.
   */
  static async pay(params: {
    venueId: string; tableId: string; clientTxnId: string; tenders: TenderInput[];
    lines?: Array<{ lineId: string; qty: number }>; takenBy: string; staffName: string;
  }): Promise<TablePayment> {
    const { clientTxnId, takenBy, staffName } = params;
    const venueId = oid(params.venueId);
    const mine = { _id: oid(params.tableId), venueId };
    const tenders = normalizeTenders(params.tenders);
    const { applied, tips } = sumTenders(tenders);

    // A retry returns the payment it already made — never a second one.
    const replay = async (): Promise<TablePayment | null> => {
      const payment = await VenuePayment.findOne({ venueId, clientTxnId });
      if (!payment) return null;
      if (String(payment.tableId) !== params.tableId || payment.applied !== applied) throw new PaymentIdempotencyMismatchError();
      const table = await Table.findOne(mine);
      if (!table) throw new Error('table not found');
      return { payment, table, closed: table.status === 'settled' };
    };
    const earlier = await replay();
    if (earlier) return earlier;

    const table = await Table.findOne(mine);
    if (!table) throw new Error('table not found');
    if (table.status !== 'open') throw new TableAlreadySettledError(table.status);
    if (applied < 1) throw new PaymentRefusedError('a payment must take something off the bill', 'nothing_applied');
    const paidSoFar = table.paidTotal ?? 0;
    const outstanding = table.subtotal - paidSoFar;
    if (applied > outstanding) throw new PaymentRefusedError('that is more than the balance on this table', 'exceeds_balance', { outstanding });

    // Paying for specific items: within what is still unpaid on each line, and
    // the tenders must add up to exactly those items.
    const paying = new Map<string, number>();
    for (const l of params.lines ?? []) paying.set(l.lineId, (paying.get(l.lineId) ?? 0) + l.qty);
    let itemsTotal = 0;
    for (const [lineId, qty] of paying) {
      const line = table.items.find((i) => String(i._id) === lineId);
      if (!line) throw new PaymentRefusedError('line not found on this table', 'line_not_found', { lineId });
      const unpaid = line.qty - (line.paidQty ?? 0);
      if (qty > unpaid) throw new PaymentRefusedError(`only ${unpaid} of ${line.name} left to pay`, 'line_overpaid', { lineId, unpaid });
      itemsTotal += line.unitPrice * qty;
    }
    if (paying.size > 0 && itemsTotal !== applied) throw new PaymentRefusedError('the payment must equal the selected items', 'items_mismatch', { itemsTotal });

    const closing = paidSoFar + applied === table.subtotal;
    // Stall takings are attributed to the table's own waiter, whoever keyed the last payment.
    const tableWaiter = closing ? await Waiter.findById(table.openedBy).select('fullName').lean<{ fullName: string } | null>() : null;
    if (closing && !tableWaiter) throw new Error('the waiter who opened this table was not found');

    const now = new Date();
    const inc: Record<string, number> = { paidTotal: applied };
    const arrayFilters = [...paying.entries()].map(([lineId, qty], i) => {
      inc[`items.$[l${i}].paidQty`] = qty;
      return { [`l${i}._id`]: oid(lineId) };
    });

    const session = await mongoose.startSession();
    let out: TablePayment | undefined;
    try {
      await session.withTransaction(async () => {
        const updated = await Table.findOneAndUpdate(
          // The bill exactly as it was read: any round, removal or payment in between fails this.
          { ...mine, status: 'open', revision: table.revision, paidTotal: paidSoFar },
          { $inc: inc, ...(closing ? { $set: { status: 'settled', settledAt: now, settledBy: takenBy, settleTxnId: clientTxnId } } : {}) },
          { new: true, session, ...(arrayFilters.length ? { arrayFilters } : {}) },
        );
        if (!updated) {
          const current = await Table.findOne(mine).session(session);
          if (!current) throw new Error('table not found');
          if (await VenuePayment.exists({ venueId, clientTxnId }).session(session)) throw new ReplayedPayment();
          if (current.status !== 'open') throw new TableAlreadySettledError(current.status);
          throw new BillChangedError();
        }
        const [payment] = await VenuePayment.create([{
          venueId, source: 'table', tableId: mine._id, tableLabel: table.label,
          merchantIds: [...new Set(table.items.map((i) => String(i.merchantId)))].map(oid),
          clientTxnId, tenders, applied, tips,
          ...(paying.size ? { lines: [...paying.entries()].map(([lineId, qty]) => ({ lineId: oid(lineId), qty })) } : {}),
          takenBy, takenByType: 'Waiter', staffName, at: now,
        }], { session });

        if (closing) {
          const byStall = new Map<string, typeof table.items>();
          for (const line of table.items) byStall.set(String(line.merchantId), [...(byStall.get(String(line.merchantId)) ?? []), line]);
          const charges = [...byStall.entries()].map(([merchantId, lines]) => ({
            merchantId: oid(merchantId), venueId,
            amount: lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0),
            lines,
          })).filter((c) => c.amount >= 1).map((c) => ({
            merchantId: c.merchantId, venueId, amount: c.amount, fee: 0, netAmount: c.amount,
            clientTxnId: `${clientTxnId}:${c.merchantId}`, status: 'completed' as const,
            items: c.lines.map((l) => ({ productId: l.productId, name: l.name, unitPrice: l.unitPrice, qty: l.qty, lineTotal: l.unitPrice * l.qty })),
            waiterId: oid(table.openedBy), staffName: tableWaiter!.fullName,
          }));
          if (charges.length) await MerchantCharge.create(charges, { session });
        }
        out = { payment: payment!, table: updated, closed: closing };
      });
    } catch (e: any) {
      // Committed by an earlier attempt of this same request (or a duplicate key race): hand that one back.
      if (e instanceof ReplayedPayment || e?.code === 11000) {
        const again = await replay();
        if (again) return again;
      }
      throw e;
    } finally {
      await session.endSession();
    }
    return out!;
  }
```
(`Waiter` is already imported from Task 7.)

- [ ] **Step 5: The handler and route**

`src/controllers/venueWaiter.controller.ts` — import `tablePaymentSchema`, `PaymentRefusedError`, `BillChangedError`, `PaymentIdempotencyMismatchError`, `TableAlreadySettledError`. In `answerTableError`, with the class checks:

```ts
  if (e instanceof PaymentRefusedError) return ApiResponseUtil.error(res, e.message, 400, { reason: e.reason, ...e.detail });
  if (e instanceof BillChangedError || e instanceof PaymentIdempotencyMismatchError) return ApiResponseUtil.error(res, e.message, 409, { reason: e.reason });
  if (e instanceof TableAlreadySettledError) return ApiResponseUtil.error(res, e.message, 409);
```

Add:

```ts
  /** POST /api/waiter/tables/:id/payments { clientTxnId, tenders, lines? } — needs waiter:settle_tables. */
  static async pay(req: Request, res: Response): Promise<any> {
    const { error, value } = tablePaymentSchema.validate(req.body ?? {}, { stripUnknown: true });
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const tableId = String(req.params['id']);
    if (!(await mayWorkTable(req, res, tableId))) return;
    try {
      const waiter = waiterOf(req);
      const result = await VenueTableService.pay({
        venueId: venueIdOf(req), tableId, clientTxnId: value.clientTxnId, tenders: value.tenders, lines: value.lines,
        takenBy: waiter.waiterId, staffName: waiter.fullName,
      });
      return ApiResponseUtil.success(res, { payment: result.payment, table: await presentOne(result.table), closed: result.closed });
    } catch (e) { return answerTableError(res, e, 'Could not take the payment'); }
  }
```

`src/routes/waiter.route.ts`:

```ts
// Taking money is the settle grant, exactly as at an event — at a venue it is on by default.
router.post('/tables/:id/payments', requireWaiterPermission(WaiterPermission.SETTLE_TABLES), byWaiterKind(venueOnly, asyncHandler(VenueWaiterController.pay)));
```

- [ ] **Step 6: Run — expect PASS**

Run:
```bash
npx jest src/utils/__tests__/tenders.util.test.ts src/routes/__tests__/venueTablePayments.route.test.ts src/routes/__tests__/venueHandover.route.test.ts src/routes/__tests__/venueRounds.route.test.ts src/routes/__tests__/waiterTables.route.test.ts src/services/__tests__/tableSettle.test.ts src/services/__tests__/stockReport.venue.test.ts --runInBand
npx tsc --noEmit -p .
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/tenders.util.ts src/utils/__tests__/tenders.util.test.ts src/validators/venueSelling.validator.ts src/services/venueTable.service.ts src/controllers/venueWaiter.controller.ts src/routes/waiter.route.ts src/routes/__tests__/venueTablePayments.route.test.ts
git commit -m "feat(venue): table payments — mixed tenders, tips, split by guest; the closing payment writes stall takings once"
```

---

### Task 9: Counter sales at the till

**Files:**
- Modify: `src/validators/venueSelling.validator.ts`
- Create: `src/services/venueSale.service.ts`
- Modify: `src/services/merchant.service.ts` (export `basketKey`), `src/services/stockAlert.service.ts` (drop the unused `eventId` param)
- Modify: `src/controllers/venueTill.controller.ts`, `src/controllers/merchant.controller.ts` (the alert call), `src/controllers/venueWaiter.controller.ts` (a round arms the alert too), `src/routes/merchant.route.ts`
- Modify (mechanical only): `src/services/__tests__/stockAlert.service.test.ts` — drop `eventId: String(eventId), ` from the four `evaluateAfterSale({…})` calls
- Test: `src/routes/__tests__/venueCounterSale.route.test.ts`

**Interfaces:**
- Consumes: Task 8 (`tendersSchema`, `normalizeTenders`, `sumTenders`); Task 7 (`venueTillOf`); `ChargeIdempotencyMismatchError` (`.reason = 'idempotency_mismatch'`) and `MAX_CHARGE_CENTS` from `@services/merchant.service`; `StockDeclinedError { reason; productId; available }`.
- Produces:
  - `counterSaleSchema { clientTxnId, items: [{ productId, qty }], payment: { tenders } }`
  - `VenueSaleService.counterSale(params: { venueId; merchantId; merchantName; merchantOperatorId; operatorName; clientTxnId; items: { productId: string; qty: number }[]; tenders: TenderInput[] }): Promise<{ charge: IMerchantCharge; payment: IVenuePayment }>`; `CounterSaleRefusedError { reason; detail }` (400)
  - `StockAlertService.evaluateAfterSale(params: { vendorId: string; merchantId: string; productIds: string[] })`
  - `POST /api/merchant/sales` (venue tills, `merchant:charge`) → 200 `{ amount, tips, items, payment: { id, tenders, applied, tips, at } }`

A counter sale is paid in full at once: the tenders must add up to exactly the basket. ONE transaction: stock, the stall's `MerchantCharge`, and the `VenuePayment`.

- [ ] **Step 1: Write the failing test**

`src/routes/__tests__/venueCounterSale.route.test.ts`:

```ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { addVenueProduct, seedVenue, seedVenueStall, seedVenueTill } from '@/__tests__/helpers/venueFloor';
import { EVENT, seedStall } from '@/__tests__/helpers/tables';
import { MerchantCharge } from '@models/merchantCharge.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { VenuePayment } from '@models/venuePayment.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockService } from '@services/stock.service';
import { MerchantPermission } from '@interfaces/merchant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function counter() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const wine = await addVenueProduct(venue.venueId, bar.merchantId, { name: 'Wine', price: 4000, onHand: 1 });
  const till = await seedVenueTill(venue, bar.merchantId, { fullName: 'Nomsa' });
  const sell = (body: unknown, auth = till.auth) => request(app).post('/api/merchant/sales').set('Authorization', auth).send(body as object);
  return { venue, bar, wine, till, sell };
}
const onHand = (merchantId: string, productId: string) => StockService.getOnHand(merchantId, productId);

describe('venue counter sale', () => {
  it('sells from the till for cash: stock leaves, the stall is credited, the payment is recorded', async () => {
    const c = await counter();
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 2 }], payment: { tenders: [{ method: 'cash', amount: 5000 }] } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ amount: 5000, tips: 0, payment: { applied: 5000, tips: 0, tenders: [{ method: 'cash', amount: 5000, tip: 0 }] } });
    expect(res.body.data.items).toEqual([expect.objectContaining({ name: 'Castle Lite', qty: 2, unitPrice: 2500, lineTotal: 5000 })]);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(8);

    const charge = (await MerchantCharge.findOne({ clientTxnId: 's1' }).lean())!;
    expect(charge).toMatchObject({ amount: 5000, fee: 0, netAmount: 5000, staffName: 'Nomsa' });
    expect(String(charge.venueId)).toBe(c.venue.venueId);
    expect(String(charge.merchantOperatorId)).toBe(c.till.merchantOperatorId);
    expect(charge.walletId).toBeUndefined();

    const payment = (await VenuePayment.findOne({ clientTxnId: 's1' }).lean())!;
    expect(payment).toMatchObject({ source: 'counter', merchantName: 'Main Bar', applied: 5000, takenBy: c.till.merchantOperatorId, takenByType: 'MerchantOperator', staffName: 'Nomsa' });
    expect(String(payment.merchantChargeId)).toBe(String(charge._id));
    expect(payment.merchantIds.map(String)).toEqual([c.bar.merchantId]);

    const sale = await StockMovement.findOne({ productId: c.bar.productId, reason: 'sale' }).lean();
    expect(sale).toMatchObject({ delta: -2, refType: 'merchant_charge', refId: 's1', byType: 'Merchant', by: c.till.merchantOperatorId });
  });

  it('takes card and cash together, with a tip that is not part of the sale', async () => {
    const c = await counter();
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 3 }], payment: { tenders: [{ method: 'card', amount: 5000, tip: 500, reference: '7731' }, { method: 'cash', amount: 2500 }] } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ amount: 7500, tips: 500 });
    expect((await MerchantCharge.findOne({ clientTxnId: 's1' }).lean())!.amount).toBe(7500);
  });

  it('must be paid in full — no more, no less', async () => {
    const c = await counter();
    for (const amount of [4000, 6000]) {
      const res = await c.sell({ clientTxnId: `s${amount}`, items: [{ productId: c.bar.productId, qty: 2 }], payment: { tenders: [{ method: 'cash', amount }] } });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('the payment must equal the basket total');
      expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'payment_mismatch', total: 5000, applied: amount });
    }
    expect(await MerchantCharge.countDocuments()).toBe(0);
    expect(await VenuePayment.countDocuments()).toBe(0);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(10);
  });

  it('one item out of stock rolls the whole sale back', async () => {
    const c = await counter();
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 1 }, { productId: c.wine, qty: 2 }], payment: { tenders: [{ method: 'cash', amount: 10500 }] } });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Out of stock');
    expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'insufficient_stock', productId: c.wine, available: 1 });
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(10);
    expect(await MerchantCharge.countDocuments()).toBe(0);
    expect(await VenuePayment.countDocuments()).toBe(0);
  });

  it('a retried sale is made once; the same id for a different basket is refused', async () => {
    const c = await counter();
    const body = { clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 2 }], payment: { tenders: [{ method: 'cash', amount: 5000 }] } };
    const first = await c.sell(body);
    const again = await c.sell(body);
    expect(again.status).toBe(200);
    expect(again.body.data.payment.id).toBe(first.body.data.payment.id);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(8);
    expect(await MerchantCharge.countDocuments()).toBe(1);
    const different = await c.sell({ ...body, items: [{ productId: c.bar.productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 2500 }] } });
    expect(different.status).toBe(409);
    expect(JSON.parse(different.body.error)).toMatchObject({ reason: 'idempotency_mismatch' });
  });

  it("refuses another venue's or an event's product, and an invalid body", async () => {
    const c = await counter();
    const other = await seedVenueStall((await seedVenue()).venueId, { price: 100, onHand: 5 });
    const eventStall = await seedStall({ price: 100, onHand: 5 });
    for (const productId of [other.productId, eventStall.productId]) {
      const res = await c.sell({ clientTxnId: `x${productId}`, items: [{ productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 100 }] } });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("one or more products are not on this venue's menu");
    }
    for (const body of [
      { items: [{ productId: c.bar.productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 2500 }] } },
      { clientTxnId: 's1', items: [], payment: { tenders: [{ method: 'cash', amount: 0 }] } },
      { clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 1 }] },
    ]) {
      expect((await c.sell(body)).status).toBe(400);
    }
    expect(await MerchantCharge.countDocuments()).toBe(0);
  });

  it('is a venue till feature: an event till is refused, and a venue till still cannot tag-charge', async () => {
    const c = await counter();
    const stall = await seedStall({ price: 100, onHand: 1 });
    const op = await MerchantOperator.create({ fullName: 'Op', merchantId: stall.merchantId, eventId: EVENT, loginCode: 'EVT002', pin: '111111' });
    const eventTill = `Bearer ${jwt.sign({ scope: 'merchant', merchantId: stall.merchantId, merchantOperatorId: String(op._id), operatorName: 'Op', eventId: String(EVENT), name: 'Bar', permissions: [MerchantPermission.CHARGE] }, JWT_SECRET)}`;
    const refused = await c.sell({ clientTxnId: 's1', items: [{ productId: stall.productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 100 }] } }, eventTill);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe('That is a venue feature');
    const tag = await request(app).post('/api/merchant/charge').set('Authorization', c.till.auth).send({ bandUid: '04a1b2c3', clientTxnId: 'c1', amount: 100 });
    expect(tag.status).toBe(403);
    expect(tag.body.message).toBe("Tag payments aren't used at venues");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueCounterSale.route.test.ts --runInBand`
Expected: FAIL — `/api/merchant/sales` is 404.

- [ ] **Step 3: Validator, shared pieces**

`src/validators/venueSelling.validator.ts` — add:

```ts
/** POST /api/merchant/sales — a counter sale, paid in full at once. */
export const counterSaleSchema = Joi.object({
  clientTxnId,
  items: Joi.array().items(Joi.object({ productId: objectId.required(), qty })).min(1).max(MAX_LINES).required(),
  payment: Joi.object({ tenders: tendersSchema }).required(),
});
```

`src/services/merchant.service.ts` — `function basketKey` becomes `export function basketKey` (the counter sale compares a retry's basket the same way).

`src/services/stockAlert.service.ts` — `evaluateAfterSale(params: { vendorId: string; merchantId: string; productIds: string[] })` (the `eventId` it declared was never read). Update its one caller in `src/controllers/merchant.controller.ts` (drop the `eventId` property) and, mechanically, the four calls in `src/services/__tests__/stockAlert.service.test.ts`.

- [ ] **Step 4: The service**

`src/services/venueSale.service.ts`:

```ts
import mongoose from 'mongoose';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge, IMerchantCharge } from '@models/merchantCharge.model';
import { Product } from '@models/product.model';
import { VenuePayment } from '@models/venuePayment.model';
import { IVenuePayment } from '@interfaces/venuePayment.interface';
import { StockMovementReason } from '@interfaces/stock.interface';
import { StockService } from '@services/stock.service';
import { ChargeIdempotencyMismatchError, MAX_CHARGE_CENTS, basketKey } from '@services/merchant.service';
import { TenderInput, normalizeTenders, sumTenders } from '@utils/tenders.util';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** A counter sale that cannot be made as asked. 400 — nothing is written. */
export class CounterSaleRefusedError extends Error {
  constructor(message: string, public reason: string, public detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CounterSaleRefusedError';
  }
}

export interface CounterSale { charge: IMerchantCharge; payment: IVenuePayment }

/** Selling over the counter at a venue till (venue trading Phase 3): tagless, paid at once. */
export class VenueSaleService {
  /**
   * ONE transaction: every stock movement (hard-blocked at zero), the stall's
   * MerchantCharge, and the VenuePayment. The tenders must add up to exactly
   * the basket. A retry with the same clientTxnId returns the first sale.
   */
  static async counterSale(params: {
    venueId: string; merchantId: string; merchantName: string; merchantOperatorId: string; operatorName: string;
    clientTxnId: string; items: Array<{ productId: string; qty: number }>; tenders: TenderInput[];
  }): Promise<CounterSale> {
    const { clientTxnId, merchantOperatorId } = params;
    const venueId = oid(params.venueId);
    const merchantId = oid(params.merchantId);

    const replay = async (): Promise<CounterSale | null> => {
      const charge = await MerchantCharge.findOne({ merchantId, clientTxnId });
      if (!charge) return null;
      if (basketKey(charge.items ?? []) !== basketKey(params.items)) throw new ChargeIdempotencyMismatchError(clientTxnId);
      const payment = await VenuePayment.findOne({ venueId, clientTxnId });
      if (!payment) throw new Error('that sale has no payment on record');
      return { charge, payment };
    };
    const earlier = await replay();
    if (earlier) return earlier;

    const merged = new Map<string, number>();
    for (const { productId, qty } of params.items) merged.set(productId, (merged.get(productId) ?? 0) + qty);
    const ids = [...merged.keys()];
    const products = await Product.find({ _id: { $in: ids.map(oid) }, venueId, active: true }).select('name price').lean<{ _id: mongoose.Types.ObjectId; name: string; price: number }[]>();
    if (products.length !== ids.length) throw new CounterSaleRefusedError("one or more products are not on this venue's menu", 'product_not_found');
    const items = products.map((p) => {
      const qty = merged.get(String(p._id))!;
      return { productId: p._id, name: p.name, unitPrice: p.price, qty, lineTotal: p.price * qty };
    });
    const amount = items.reduce((sum, l) => sum + l.lineTotal, 0);
    if (amount < 1) throw new CounterSaleRefusedError('there is nothing to charge for', 'nothing_to_sell');
    if (amount > MAX_CHARGE_CENTS) throw new CounterSaleRefusedError('amount exceeds the maximum allowed charge', 'too_large');

    const tenders = normalizeTenders(params.tenders);
    const { applied, tips } = sumTenders(tenders);
    if (applied !== amount) throw new CounterSaleRefusedError('the payment must equal the basket total', 'payment_mismatch', { total: amount, applied });

    const now = new Date();
    const session = await mongoose.startSession();
    let out: CounterSale | undefined;
    try {
      await session.withTransaction(async () => {
        const stall = await Merchant.findOne({ _id: merchantId, venueId, status: 'active' }).session(session);
        if (!stall) throw new Error('stall not found or not active');
        for (const line of items) {
          await StockService.applyMovement({
            venueId, merchantId, productId: line.productId, delta: -line.qty,
            reason: StockMovementReason.SALE, refType: 'merchant_charge', refId: clientTxnId,
            byType: 'Merchant', by: merchantOperatorId, session,
          });
        }
        const [charge] = await MerchantCharge.create([{
          merchantId, venueId, amount, fee: 0, netAmount: amount, clientTxnId, status: 'completed', items,
          merchantOperatorId: oid(merchantOperatorId), staffName: params.operatorName,
        }], { session });
        const [payment] = await VenuePayment.create([{
          venueId, source: 'counter', merchantChargeId: charge!._id, merchantName: params.merchantName, merchantIds: [merchantId],
          clientTxnId, tenders, applied, tips, takenBy: merchantOperatorId, takenByType: 'MerchantOperator',
          staffName: params.operatorName, at: now,
        }], { session });
        out = { charge: charge!, payment: payment! };
      });
    } catch (e: any) {
      // Already committed by an earlier attempt of this same request.
      if (e?.code === 11000) {
        const again = await replay();
        if (again) return again;
      }
      throw e;
    } finally {
      await session.endSession();
    }
    return out!;
  }
}
```
(If `IMerchantCharge` is exported from an interface file rather than the model, import it from there.)

- [ ] **Step 5: The handler and route**

`src/controllers/venueTill.controller.ts` — imports: `counterSaleSchema`, `VenueSaleService`, `CounterSaleRefusedError`, `StockDeclinedError`, `ChargeIdempotencyMismatchError`, `StockAlertService`. Add:

```ts
  /** POST /api/merchant/sales { clientTxnId, items, payment: { tenders } } — a counter sale. */
  static async sale(req: Request, res: Response): Promise<any> {
    const till = venueTillOf(req, res);
    if (!till) return;
    const { error, value } = counterSaleSchema.validate(req.body ?? {}, { stripUnknown: true });
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const { charge, payment } = await VenueSaleService.counterSale({
        venueId: till.venueId, merchantId: till.merchantId, merchantName: till.merchantName,
        merchantOperatorId: till.merchantOperatorId, operatorName: till.operatorName,
        clientTxnId: value.clientTxnId, items: value.items, tenders: value.payment.tenders,
      });
      // Best-effort by design (telemetry-class): never affects the sale.
      void StockAlertService.evaluateAfterSale({ vendorId: till.vendorId, merchantId: till.merchantId, productIds: value.items.map((i: { productId: string }) => i.productId) });
      return ApiResponseUtil.success(res, {
        amount: charge.amount, tips: payment.tips, items: charge.items,
        payment: { id: String(payment._id), tenders: payment.tenders, applied: payment.applied, tips: payment.tips, at: payment.at },
      });
    } catch (e: any) {
      if (e instanceof StockDeclinedError) return ApiResponseUtil.error(res, 'Out of stock', 409, { reason: e.reason, productId: e.productId, available: e.available });
      if (e instanceof CounterSaleRefusedError) return ApiResponseUtil.error(res, e.message, 400, { reason: e.reason, ...e.detail });
      if (e instanceof ChargeIdempotencyMismatchError) return ApiResponseUtil.error(res, e.message, 409, { reason: e.reason });
      console.error('Counter sale failed', e);
      return ApiResponseUtil.error(res, e?.message || 'Could not complete the sale', 500);
    }
  }
```

`src/routes/merchant.route.ts`:

```ts
// A venue till's counter sale: cash / card, no tag (event tills use /charge).
router.post('/sales', requireMerchantPermission(MerchantPermission.CHARGE), asyncHandler(VenueTillController.sale));
```

A round takes stock off the shelf too, so it arms the same alert. In `src/controllers/venueWaiter.controller.ts` `sendOrder`, between the service call and the response (import `StockAlertService`; bind the sent table to `table` as now):

```ts
      // Best-effort by design (telemetry-class): one evaluation per stall in the round.
      const vendorId = String(venueOf(req).vendorId);
      const byStall = new Map<string, string[]>();
      for (const item of value.items as RoundItem[]) byStall.set(item.merchantId, [...(byStall.get(item.merchantId) ?? []), item.productId]);
      for (const [merchantId, productIds] of byStall) void StockAlertService.evaluateAfterSale({ vendorId, merchantId, productIds });
```
(import `RoundItem` from `@services/venueTable.service`.)

- [ ] **Step 6: Run — expect PASS**

Run:
```bash
npx jest src/routes/__tests__/venueCounterSale.route.test.ts src/routes/__tests__/venueTill.route.test.ts src/routes/__tests__/merchantCharge.route.test.ts src/routes/__tests__/merchantChargeItems.route.test.ts src/services/__tests__/merchantCharge.service.test.ts src/services/__tests__/merchantCharge.items.service.test.ts src/services/__tests__/stockAlert.service.test.ts src/routes/__tests__/lowStockAlert.route.test.ts --runInBand
npx tsc --noEmit -p .
```
Expected: all pass; the only existing-test edit is the dropped `eventId` argument in `stockAlert.service.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/validators/venueSelling.validator.ts src/services/venueSale.service.ts src/services/merchant.service.ts src/services/stockAlert.service.ts src/services/__tests__/stockAlert.service.test.ts src/controllers/venueTill.controller.ts src/controllers/venueWaiter.controller.ts src/controllers/merchant.controller.ts src/routes/merchant.route.ts src/routes/__tests__/venueCounterSale.route.test.ts
git commit -m "feat(venue): counter sales at the till — paid in full by cash/card, one atomic retry-safe sale"
```

---

### Task 10: Dashboard — the tables view and the manager walkout

**Files:**
- Modify: `src/services/venueTable.service.ts`, `src/middleware/tradingScope.middleware.ts` (`venueIdOf`)
- Create: `src/controllers/venueTables.controller.ts`
- Modify: `src/routes/venue.route.ts`
- Test: `src/routes/__tests__/venueTablesAdmin.route.test.ts`

**Interfaces:**
- Consumes: Task 5 (`TableService.voidTable(ScopeIds & …)`, `TableService.present`); Tasks 6–8 (orders, payments); `requireAnyPermission([…])`, `venueScope`, `getScope(req)`; `asyncHandler`.
- Produces:
  - `VenueTableService.dashboardList({ venueId, status }): Promise<{ tables: VenueTableRow[]; totals: { count: number; balance: number } }>`
  - `VenueTableService.dashboardDetail({ venueId, tableId }): Promise<VenueTableDetail | null>`
  - `VenueTableRow { id; label; status; waiterId; waiterName; openedAt; subtotal; paidTotal; balance; orders: { sent; handedOut; collected }; settledAt?; voidedAt?; voidReason? }`
  - `VenueTableDetail = VenueTableRow & { items: { lineId; name; unitPrice; qty; paidQty; merchantId; merchantName; orderId }[]; rounds: { orderId; merchantId; merchantName; status; sentAt; handedOutAt?; acceptedAt?; lineIds }[]; payments: { id; at; staffName; applied; tips; tenders }[] }`
  - `venueIdOf(req): string` exported from `@middleware/tradingScope.middleware`
  - `GET /api/tickets/venue/tables?status=open|settled|voided` (default `open`) — `tickets:view_revenue` OR `tickets:manage_venue`
  - `GET /api/tickets/venue/tables/:id` — same permissions
  - `POST /api/tickets/venue/tables/:id/void { reason }` — `tickets:manage_venue`; the walkout: closes an open table WITHOUT returning stock and WITHOUT writing stall charges; its unpaid `balance` is the write-off.

- [ ] **Step 1: Write the failing test**

`src/routes/__tests__/venueTablesAdmin.route.test.ts`:

```ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, seedVenueStall, seedVenueTill, seedVenueWaiter, venueDashboardAuth } from '@/__tests__/helpers/venueFloor';
import { Table } from '@models/table.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { StockService } from '@services/stock.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const URL = '/api/tickets/venue/tables';

/** Table 7 (Sipho): 2 beers + 1 burger = 14000, the bar's round handed out, E40 paid. */
async function floor() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const kitchen = await seedVenueStall(venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
  const waiter = await seedVenueWaiter(venue, { fullName: 'Sipho' });
  const till = await seedVenueTill(venue, bar.merchantId);
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  const round = await request(app).post(`/api/waiter/tables/${tableId}/orders`).set('Authorization', waiter.auth).send({ clientTxnId: 'r1', items: [{ ...bar, qty: 2 }, { ...kitchen, qty: 1 }] });
  const barOrder = round.body.data.orders.find((o: { merchantId: string }) => o.merchantId === bar.merchantId)._id as string;
  await request(app).post(`/api/merchant/tables/${tableId}/orders/${barOrder}/hand-out`).set('Authorization', till.auth).send({});
  await request(app).post(`/api/waiter/tables/${tableId}/payments`).set('Authorization', waiter.auth).send({ clientTxnId: 'p1', tenders: [{ method: 'cash', amount: 4000, tip: 200 }] });
  return { venue, bar, kitchen, waiter, tableId, auth: venueDashboardAuth(venue) };
}

describe('dashboard — venue tables', () => {
  it('lists the open floor: who has it, the bill, what is paid, where its rounds are', async () => {
    const f = await floor();
    const res = await request(app).get(URL).set('Authorization', f.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual({ count: 1, balance: 10000 });
    expect(res.body.data.tables).toEqual([expect.objectContaining({
      id: f.tableId, label: '7', status: 'open', waiterId: f.waiter.waiterId, waiterName: 'Sipho',
      subtotal: 14000, paidTotal: 4000, balance: 10000, orders: { sent: 1, handedOut: 1, collected: 0 },
    })]);
    expect((await request(app).get(`${URL}?status=settled`).set('Authorization', f.auth)).body.data.tables).toEqual([]);
    const bad = await request(app).get(`${URL}?status=paid`).set('Authorization', f.auth);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Unknown table status');
  });

  it('opens one table: its rounds with stall names, its lines, its payments', async () => {
    const f = await floor();
    const res = await request(app).get(`${URL}/${f.tableId}`).set('Authorization', f.auth);
    expect(res.status).toBe(200);
    const t = res.body.data;
    expect(t).toMatchObject({ id: f.tableId, label: '7', waiterName: 'Sipho', balance: 10000 });
    expect(t.items.map((l: { name: string; merchantName: string; paidQty: number }) => [l.name, l.merchantName, l.paidQty]).sort()).toEqual([['Burger', 'Kitchen', 0], ['Castle Lite', 'Main Bar', 0]]);
    expect(t.rounds.map((r: { merchantName: string; status: string }) => [r.merchantName, r.status]).sort()).toEqual([['Kitchen', 'sent'], ['Main Bar', 'handed_out']]);
    expect(t.payments).toEqual([expect.objectContaining({ staffName: 'Sipho', applied: 4000, tips: 200, tenders: [{ method: 'cash', amount: 4000, tip: 200 }] })]);
  });

  it('a manager closes a walkout: no stock back, no stall takings, the balance written off', async () => {
    const f = await floor();
    const res = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: 'Guests left without paying' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'voided', voidReason: 'Guests left without paying', subtotal: 14000, paidTotal: 4000, balance: 10000 });
    expect(await StockService.getOnHand(f.bar.merchantId, f.bar.productId)).toBe(8);
    expect(await MerchantCharge.countDocuments()).toBe(0);
    const walked = await request(app).get(`${URL}?status=voided`).set('Authorization', f.auth);
    expect(walked.body.data.tables).toHaveLength(1);
    expect(walked.body.data.totals).toEqual({ count: 1, balance: 10000 });
    // the number is free for the next guests
    expect((await request(app).post('/api/waiter/tables').set('Authorization', f.waiter.auth).send({ label: '7' })).status).toBe(201);
    const again = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: 'again' });
    expect(again.status).toBe(409);
  });

  it('a walkout needs a reason and tickets:manage_venue; viewing needs revenue or venue access', async () => {
    const f = await floor();
    const noReason = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: '  ' });
    expect(noReason.status).toBe(400);
    const viewer = venueDashboardAuth(f.venue, [TicketsPermission.VIEW_REVENUE]);
    expect((await request(app).get(URL).set('Authorization', viewer)).status).toBe(200);
    expect((await request(app).get(`${URL}/${f.tableId}`).set('Authorization', viewer)).status).toBe(200);
    expect((await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', viewer).send({ reason: 'x' })).status).toBe(403);
    const stockOnly = venueDashboardAuth(f.venue, [TicketsPermission.MANAGE_STOCK]);
    expect((await request(app).get(URL).set('Authorization', stockOnly)).status).toBe(403);
    expect((await Table.findById(f.tableId))!.status).toBe('open');
  });

  it("answers 404 for another venue's table and a junk id", async () => {
    const f = await floor();
    const other = venueDashboardAuth(await seedVenue());
    for (const [auth, id] of [[other, f.tableId], [f.auth, 'junk'], [f.auth, '000000000000000000000001']] as const) {
      expect((await request(app).get(`${URL}/${id}`).set('Authorization', auth)).status).toBe(404);
      expect((await request(app).post(`${URL}/${id}/void`).set('Authorization', auth).send({ reason: 'x' })).status).toBe(404);
    }
    expect((await request(app).get(URL).set('Authorization', other)).body.data.tables).toEqual([]);
    expect((await Table.findById(f.tableId))!.status).toBe('open');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/venueTablesAdmin.route.test.ts --runInBand`
Expected: FAIL — `/api/tickets/venue/tables` is 404.

- [ ] **Step 3: The read models**

`src/services/venueTable.service.ts` — import `TableService`, `WaiterTableView`, `TableStatus`, `Merchant` (already imported). Above the class:

```ts
export interface VenueTableRow {
  id: string; label: string; status: TableStatus; waiterId: string; waiterName: string; openedAt: Date;
  subtotal: number; paidTotal: number;
  /** What is still owed. On a voided table this is what was written off. */
  balance: number;
  orders: { sent: number; handedOut: number; collected: number };
  settledAt?: Date; voidedAt?: Date; voidReason?: string;
}

export interface VenueTableDetail extends VenueTableRow {
  items: Array<{ lineId: string; name: string; unitPrice: number; qty: number; paidQty: number; merchantId: string; merchantName: string; orderId: string | null }>;
  rounds: Array<{ orderId: string; merchantId: string; merchantName: string; status: TableOrderStatus; sentAt: Date; handedOutAt?: Date; acceptedAt?: Date; lineIds: string[] }>;
  payments: Array<{ id: string; at: Date; staffName: string; applied: number; tips: number; tenders: IVenuePayment['tenders'] }>;
}

function toRow(t: WaiterTableView): VenueTableRow {
  const orders = t.orders ?? [];
  const count = (status: TableOrderStatus) => orders.filter((o) => o.status === status).length;
  const paidTotal = t.paidTotal ?? 0;
  return {
    id: String(t._id), label: t.label, status: t.status, waiterId: t.openedBy, waiterName: t.openedByName, openedAt: t.createdAt,
    subtotal: t.subtotal, paidTotal, balance: t.subtotal - paidTotal,
    orders: { sent: count('sent'), handedOut: count('handed_out'), collected: count('collected') },
    ...(t.settledAt ? { settledAt: t.settledAt } : {}), ...(t.voidedAt ? { voidedAt: t.voidedAt } : {}), ...(t.voidReason ? { voidReason: t.voidReason } : {}),
  };
}
```

Inside the class:

```ts
  /** The manager's floor: every table of one status, newest first (the 200 most recent). */
  static async dashboardList(params: { venueId: string; status: TableStatus }): Promise<{ tables: VenueTableRow[]; totals: { count: number; balance: number } }> {
    const tables = (await TableService.list({ venueId: params.venueId }, { status: params.status })).map(toRow);
    return { tables, totals: { count: tables.length, balance: tables.reduce((sum, t) => sum + t.balance, 0) } };
  }

  /** One table in full: its lines, its rounds and every payment taken against it. Null when it is not this venue's. */
  static async dashboardDetail(params: { venueId: string; tableId: string }): Promise<VenueTableDetail | null> {
    const venueId = oid(params.venueId);
    const table = await Table.findOne({ _id: oid(params.tableId), venueId }).lean<ITable | null>();
    if (!table) return null;
    const [[view], payments] = await Promise.all([
      TableService.present([table]),
      VenuePayment.find({ venueId, tableId: table._id }).sort({ at: 1 }).lean<IVenuePayment[]>(),
    ]);
    const stallName = new Map(view!.items.map((i) => [String(i.merchantId), i.merchantName]));
    return {
      ...toRow(view!),
      items: view!.items.map((i) => ({
        lineId: String(i._id), name: i.name, unitPrice: i.unitPrice, qty: i.qty, paidQty: i.paidQty ?? 0,
        merchantId: String(i.merchantId), merchantName: i.merchantName, orderId: i.orderId ? String(i.orderId) : null,
      })),
      rounds: (table.orders ?? []).map((o) => ({
        orderId: String(o._id), merchantId: String(o.merchantId), merchantName: stallName.get(String(o.merchantId)) ?? 'Unknown stall',
        status: o.status, sentAt: o.sentAt, ...(o.handedOutAt ? { handedOutAt: o.handedOutAt } : {}), ...(o.acceptedAt ? { acceptedAt: o.acceptedAt } : {}),
        lineIds: o.lineIds.map(String),
      })),
      payments: payments.map((p) => ({ id: String(p._id), at: p.at, staffName: p.staffName, applied: p.applied, tips: p.tips, tenders: p.tenders })),
    };
  }
```
(`TableService.list` caps at 200 rows; `WaiterTableView` already carries `orders` / `paidTotal` because it extends `ITable`.)

- [ ] **Step 4: The controller and routes**

`src/middleware/tradingScope.middleware.ts` — add, beside `getScope` (Task 11's controller uses it too):

```ts
/** The venue behind a `/venue/*` dashboard route — venueScope resolved it from the logged-in vendor. */
export function venueIdOf(req: Request): string {
  const scope = getScope(req);
  if (scope.kind !== 'venue') throw new Error('venue route reached without a venue scope');
  return scope.venueId;
}
```

`src/controllers/venueTables.controller.ts`:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import { venueIdOf } from '@middleware/tradingScope.middleware';
import { TableService } from '@services/table.service';
import { VenueTableService } from '@services/venueTable.service';

const STATUSES = ['open', 'settled', 'voided'] as const;

/**
 * The manager's view of the floor (venue trading Phase 3). Read-only apart
 * from the walkout: the dashboard never opens a table, adds a round or takes a
 * payment — every sale stays attributed to a named waiter or till person.
 */
export class VenueTablesController {
  /** GET /api/tickets/venue/tables?status=open|settled|voided */
  static async list(req: Request, res: Response): Promise<any> {
    const raw = req.query['status'];
    const status = raw === undefined ? 'open' : STATUSES.find((s) => s === raw);
    if (!status) return ApiResponseUtil.badRequest(res, 'Unknown table status');
    return ApiResponseUtil.success(res, await VenueTableService.dashboardList({ venueId: venueIdOf(req), status }));
  }

  /** GET /api/tickets/venue/tables/:id */
  static async detail(req: Request, res: Response): Promise<any> {
    const tableId = String(req.params['id']);
    const table = HEX24.test(tableId) ? await VenueTableService.dashboardDetail({ venueId: venueIdOf(req), tableId }) : null;
    if (!table) return ApiResponseUtil.notFound(res, 'Table not found');
    return ApiResponseUtil.success(res, table);
  }

  /** POST /api/tickets/venue/tables/:id/void { reason } — close a walkout. Stock is NOT returned. */
  static async void(req: Request, res: Response): Promise<any> {
    const tableId = String(req.params['id']);
    if (!HEX24.test(tableId)) return ApiResponseUtil.notFound(res, 'Table not found');
    const venueId = venueIdOf(req);
    const user = (req as any).ticketsUser as { userId?: string; vendorId?: string };
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    try {
      await TableService.voidTable({ venueId, tableId, reason, voidedBy: String(user.userId ?? user.vendorId) });
    } catch (e: any) {
      const message: string = e?.message || 'Could not close the table';
      if (/reason is required/i.test(message)) return ApiResponseUtil.badRequest(res, message);
      if (/not open/i.test(message)) return ApiResponseUtil.error(res, message, 409);
      if (/not found/i.test(message)) return ApiResponseUtil.notFound(res, 'Table not found');
      console.error('Walkout close failed', e);
      return ApiResponseUtil.error(res, message, 500);
    }
    return ApiResponseUtil.success(res, await VenueTableService.dashboardDetail({ venueId, tableId }));
  }
}
```

`src/routes/venue.route.ts` — imports `VenueTablesController`, `asyncHandler`; add:

```ts
// The floor (venue Phase 3). Viewing is for revenue viewers and venue admins;
// closing a walkout is a venue admin's.
router.get('/tables', requireAnyPermission([VIEW_REVENUE, MANAGE_VENUE]), venueScope, asyncHandler(VenueTablesController.list));
router.get('/tables/:id', requireAnyPermission([VIEW_REVENUE, MANAGE_VENUE]), venueScope, asyncHandler(VenueTablesController.detail));
router.post('/tables/:id/void', requireTicketsPermission(MANAGE_VENUE), venueScope, asyncHandler(VenueTablesController.void));
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx jest src/routes/__tests__/venueTablesAdmin.route.test.ts src/routes/__tests__/venueWaiterTables.route.test.ts src/routes/__tests__/tableReport.route.test.ts src/services/__tests__/tableVoid.test.ts --runInBand && npx tsc --noEmit -p .`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/venueTable.service.ts src/middleware/tradingScope.middleware.ts src/controllers/venueTables.controller.ts src/routes/venue.route.ts src/routes/__tests__/venueTablesAdmin.route.test.ts
git commit -m "feat(venue): dashboard tables — the live floor, one table in full, and the manager walkout"
```

---

### Task 11: Dashboard — the payments list (Transactions) and one payment in full

**Files:**
- Create: `src/utils/queryParams.util.ts`; Modify: `src/controllers/adminOrganizers.controller.ts` (import the two helpers instead of defining them)
- Modify: `src/utils/eventTime.util.ts` (`parseDayRange`, `DAY_MS`), `src/controllers/stockReport.controller.ts` (`reconWindow` uses it)
- Create: `src/services/venuePayment.service.ts`, `src/controllers/venuePayments.controller.ts`
- Modify: `src/routes/venue.route.ts`
- Test: `src/utils/__tests__/dayRange.test.ts`, `src/routes/__tests__/venuePaymentsAdmin.route.test.ts`

**Interfaces:**
- Consumes: Task 1 (`VenuePayment`); Task 8 (`sumTenders`); Task 10 (`venueIdOf(req)` from `@middleware/tradingScope.middleware`); `startOfLocalDay(now)` in `@utils/eventTime.util`; `textParam`, `enumParam` currently local to `adminOrganizers.controller.ts` (move them unchanged).
- Produces:
  - `textParam(value: unknown): string | null` ('' = absent, null = not text), `enumParam(raw, allowed)` in `@utils/queryParams.util`
  - `parseDayRange(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } | { error: string }` — ISO instants, half-open `[from, to)`, default today in Africa/Mbabane, `to` defaults to a day after `from`; errors `from and to must be ISO dates` / `from must be before to`
  - `VenuePaymentService.list(venueId, filters, page, limit)` and `.detail(venueId, paymentId)`
  - `GET /api/tickets/venue/payments?from=&to=&method=&staffId=&merchantId=&source=&reference=&page=&limit=` → `{ payments, totals, unpaidOnOpenTables, filterOptions, pagination }` — `tickets:view_revenue`
  - `GET /api/tickets/venue/payments/:id` → the payment in full — `tickets:view_revenue`
  - A payment row: `{ id, at, source, where, tableId, staffName, takenByType, cash, card, tip, total, references, byItems }` where `where` is `Table <label>` or `Counter · <stall>`, `total = applied + tips`.
  - `totals`: `{ sales, cash, card, tips, cashTips, cardTips }` over the WHOLE filtered range (not the page). `sales` = Σ applied; tips are never in `sales`.

- [ ] **Step 1: Write the failing tests**

`src/utils/__tests__/dayRange.test.ts`:

```ts
import { parseDayRange } from '@utils/eventTime.util';

describe('parseDayRange', () => {
  it('takes two ISO instants', () => {
    expect(parseDayRange('2026-10-01T00:00:00+02:00', '2026-10-02T00:00:00+02:00')).toEqual({
      from: new Date('2026-09-30T22:00:00.000Z'), to: new Date('2026-10-01T22:00:00.000Z'),
    });
  });
  it('defaults to today in Eswatini, and `to` to a day after `from`', () => {
    const today = parseDayRange(undefined, undefined) as { from: Date; to: Date };
    expect(today.to.getTime() - today.from.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(today.from.toISOString().endsWith('T22:00:00.000Z')).toBe(true);
    const fromOnly = parseDayRange('2026-10-01T00:00:00+02:00', undefined) as { from: Date; to: Date };
    expect(fromOnly.to).toEqual(new Date('2026-10-01T22:00:00.000Z'));
  });
  it('refuses a non-date, a non-string and a backwards range', () => {
    expect(parseDayRange('yesterday', undefined)).toEqual({ error: 'from and to must be ISO dates' });
    expect(parseDayRange({ toString: 'x' }, undefined)).toEqual({ error: 'from and to must be ISO dates' });
    expect(parseDayRange(['a', 'b'], undefined)).toEqual({ error: 'from and to must be ISO dates' });
    expect(parseDayRange('2026-10-02T00:00:00+02:00', '2026-10-01T00:00:00+02:00')).toEqual({ error: 'from must be before to' });
  });
});
```

`src/routes/__tests__/venuePaymentsAdmin.route.test.ts`:

```ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, venueDashboardAuth, SeededVenue } from '@/__tests__/helpers/venueFloor';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Table } from '@models/table.model';
import { VenuePayment } from '@models/venuePayment.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const URL = '/api/tickets/venue/payments';
const DAY = '?from=2026-10-01T00:00:00%2B02:00&to=2026-10-02T00:00:00%2B02:00';
const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00+02:00`);
const oid = () => new mongoose.Types.ObjectId();

/**
 * 1 Oct: Sipho (waiter) took E75 at table 7 — E30 cash + E45 card with a E5 card tip (slip 0192);
 * Sipho took E25 cash at table 7 for one beer (by items); Nomsa (till) sold E50 cash over the Main Bar counter.
 * 30 Sep: one E10 cash payment that must stay out of the day.
 */
async function ledger(venue: SeededVenue) {
  const bar = await Merchant.create({ name: 'Main Bar', venueId: venue.venueId });
  const kitchen = await Merchant.create({ name: 'Kitchen', venueId: venue.venueId });
  const lineId = oid();
  const table = await Table.create({
    venueId: venue.venueId, label: '7', status: 'open', openedBy: String(oid()), subtotal: 14000, paidTotal: 10000, orders: [],
    items: [{ _id: lineId, merchantId: bar._id, productId: oid(), name: 'Castle Lite', unitPrice: 2500, qty: 2, addedBy: 'w', paidQty: 1 }],
  });
  const sipho = String(oid());
  const nomsa = String(oid());
  const base = { venueId: venue.venueId, takenByType: 'Waiter', staffName: 'Sipho', takenBy: sipho, source: 'table', tableId: table._id, tableLabel: '7', merchantIds: [bar._id, kitchen._id] };
  const mixed = await VenuePayment.create({ ...base, clientTxnId: 'p1', tenders: [{ method: 'cash', amount: 3000, tip: 0 }, { method: 'card', amount: 4500, tip: 500, reference: '0192' }], applied: 7500, tips: 500, at: at('21:14') });
  const byItems = await VenuePayment.create({ ...base, clientTxnId: 'p2', tenders: [{ method: 'cash', amount: 2500, tip: 0 }], applied: 2500, tips: 0, lines: [{ lineId, qty: 1 }], at: at('21:30') });
  const charge = await MerchantCharge.create({ merchantId: bar._id, venueId: venue.venueId, amount: 5000, fee: 0, netAmount: 5000, clientTxnId: 's1', staffName: 'Nomsa', items: [{ productId: oid(), name: 'Castle Lite', unitPrice: 2500, qty: 2, lineTotal: 5000 }] });
  const counter = await VenuePayment.create({ venueId: venue.venueId, source: 'counter', merchantChargeId: charge._id, merchantName: 'Main Bar', merchantIds: [bar._id], clientTxnId: 's1', tenders: [{ method: 'cash', amount: 5000, tip: 0 }], applied: 5000, tips: 0, takenBy: nomsa, takenByType: 'MerchantOperator', staffName: 'Nomsa', at: at('22:05') });
  await VenuePayment.create({ ...base, clientTxnId: 'p0', tenders: [{ method: 'cash', amount: 1000, tip: 0 }], applied: 1000, tips: 0, at: new Date('2026-09-30T20:00:00+02:00') });
  return { bar: String(bar._id), kitchen: String(kitchen._id), tableId: String(table._id), sipho, nomsa, mixed: String(mixed._id), byItems: String(byItems._id), counter: String(counter._id) };
}

describe('dashboard — venue payments', () => {
  it('lists the day newest first, with totals for the whole range and what is unpaid on open tables now', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    const res = await request(app).get(`${URL}${DAY}`).set('Authorization', venueDashboardAuth(venue));
    expect(res.status).toBe(200);
    expect(res.body.data.payments.map((p: { id: string }) => p.id)).toEqual([l.counter, l.byItems, l.mixed]);
    expect(res.body.data.payments[0]).toMatchObject({ source: 'counter', where: 'Counter · Main Bar', staffName: 'Nomsa', takenByType: 'MerchantOperator', cash: 5000, card: 0, tip: 0, total: 5000, references: [], byItems: false });
    expect(res.body.data.payments[1]).toMatchObject({ where: 'Table 7', byItems: true, cash: 2500 });
    expect(res.body.data.payments[2]).toMatchObject({ where: 'Table 7', staffName: 'Sipho', cash: 3000, card: 4500, tip: 500, total: 8000, references: ['0192'] });
    expect(res.body.data.totals).toEqual({ sales: 15000, cash: 10500, card: 4500, tips: 500, cashTips: 0, cardTips: 500 });
    expect(res.body.data.unpaidOnOpenTables).toBe(4000);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 25, total: 3, totalPages: 1 });
    expect(res.body.data.filterOptions.staff.map((s: { name: string }) => s.name)).toEqual(['Nomsa', 'Sipho']);
    expect(res.body.data.filterOptions.stalls.map((s: { name: string }) => s.name)).toEqual(['Kitchen', 'Main Bar']);
  });

  it('totals cover the whole range, not the page', async () => {
    const venue = await seedVenue();
    await ledger(venue);
    const res = await request(app).get(`${URL}${DAY}&limit=1&page=2`).set('Authorization', venueDashboardAuth(venue));
    expect(res.body.data.payments).toHaveLength(1);
    expect(res.body.data.pagination).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
    expect(res.body.data.totals.sales).toBe(15000);
  });

  it('filters by method, staff, stall, source and slip reference', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    const ids = async (query: string) => (await request(app).get(`${URL}${DAY}&${query}`).set('Authorization', venueDashboardAuth(venue))).body.data.payments.map((p: { id: string }) => p.id);
    expect(await ids('method=card')).toEqual([l.mixed]);
    expect(await ids(`staffId=${l.nomsa}`)).toEqual([l.counter]);
    expect(await ids(`merchantId=${l.kitchen}`)).toEqual([l.byItems, l.mixed]);
    expect(await ids('source=counter')).toEqual([l.counter]);
    expect(await ids('reference=0192')).toEqual([l.mixed]);
    const card = await request(app).get(`${URL}${DAY}&method=card`).set('Authorization', venueDashboardAuth(venue));
    expect(card.body.data.totals).toMatchObject({ sales: 7500, cash: 3000, card: 4500 });
  });

  it('refuses unknown filter values and a backwards or malformed range', async () => {
    const venue = await seedVenue();
    const auth = venueDashboardAuth(venue);
    for (const [query, message] of [
      ['method=momo', 'Unknown payment method'], ['source=online', 'Unknown payment source'],
      ['staffId=junk', 'Invalid staffId'], ['merchantId=junk', 'Invalid merchantId'],
      ['page=abc', 'Invalid page'], ['limit=0', 'Invalid limit'], ['method[toString]=x', 'Unknown payment method'],
      ['from=2026-10-02T00:00:00%2B02:00&to=2026-10-01T00:00:00%2B02:00', 'from must be before to'],
      ['from=yesterday', 'from and to must be ISO dates'],
    ] as const) {
      const res = await request(app).get(`${URL}?${query}`).set('Authorization', auth);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
    }
    expect((await request(app).get(URL).set('Authorization', auth)).status).toBe(200);
  });

  it('opens one payment: its tenders, what it covered, and the table\'s other payments', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    const auth = venueDashboardAuth(venue);
    const byItems = (await request(app).get(`${URL}/${l.byItems}`).set('Authorization', auth)).body.data;
    expect(byItems).toMatchObject({ id: l.byItems, where: 'Table 7', applied: 2500, tips: 0, total: 2500, covers: { kind: 'items', items: [{ name: 'Castle Lite', qty: 1, unitPrice: 2500, lineTotal: 2500 }] } });
    expect(byItems.table).toMatchObject({ id: l.tableId, label: '7', status: 'open', subtotal: 14000, paidTotal: 10000 });
    expect(byItems.table.otherPayments.map((p: { id: string }) => p.id)).toContain(l.mixed);
    const mixed = (await request(app).get(`${URL}/${l.mixed}`).set('Authorization', auth)).body.data;
    expect(mixed.covers).toEqual({ kind: 'amount' });
    expect(mixed.tenders).toEqual([{ method: 'cash', amount: 3000, tip: 0 }, { method: 'card', amount: 4500, tip: 500, reference: '0192' }]);
    const counter = (await request(app).get(`${URL}/${l.counter}`).set('Authorization', auth)).body.data;
    expect(counter).toMatchObject({ where: 'Counter · Main Bar', covers: { kind: 'sale', items: [{ name: 'Castle Lite', qty: 2, lineTotal: 5000 }] } });
    expect(counter.table).toBeUndefined();
  });

  it("needs tickets:view_revenue; another venue's payment and a junk id are 404", async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    expect((await request(app).get(URL).set('Authorization', venueDashboardAuth(venue, [TicketsPermission.MANAGE_VENUE, TicketsPermission.MANAGE_STOCK]))).status).toBe(403);
    const other = venueDashboardAuth(await seedVenue());
    expect((await request(app).get(`${URL}/${l.mixed}`).set('Authorization', other)).status).toBe(404);
    expect((await request(app).get(`${URL}/junk`).set('Authorization', venueDashboardAuth(venue))).status).toBe(404);
    expect((await request(app).get(`${URL}${DAY}`).set('Authorization', other)).body.data.payments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them — expect FAIL**

Run: `npx jest src/utils/__tests__/dayRange.test.ts src/routes/__tests__/venuePaymentsAdmin.route.test.ts --runInBand`
Expected: FAIL — `parseDayRange` does not exist; `/api/tickets/venue/payments` is 404.

- [ ] **Step 3: Shared helpers**

`src/utils/queryParams.util.ts` — MOVE `textParam` and `enumParam` (with their doc comments, unchanged) out of `src/controllers/adminOrganizers.controller.ts`, export them, and import them back into that controller. No behaviour change (its tests prove it).

`src/utils/eventTime.util.ts` — add:

```ts
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A venue report's `?from=&to=` window: ISO instants, half-open [from, to).
 * Default: today in Africa/Mbabane; `to` defaults to a day after `from`.
 * Anything that is not text (an array / object query value) is refused, never
 * stringified.
 */
export function parseDayRange(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } | { error: string } {
  const read = (v: unknown): Date | undefined | null => (v === undefined ? undefined : typeof v === 'string' ? new Date(v) : null);
  const [f, t] = [read(fromRaw), read(toRaw)];
  if (f === null || t === null) return { error: 'from and to must be ISO dates' };
  const from = f ?? startOfLocalDay(new Date());
  const to = t ?? new Date(from.getTime() + DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: 'from and to must be ISO dates' };
  if (from.getTime() >= to.getTime()) return { error: 'from must be before to' };
  return { from, to };
}
```

`src/controllers/stockReport.controller.ts` — delete its local `DAY_MS` and make `reconWindow`'s venue branch use the shared parser (same messages, same defaults):

```ts
  const range = parseDayRange(req.query['from'], req.query['to']);
  if ('error' in range) { ApiResponseUtil.badRequest(res, range.error); return null; }
  return range;
```

- [ ] **Step 4: The service**

`src/services/venuePayment.service.ts`:

```ts
import mongoose from 'mongoose';
import { VenuePayment } from '@models/venuePayment.model';
import { Table } from '@models/table.model';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { IVenuePayment, TenderMethod, VenuePaymentSource } from '@interfaces/venuePayment.interface';
import { sumTenders } from '@utils/tenders.util';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

export interface PaymentFilters {
  from: Date; to: Date;
  method?: TenderMethod; staffId?: string; merchantId?: string; source?: VenuePaymentSource; reference?: string;
}

export interface PaymentRow {
  id: string; at: Date; source: VenuePaymentSource; where: string; tableId: string | null;
  staffName: string; takenByType: 'Waiter' | 'MerchantOperator';
  cash: number; card: number; tip: number; total: number; references: string[]; byItems: boolean;
}

const whereOf = (p: IVenuePayment) => (p.source === 'table' ? `Table ${p.tableLabel}` : `Counter · ${p.merchantName}`);

function toRow(p: IVenuePayment): PaymentRow {
  const sums = sumTenders(p.tenders);
  return {
    id: String(p._id), at: p.at, source: p.source, where: whereOf(p), tableId: p.tableId ? String(p.tableId) : null,
    staffName: p.staffName, takenByType: p.takenByType,
    cash: sums.cash, card: sums.card, tip: sums.tips, total: sums.applied + sums.tips,
    references: p.tenders.flatMap((t) => (t.reference ? [t.reference] : [])), byItems: !!p.lines?.length,
  };
}

/** The dashboard's read of a venue's money (venue trading Phase 3). Read-only. */
export class VenuePaymentService {
  static async list(venueIdRaw: string, filters: PaymentFilters, page: number, limit: number) {
    const venueId = oid(venueIdRaw);
    const match: Record<string, unknown> = { venueId, at: { $gte: filters.from, $lt: filters.to } };
    if (filters.method) match['tenders.method'] = filters.method;
    if (filters.staffId) match['takenBy'] = filters.staffId;
    if (filters.merchantId) match['merchantIds'] = oid(filters.merchantId);
    if (filters.source) match['source'] = filters.source;
    if (filters.reference) match['tenders.reference'] = filters.reference;

    const [rows, total, byMethod, open, staff, stalls] = await Promise.all([
      VenuePayment.find(match).sort({ at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean<IVenuePayment[]>(),
      VenuePayment.countDocuments(match),
      // The WHOLE filtered range, never just the page.
      VenuePayment.aggregate<{ _id: TenderMethod; amount: number; tip: number }>([
        { $match: match }, { $unwind: '$tenders' },
        { $group: { _id: '$tenders.method', amount: { $sum: '$tenders.amount' }, tip: { $sum: '$tenders.tip' } } },
      ]),
      // "Now": independent of the date range.
      Table.aggregate<{ unpaid: number }>([
        { $match: { venueId, status: 'open' } },
        { $group: { _id: null, unpaid: { $sum: { $subtract: ['$subtotal', { $ifNull: ['$paidTotal', 0] }] } } } },
      ]),
      VenuePayment.aggregate<{ _id: { id: string; type: string }; name: string }>([
        { $match: { venueId } }, { $sort: { at: 1 } },
        { $group: { _id: { id: '$takenBy', type: '$takenByType' }, name: { $last: '$staffName' } } },
      ]),
      Merchant.find({ venueId }).select('name').sort({ name: 1 }).lean<{ _id: mongoose.Types.ObjectId; name: string }[]>(),
    ]);

    const of = (method: TenderMethod) => byMethod.find((m) => m._id === method) ?? { amount: 0, tip: 0 };
    const [cash, card] = [of('cash'), of('card')];
    return {
      payments: rows.map(toRow),
      totals: { sales: cash.amount + card.amount, cash: cash.amount, card: card.amount, tips: cash.tip + card.tip, cashTips: cash.tip, cardTips: card.tip },
      unpaidOnOpenTables: open[0]?.unpaid ?? 0,
      filterOptions: {
        staff: staff.map((s) => ({ id: s._id.id, name: s.name, type: s._id.type })).sort((a, b) => a.name.localeCompare(b.name)),
        stalls: stalls.map((s) => ({ id: String(s._id), name: s.name })),
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** One payment in full. Null when it is not this venue's. */
  static async detail(venueIdRaw: string, paymentId: string) {
    const venueId = oid(venueIdRaw);
    const payment = await VenuePayment.findOne({ _id: oid(paymentId), venueId }).lean<IVenuePayment | null>();
    if (!payment) return null;
    const row = toRow(payment);
    const head = { ...row, tenders: payment.tenders, applied: payment.applied, tips: payment.tips };

    if (payment.source === 'counter') {
      const charge = await MerchantCharge.findOne({ _id: payment.merchantChargeId, venueId }).select('items').lean();
      const items = (charge?.items ?? []).map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice, lineTotal: i.lineTotal }));
      return { ...head, covers: { kind: 'sale' as const, items } };
    }

    const [table, others] = await Promise.all([
      Table.findOne({ _id: payment.tableId, venueId }).select('label status subtotal paidTotal items').lean(),
      VenuePayment.find({ venueId, tableId: payment.tableId, _id: { $ne: payment._id } }).sort({ at: 1 }).lean<IVenuePayment[]>(),
    ]);
    const lineById = new Map((table?.items ?? []).map((i) => [String(i._id), i]));
    const covers = payment.lines?.length
      ? {
          kind: 'items' as const,
          // A line removed since (it cannot be, once paid) would simply not resolve; a paid line always does.
          items: payment.lines.flatMap((l) => {
            const line = lineById.get(String(l.lineId));
            return line ? [{ name: line.name, qty: l.qty, unitPrice: line.unitPrice, lineTotal: line.unitPrice * l.qty }] : [];
          }),
        }
      : { kind: 'amount' as const };
    return {
      ...head, covers,
      ...(table ? {
        table: {
          id: String(table._id), label: table.label, status: table.status, subtotal: table.subtotal, paidTotal: table.paidTotal ?? 0,
          otherPayments: others.map((p) => ({ id: String(p._id), at: p.at, staffName: p.staffName, applied: p.applied, tips: p.tips })),
        },
      } : {}),
    };
  }
}
```

- [ ] **Step 5: The controller and routes**

`src/controllers/venuePayments.controller.ts`:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import { enumParam, textParam } from '@utils/queryParams.util';
import { parseDayRange } from '@utils/eventTime.util';
import { venueIdOf } from '@middleware/tradingScope.middleware';
import { TENDER_METHODS } from '@interfaces/venuePayment.interface';
import { PaymentFilters, VenuePaymentService } from '@services/venuePayment.service';

const SOURCES = ['table', 'counter'] as const;

/** A positive whole number from a query value: `fallback` when absent, null when it is anything else. */
function positiveInt(value: unknown, fallback: number, max: number): number | null {
  const raw = textParam(value);
  if (raw === null) return null;
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** An object id from a query value: undefined when absent, null when it is not one. */
function idParam(value: unknown): string | undefined | null {
  const raw = textParam(value);
  if (raw === null) return null;
  if (!raw) return undefined;
  return HEX24.test(raw) ? raw : null;
}

/** The Transactions tab: every payment a venue took. Read-only. */
export class VenuePaymentsController {
  /** GET /api/tickets/venue/payments */
  static async list(req: Request, res: Response): Promise<any> {
    const q = req.query;
    const range = parseDayRange(q['from'], q['to']);
    if ('error' in range) return ApiResponseUtil.badRequest(res, range.error);
    const method = enumParam(textParam(q['method']), TENDER_METHODS);
    if (!method) return ApiResponseUtil.badRequest(res, 'Unknown payment method');
    const source = enumParam(textParam(q['source']), SOURCES);
    if (!source) return ApiResponseUtil.badRequest(res, 'Unknown payment source');
    const staffId = idParam(q['staffId']);
    if (staffId === null) return ApiResponseUtil.badRequest(res, 'Invalid staffId');
    const merchantId = idParam(q['merchantId']);
    if (merchantId === null) return ApiResponseUtil.badRequest(res, 'Invalid merchantId');
    const reference = textParam(q['reference']);
    if (reference === null) return ApiResponseUtil.badRequest(res, 'Invalid reference');
    const page = positiveInt(q['page'], 1, 100000);
    if (page === null) return ApiResponseUtil.badRequest(res, 'Invalid page');
    const limit = positiveInt(q['limit'], 25, 100);
    if (limit === null) return ApiResponseUtil.badRequest(res, 'Invalid limit');

    const filters: PaymentFilters = {
      ...range,
      ...(method.value ? { method: method.value } : {}), ...(source.value ? { source: source.value } : {}),
      ...(staffId ? { staffId } : {}), ...(merchantId ? { merchantId } : {}), ...(reference ? { reference } : {}),
    };
    return ApiResponseUtil.success(res, await VenuePaymentService.list(venueIdOf(req), filters, page, limit));
  }

  /** GET /api/tickets/venue/payments/:id */
  static async detail(req: Request, res: Response): Promise<any> {
    const id = String(req.params['id']);
    const payment = HEX24.test(id) ? await VenuePaymentService.detail(venueIdOf(req), id) : null;
    if (!payment) return ApiResponseUtil.notFound(res, 'Payment not found');
    return ApiResponseUtil.success(res, payment);
  }
}
```

`src/routes/venue.route.ts`:

```ts
// Transactions (venue Phase 3): every payment the venue took. Read-only.
router.get('/payments', requireTicketsPermission(VIEW_REVENUE), venueScope, asyncHandler(VenuePaymentsController.list));
router.get('/payments/:id', requireTicketsPermission(VIEW_REVENUE), venueScope, asyncHandler(VenuePaymentsController.detail));
```

- [ ] **Step 6: Run — expect PASS**

Run:
```bash
npx jest src/utils/__tests__/dayRange.test.ts src/routes/__tests__/venuePaymentsAdmin.route.test.ts src/routes/__tests__/adminListOrganizers.types.route.test.ts src/routes/__tests__/adminListOrganizers.route.test.ts src/routes/__tests__/venueStockReports.route.test.ts src/services/__tests__/stockReport.venue.test.ts --runInBand
npx tsc --noEmit -p .
```
Expected: all pass; no existing test edited.

- [ ] **Step 7: Commit**

```bash
git add src/utils/queryParams.util.ts src/utils/eventTime.util.ts src/utils/__tests__/dayRange.test.ts src/controllers/adminOrganizers.controller.ts src/controllers/stockReport.controller.ts src/services/venuePayment.service.ts src/controllers/venuePayments.controller.ts src/routes/venue.route.ts src/routes/__tests__/venuePaymentsAdmin.route.test.ts
git commit -m "feat(venue): dashboard payments — the Transactions list with range totals and filters, and one payment in full"
```

---

### Task 12: Whole-plan verification

No new code. Read every count.

- [ ] **Step 1: The venue selling suites and everything they touched**

```bash
npx jest \
  src/models/__tests__/venueSelling.models.test.ts src/models/__tests__/waiter.model.test.ts src/models/__tests__/table.model.test.ts src/models/__tests__/merchantCharge.model.test.ts src/models/__tests__/merchantChargeWaiter.test.ts src/models/__tests__/tradingScope.models.test.ts \
  src/scripts/__tests__ src/utils/__tests__ src/interfaces/__tests__/waiterPermissions.test.ts \
  src/routes/__tests__/venue src/routes/__tests__/waiter src/routes/__tests__/tableHandover.route.test.ts src/routes/__tests__/tableReport.route.test.ts \
  src/routes/__tests__/merchant src/routes/__tests__/operatorLogin src/routes/__tests__/lowStockAlert.route.test.ts src/routes/__tests__/adminListOrganizers \
  src/services/__tests__/table src/services/__tests__/merchantCharge src/services/__tests__/merchantAuth src/services/__tests__/stockAlert.service.test.ts src/services/__tests__/stockReport src/services/__tests__/stock.service.test.ts src/services/__tests__/operatorEventScope.service.test.ts \
  --runInBand
npx tsc --noEmit -p .
```
Expected: every suite passes, 0 failed; tsc exits 0.

- [ ] **Step 2: Nothing event-side moved**

```bash
git diff --stat 9f68687..HEAD -- 'src/**/__tests__/**' | cat
```
Every PRE-EXISTING test file in that list must be one of: the `TableService.list(` / `forEvent` call-shape edits (Task 5), the one refusal string in `venueTill.route.test.ts` (Task 7), `stockAlert.service.test.ts` (Task 9). Anything else is a violation — report it.

- [ ] **Step 3: Report**

Report the branch, the commits and the counts. Do NOT push or deploy. Deploy order when approved: API (wait for the new revision at 100% traffic) → `MONGODB_URI=… npm run migrate:venue-selling-indexes` on dev, then prod → verify indexes with `Model.diffIndexes()` for Table, Waiter, MerchantCharge, VenuePayment → dashboard (plan 3B) → POS APK (plan 3C, only on request).
