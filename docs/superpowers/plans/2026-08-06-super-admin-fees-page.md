# Super-Admin Fees Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Carrot super admins a "Fees" page showing, per event, the money Carrot has collected (buyer booking fee + platform commission), with a per-payment-method breakdown, an event filter, and a date-range filter.

**Architecture:** Pure read/reporting. A new Mongoose aggregation over `TicketSale` sums `serviceFeeAmount` (booking fee) and `platformFeeAmount` (platform commission) grouped by event and payment method. A new super-admin-guarded endpoint `GET /tickets/admin/fees` exposes it. A new React page `FeesPage.tsx` (modeled on `OrganizersPage.tsx`) renders KPI tiles + an expandable per-event table. No schema change.

**Tech Stack:** Backend — Node/Express, TypeScript, Mongoose, Jest + mongodb-memory-server. Frontend — React 19, Vite, TanStack Query, React Router 7, Tailwind + shadcn-style UI.

## Global Constraints

- Currency is **Emalangeni**, displayed `E x.xx` (2 decimals) for fee amounts. `formatCurrency` from `chartColors.ts` strips decimals — do NOT use it for fee columns; use a 2-dp formatter.
- Fees count **only `paymentStatus === 'completed'`** sales. Pending / failed / refunded are excluded.
- Reuse `round2` from `@utils/serviceFee.util` — do NOT re-implement rounding.
- Super-admin only, both ends: backend `requireSuperAdmin` middleware; frontend `<AdminRoute>` + the `user?.isSuperAdmin` sidebar block. No new `tickets:*` permission.
- Fail loudly (no canned/placeholder fee data on error) — project rule.
- The dashboard API client unwraps `data.data`, so the endpoint's `data` payload is `{ events, totals, pagination }` and the client returns that object directly.
- Working branch: `feat/super-admin-fees`.
- Two repos: API at `carrot-tickets/api`, dashboard at `carrot-tickets/dashboard`. Commit within each repo (they are separate git repos).

---

### Task 1: Backend — fees aggregation service

**Files:**
- Create: `carrot-tickets/api/src/services/fees.service.ts`
- Test: `carrot-tickets/api/src/services/__tests__/fees.service.test.ts`

**Interfaces:**
- Consumes: `TicketSale` model (`@models/ticketSale.model`), `PaymentStatus` (`@interfaces/ticket.interface`), `round2` (`@utils/serviceFee.util`).
- Produces:
  - `FeesService.getFeesByEvent(params: GetFeesByEventParams): Promise<FeesByEventResult>`
  - `GetFeesByEventParams = { startDate?: Date; endDate?: Date; eventId?: string; search?: string; page?: number; limit?: number }`
  - `FeeMethodBreakdown = { method: string; bookingFees: number; platformFees: number; totalFees: number; ticketsSold: number; salesCount: number }`
  - `FeeByEventRow = { eventId: string; eventName: string; ticketsSold: number; faceValue: number; bookingFees: number; platformFees: number; totalFees: number; byMethod: FeeMethodBreakdown[] }`
  - `FeeTotals = { eventCount: number; ticketsSold: number; faceValue: number; bookingFees: number; platformFees: number; totalFees: number }`
  - `FeesByEventResult = { events: FeeByEventRow[]; totals: FeeTotals; pagination: { page: number; limit: number; total: number; totalPages: number } }`

- [ ] **Step 1: Write the failing test**

Create `carrot-tickets/api/src/services/__tests__/fees.service.test.ts`:

```ts
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FeesService } from '@services/fees.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

let mongod: MongoMemoryServer;

const eventA = new mongoose.Types.ObjectId();
const eventB = new mongoose.Types.ObjectId();
const vendor = new mongoose.Types.ObjectId();
const OLD = new Date('2026-01-01T00:00:00Z');
const NEW = new Date('2026-08-01T00:00:00Z');

// Insert straight into the collections so we bypass schema-required fields and
// the saleId pre-save hook — this test only cares about the fee/aggregation math.
async function seed() {
  await mongoose.connection.collection('events').insertMany([
    { _id: eventA, name: 'Alpha Fest', vendorId: vendor },
    { _id: eventB, name: 'Beta Bash', vendorId: vendor },
  ]);
  const base = { vendorId: vendor, ticketIds: [], soldBy: vendor, soldByType: 'Vendor' };
  await mongoose.connection.collection('ticketsales').insertMany([
    // Event A — counts
    { ...base, eventId: eventA, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE, quantity: 2, totalAmount: 200, serviceFeeAmount: 10, platformFeeAmount: 20, soldAt: NEW },
    { ...base, eventId: eventA, paymentMethod: PaymentMethod.PEACH_CARD, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE, quantity: 1, totalAmount: 100, serviceFeeAmount: 10, platformFeeAmount: 10, soldAt: NEW },
    { ...base, eventId: eventA, paymentMethod: PaymentMethod.CASH, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.BOX_OFFICE, quantity: 3, totalAmount: 300, serviceFeeAmount: 0, platformFeeAmount: 30, soldAt: NEW },
    // Event B — counts (older date, for the date-filter test)
    { ...base, eventId: eventB, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE, quantity: 1, totalAmount: 100, serviceFeeAmount: 5, platformFeeAmount: 10, soldAt: OLD },
    // Excluded — refunded + pending
    { ...base, eventId: eventB, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.REFUNDED, channel: SalesChannel.ONLINE, quantity: 1, totalAmount: 100, serviceFeeAmount: 5, platformFeeAmount: 10, soldAt: NEW },
    { ...base, eventId: eventA, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.PENDING, channel: SalesChannel.ONLINE, quantity: 1, totalAmount: 100, serviceFeeAmount: 5, platformFeeAmount: 10, soldAt: NEW },
  ]);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seed();
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('FeesService.getFeesByEvent', () => {
  it('sums booking + platform fees per event, highest total first', async () => {
    const res = await FeesService.getFeesByEvent({});
    expect(res.events).toHaveLength(2);

    const a = res.events[0];
    expect(a.eventId).toBe(eventA.toString());
    expect(a.eventName).toBe('Alpha Fest');
    expect(a.bookingFees).toBe(20);
    expect(a.platformFees).toBe(60);
    expect(a.totalFees).toBe(80);
    expect(a.faceValue).toBe(600);
    expect(a.ticketsSold).toBe(6);

    const b = res.events[1];
    expect(b.eventId).toBe(eventB.toString());
    expect(b.totalFees).toBe(15);
  });

  it('breaks each event down by payment method', async () => {
    const res = await FeesService.getFeesByEvent({});
    const a = res.events.find((e) => e.eventId === eventA.toString())!;
    const momo = a.byMethod.find((m) => m.method === PaymentMethod.MTN_MOMO)!;
    expect(momo).toMatchObject({ bookingFees: 10, platformFees: 20, totalFees: 30, ticketsSold: 2 });
    const cash = a.byMethod.find((m) => m.method === PaymentMethod.CASH)!;
    expect(cash).toMatchObject({ bookingFees: 0, platformFees: 30, totalFees: 30, ticketsSold: 3 });
    expect(a.byMethod).toHaveLength(3);
  });

  it('excludes refunded and pending sales from the totals', async () => {
    const res = await FeesService.getFeesByEvent({});
    expect(res.totals).toMatchObject({
      eventCount: 2, ticketsSold: 7, faceValue: 700,
      bookingFees: 25, platformFees: 70, totalFees: 95,
    });
  });

  it('filters to a single event via eventId', async () => {
    const res = await FeesService.getFeesByEvent({ eventId: eventB.toString() });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].eventId).toBe(eventB.toString());
    expect(res.totals.eventCount).toBe(1);
    expect(res.totals.totalFees).toBe(15);
  });

  it('bounds by soldAt date range', async () => {
    const res = await FeesService.getFeesByEvent({ startDate: new Date('2026-06-01T00:00:00Z') });
    expect(res.events).toHaveLength(1);            // only Event A (NEW), Event B is OLD
    expect(res.events[0].eventId).toBe(eventA.toString());
  });

  it('filters by event name search', async () => {
    const res = await FeesService.getFeesByEvent({ search: 'beta' });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].eventName).toBe('Beta Bash');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd carrot-tickets/api && npx jest src/services/__tests__/fees.service.test.ts`
Expected: FAIL — `Cannot find module '@services/fees.service'`.

- [ ] **Step 3: Write the service**

Create `carrot-tickets/api/src/services/fees.service.ts`:

```ts
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { round2 } from '@utils/serviceFee.util';

export interface FeeMethodBreakdown {
  method: string;
  bookingFees: number;
  platformFees: number;
  totalFees: number;
  ticketsSold: number;
  salesCount: number;
}

export interface FeeByEventRow {
  eventId: string;
  eventName: string;
  ticketsSold: number;
  faceValue: number;    // Σ totalAmount — the organizer's revenue
  bookingFees: number;  // Σ serviceFeeAmount — buyer-paid booking fee
  platformFees: number; // Σ platformFeeAmount — platform commission
  totalFees: number;    // bookingFees + platformFees — Carrot's take
  byMethod: FeeMethodBreakdown[];
}

export interface FeeTotals {
  eventCount: number;
  ticketsSold: number;
  faceValue: number;
  bookingFees: number;
  platformFees: number;
  totalFees: number;
}

export interface FeesByEventResult {
  events: FeeByEventRow[];
  totals: FeeTotals;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface GetFeesByEventParams {
  startDate?: Date;
  endDate?: Date;
  eventId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

const EMPTY_TOTALS: FeeTotals = {
  eventCount: 0, ticketsSold: 0, faceValue: 0, bookingFees: 0, platformFees: 0, totalFees: 0,
};

export class FeesService {
  /**
   * Per-event fees Carrot has collected — booking fee (serviceFeeAmount, buyer-paid
   * online, on top of face) + platform commission (platformFeeAmount, % of face,
   * all channels). Completed sales only. `totals` summarise the whole filtered set
   * (all pages); `events` is one page, highest total fee first.
   */
  static async getFeesByEvent(params: GetFeesByEventParams): Promise<FeesByEventResult> {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 25));

    const match: Record<string, unknown> = { paymentStatus: PaymentStatus.COMPLETED };
    if (params.eventId) match['eventId'] = new mongoose.Types.ObjectId(params.eventId);
    if (params.startDate || params.endDate) {
      const soldAt: Record<string, Date> = {};
      if (params.startDate) soldAt['$gte'] = params.startDate;
      if (params.endDate) soldAt['$lte'] = params.endDate;
      match['soldAt'] = soldAt;
    }

    const nameStage = params.search
      ? [{ $match: { eventName: new RegExp(params.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }]
      : [];

    const agg = await TicketSale.aggregate([
      { $match: match },
      // 1) collapse to event+method buckets
      {
        $group: {
          _id: { eventId: '$eventId', method: '$paymentMethod' },
          bookingFees: { $sum: { $ifNull: ['$serviceFeeAmount', 0] } },
          platformFees: { $sum: { $ifNull: ['$platformFeeAmount', 0] } },
          faceValue: { $sum: { $ifNull: ['$totalAmount', 0] } },
          ticketsSold: { $sum: '$quantity' },
          salesCount: { $sum: 1 },
        },
      },
      // 2) roll methods up into one doc per event, keeping the method breakdown
      {
        $group: {
          _id: '$_id.eventId',
          bookingFees: { $sum: '$bookingFees' },
          platformFees: { $sum: '$platformFees' },
          faceValue: { $sum: '$faceValue' },
          ticketsSold: { $sum: '$ticketsSold' },
          byMethod: {
            $push: {
              method: '$_id.method',
              bookingFees: '$bookingFees',
              platformFees: '$platformFees',
              totalFees: { $add: ['$bookingFees', '$platformFees'] },
              ticketsSold: '$ticketsSold',
              salesCount: '$salesCount',
            },
          },
        },
      },
      { $addFields: { totalFees: { $add: ['$bookingFees', '$platformFees'] } } },
      // 3) attach event name
      { $lookup: { from: 'events', localField: '_id', foreignField: '_id', as: 'event' } },
      { $unwind: '$event' },
      { $addFields: { eventName: '$event.name' } },
      { $project: { event: 0 } },
      ...nameStage,
      // 4) one page of rows + grand totals over the whole filtered set
      {
        $facet: {
          rows: [{ $sort: { totalFees: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
          totals: [
            {
              $group: {
                _id: null,
                eventCount: { $sum: 1 },
                ticketsSold: { $sum: '$ticketsSold' },
                faceValue: { $sum: '$faceValue' },
                bookingFees: { $sum: '$bookingFees' },
                platformFees: { $sum: '$platformFees' },
                totalFees: { $sum: '$totalFees' },
              },
            },
          ],
        },
      },
    ]);

    const facet = agg[0] ?? { rows: [], totals: [] };
    const t = facet.totals[0] ?? EMPTY_TOTALS;

    const totals: FeeTotals = {
      eventCount: t.eventCount ?? 0,
      ticketsSold: t.ticketsSold ?? 0,
      faceValue: round2(t.faceValue ?? 0),
      bookingFees: round2(t.bookingFees ?? 0),
      platformFees: round2(t.platformFees ?? 0),
      totalFees: round2(t.totalFees ?? 0),
    };

    const events: FeeByEventRow[] = (facet.rows as any[]).map((r) => ({
      eventId: String(r._id),
      eventName: r.eventName,
      ticketsSold: r.ticketsSold ?? 0,
      faceValue: round2(r.faceValue ?? 0),
      bookingFees: round2(r.bookingFees ?? 0),
      platformFees: round2(r.platformFees ?? 0),
      totalFees: round2(r.totalFees ?? 0),
      byMethod: (r.byMethod as any[])
        .map((m) => ({
          method: m.method,
          bookingFees: round2(m.bookingFees ?? 0),
          platformFees: round2(m.platformFees ?? 0),
          totalFees: round2(m.totalFees ?? 0),
          ticketsSold: m.ticketsSold ?? 0,
          salesCount: m.salesCount ?? 0,
        }))
        .sort((a, b) => b.totalFees - a.totalFees),
    }));

    return {
      events,
      totals,
      pagination: { page, limit, total: totals.eventCount, totalPages: Math.ceil(totals.eventCount / limit) },
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd carrot-tickets/api && npx jest src/services/__tests__/fees.service.test.ts`
Expected: PASS (all 6 assertions green).

- [ ] **Step 5: Commit**

```bash
cd carrot-tickets/api
git add src/services/fees.service.ts src/services/__tests__/fees.service.test.ts
git commit -m "feat(fees): per-event fee aggregation service (booking + platform)"
```

---

### Task 2: Backend — admin controller + route

**Files:**
- Create: `carrot-tickets/api/src/controllers/adminFees.controller.ts`
- Modify: `carrot-tickets/api/src/routes/tickets.route.ts` (import near line 15; route near line 73, after the `/admin/organizers` routes)
- Test: `carrot-tickets/api/src/controllers/__tests__/adminFees.controller.test.ts`

**Interfaces:**
- Consumes: `FeesService.getFeesByEvent` (Task 1); `ApiResponseUtil` (`@utils/apiResponse.util`); `requireSuperAdmin` (`@middleware/ticketsAuth.middleware`).
- Produces: `AdminFeesController.getFees(req, res)` → `ApiResponseUtil.success(res, FeesByEventResult)` (HTTP body `{ success, data: { events, totals, pagination } }`); route `GET /api/tickets/admin/fees`.

- [ ] **Step 1: Write the failing test**

Create `carrot-tickets/api/src/controllers/__tests__/adminFees.controller.test.ts`. It drives the handler with a mock req/res against in-memory Mongo, so it verifies query-param parsing + response envelope without booting Express:

```ts
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Request, Response } from 'express';
import { AdminFeesController } from '@controllers/adminFees.controller';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

let mongod: MongoMemoryServer;
const eventA = new mongoose.Types.ObjectId();
const vendor = new mongoose.Types.ObjectId();

function mockRes() {
  const res: Partial<Response> & { body?: any; code?: number } = {};
  res.status = ((c: number) => { res.code = c; return res; }) as any;
  res.json = ((b: any) => { res.body = b; return res; }) as any;
  return res as Response & { body: any; code?: number };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await mongoose.connection.collection('events').insertOne({ _id: eventA, name: 'Alpha Fest', vendorId: vendor });
  await mongoose.connection.collection('ticketsales').insertOne({
    eventId: eventA, vendorId: vendor, ticketIds: [], soldBy: vendor, soldByType: 'Vendor',
    paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE,
    quantity: 2, totalAmount: 200, serviceFeeAmount: 10, platformFeeAmount: 20, soldAt: new Date(),
  });
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

it('returns the fees payload wrapped in the success envelope', async () => {
  const req = { query: {} } as unknown as Request;
  const res = mockRes();
  await AdminFeesController.getFees(req, res);
  expect(res.body.success).toBe(true);
  expect(res.body.data.events).toHaveLength(1);
  expect(res.body.data.events[0].totalFees).toBe(30);
  expect(res.body.data.totals.totalFees).toBe(30);
  expect(res.body.data.pagination).toMatchObject({ page: 1, total: 1 });
});

it('passes eventId + date query params through to the service', async () => {
  const req = { query: { eventId: eventA.toString(), startDate: '2020-01-01', page: '1', limit: '25' } } as unknown as Request;
  const res = mockRes();
  await AdminFeesController.getFees(req, res);
  expect(res.body.data.events).toHaveLength(1);
  expect(res.body.data.events[0].eventId).toBe(eventA.toString());
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd carrot-tickets/api && npx jest src/controllers/__tests__/adminFees.controller.test.ts`
Expected: FAIL — `Cannot find module '@controllers/adminFees.controller'`.

- [ ] **Step 3: Write the controller**

Create `carrot-tickets/api/src/controllers/adminFees.controller.ts`:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { FeesService } from '@services/fees.service';

/**
 * Fees admin API — the "Fees" tab. Super-admin only (gated in the route).
 * Reports the fees Carrot has collected per event: booking fee + platform
 * commission, with a per-payment-method breakdown.
 */
export class AdminFeesController {
  /**
   * GET /api/tickets/admin/fees?search=&eventId=&startDate=&endDate=&page=&limit=
   */
  static async getFees(req: Request, res: Response): Promise<any> {
    try {
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '25'), 10) || 25));
      const search = String(req.query['search'] ?? '').trim();
      const eventId = String(req.query['eventId'] ?? '').trim();

      const startRaw = String(req.query['startDate'] ?? '').trim();
      const endRaw = String(req.query['endDate'] ?? '').trim();
      const startDate = startRaw ? new Date(startRaw) : undefined;
      const endDate = endRaw ? new Date(endRaw) : undefined;

      const result = await FeesService.getFeesByEvent({
        page,
        limit,
        search: search || undefined,
        eventId: eventId || undefined,
        startDate: startDate && !isNaN(startDate.getTime()) ? startDate : undefined,
        endDate: endDate && !isNaN(endDate.getTime()) ? endDate : undefined,
      });

      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get fees by event error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load fees', 500);
    }
  }
}
```

- [ ] **Step 4: Wire the route**

In `carrot-tickets/api/src/routes/tickets.route.ts`, add the import beside the other admin-controller imports (near line 15):

```ts
import { AdminFeesController } from '@controllers/adminFees.controller';
```

And add the route immediately after the `/admin/organizers` block (near line 73):

```ts
router.get('/admin/fees', requireSuperAdmin, AdminFeesController.getFees);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd carrot-tickets/api && npx jest src/controllers/__tests__/adminFees.controller.test.ts`
Expected: PASS (both assertions green).

- [ ] **Step 6: Verify the whole API still type-checks**

Run: `cd carrot-tickets/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd carrot-tickets/api
git add src/controllers/adminFees.controller.ts src/controllers/__tests__/adminFees.controller.test.ts src/routes/tickets.route.ts
git commit -m "feat(fees): super-admin GET /admin/fees endpoint"
```

---

### Task 3: Frontend — types + API client namespace

**Files:**
- Modify: `carrot-tickets/dashboard/src/types/index.ts` (append after `OrganizersListResponse`, ~line 452)
- Modify: `carrot-tickets/dashboard/src/lib/api.ts` (type import block ~line 20-49; new `fees` namespace after the `organizers` namespace, ~line 709)

**Interfaces:**
- Consumes: the endpoint from Task 2.
- Produces: types `FeeMethodBreakdown`, `FeeByEventRow`, `FeeTotals`, `FeesResponse`; client method `apiClient.fees.list(params): Promise<FeesResponse>`.

- [ ] **Step 1: Add the types**

Append to `carrot-tickets/dashboard/src/types/index.ts`:

```ts
// Fees (booking charges) — admin Fees tab
export interface FeeMethodBreakdown {
  method: string;
  bookingFees: number;
  platformFees: number;
  totalFees: number;
  ticketsSold: number;
  salesCount: number;
}

export interface FeeByEventRow {
  eventId: string;
  eventName: string;
  ticketsSold: number;
  faceValue: number;
  bookingFees: number;
  platformFees: number;
  totalFees: number;
  byMethod: FeeMethodBreakdown[];
}

export interface FeeTotals {
  eventCount: number;
  ticketsSold: number;
  faceValue: number;
  bookingFees: number;
  platformFees: number;
  totalFees: number;
}

export interface FeesResponse {
  events: FeeByEventRow[];
  totals: FeeTotals;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
```

- [ ] **Step 2: Add `FeesResponse` to the api.ts type import**

In `carrot-tickets/dashboard/src/lib/api.ts`, add `FeesResponse` to the existing `import type { ... } from '@/types'` block (the one that spans ~line 20-49):

```ts
  FeesResponse,
```

- [ ] **Step 3: Add the `fees` client namespace**

In `carrot-tickets/dashboard/src/lib/api.ts`, add immediately after the `organizers = { ... };` block (which ends ~line 709):

```ts
  // Fees endpoints (super-admin only)
  fees = {
    list: async (params?: {
      search?: string;
      eventId?: string;
      startDate?: string;
      endDate?: string;
      page?: number;
      limit?: number;
    }): Promise<FeesResponse> => {
      const query = new URLSearchParams();
      if (params?.search) query.append('search', params.search);
      if (params?.eventId) query.append('eventId', params.eventId);
      if (params?.startDate) query.append('startDate', params.startDate);
      if (params?.endDate) query.append('endDate', params.endDate);
      if (params?.page) query.append('page', String(params.page));
      if (params?.limit) query.append('limit', String(params.limit));
      return this.request<FeesResponse>(`/tickets/admin/fees?${query.toString()}`);
    },
  };
```

- [ ] **Step 4: Verify it compiles**

Run: `cd carrot-tickets/dashboard && npm run build`
Expected: build succeeds (this is the real gate — `tsc --noEmit` alone misses `noUnusedLocals`, per project convention).

- [ ] **Step 5: Commit**

```bash
cd carrot-tickets/dashboard
git add src/types/index.ts src/lib/api.ts
git commit -m "feat(fees): dashboard types + api client for /admin/fees"
```

---

### Task 4: Frontend — FeesPage, route, and nav

**Files:**
- Create: `carrot-tickets/dashboard/src/pages/FeesPage.tsx`
- Modify: `carrot-tickets/dashboard/src/App.tsx` (import ~line 43; route ~line 94, after `payouts`)
- Modify: `carrot-tickets/dashboard/src/components/layout/Sidebar.tsx` (icon import ~line 4-27; nav entry in the `user?.isSuperAdmin` block ~line 174-179)

**Interfaces:**
- Consumes: `apiClient.fees.list` + `apiClient.events.getEvents` (existing); `FeeByEventRow` (Task 3); `DateRangePicker`/`DateRange`; `SearchableSelect`; `StatsCard`; `Table` primitives; `paymentLabel` (`@/lib/payment`).
- Produces: `FeesPage` component; `/fees` route (super-admin); "Fees" sidebar item.

- [ ] **Step 1: Create the page**

Create `carrot-tickets/dashboard/src/pages/FeesPage.tsx`:

```tsx
import { useState, Fragment } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Receipt, Ticket, Percent, Coins, ChevronRight, ChevronDown } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { paymentLabel } from '@/lib/payment';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatsCard } from '@/components/ui/stats-card';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { DateRangePicker, type DateRange } from '@/components/DateRangePicker';

const PAGE_SIZE = 25;
const money = (v: number) => `E ${(v ?? 0).toFixed(2)}`;

export function FeesPage() {
  const [range, setRange] = useState<DateRange>({ startDate: undefined, endDate: undefined });
  const [eventId, setEventId] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Event picker options — all events (super admin sees every vendor's).
  const { data: eventsData } = useQuery({
    queryKey: ['fees-event-options'],
    queryFn: () => apiClient.events.getEvents({ limit: 500 }),
  });
  const eventOptions = [
    { value: '', label: 'All events' },
    ...(eventsData?.data ?? []).map((e) => ({ value: e._id, label: e.name })),
  ];

  const { data, isLoading } = useQuery({
    queryKey: ['fees', range.startDate, range.endDate, eventId, page],
    queryFn: () =>
      apiClient.fees.list({
        startDate: range.startDate,
        endDate: range.endDate,
        eventId: eventId || undefined,
        page,
        limit: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const events = data?.events ?? [];
  const totals = data?.totals;
  const pagination = data?.pagination;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Fees</h1>
        <p className="text-sm text-slate-500">
          Booking charges Carrot has collected per event — buyer booking fee plus platform commission.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Total Carrot fees"
          value={isLoading && !data ? '—' : money(totals?.totalFees ?? 0)}
          description="Booking fee + platform commission"
          icon={Receipt}
          gradient="from-orange-500 to-orange-600"
        />
        <StatsCard
          title="Booking fees"
          value={isLoading && !data ? '—' : money(totals?.bookingFees ?? 0)}
          description="Buyer-paid per-ticket fee (online)"
          icon={Coins}
          gradient="from-emerald-500 to-emerald-600"
        />
        <StatsCard
          title="Platform commission"
          value={isLoading && !data ? '—' : money(totals?.platformFees ?? 0)}
          description="% of face, all channels"
          icon={Percent}
          gradient="from-indigo-500 to-indigo-600"
        />
        <StatsCard
          title="Tickets sold"
          value={isLoading && !data ? '—' : (totals?.ticketsSold ?? 0).toLocaleString()}
          description="Completed sales in range"
          icon={Ticket}
          gradient="from-slate-500 to-slate-600"
        />
      </div>

      {/* Fees table */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Fees by event</CardTitle>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="sm:w-56">
              <SearchableSelect
                value={eventId}
                onValueChange={(v) => { setEventId(v); setPage(1); }}
                options={eventOptions}
                placeholder="All events"
                searchPlaceholder="Search events…"
              />
            </div>
            <DateRangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Event</TableHead>
                  <TableHead className="text-right">Tickets</TableHead>
                  <TableHead className="text-right">Face value</TableHead>
                  <TableHead className="text-right">Booking fee</TableHead>
                  <TableHead className="text-right">Platform commission</TableHead>
                  <TableHead className="text-right">Total fees</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && !data ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-slate-500 py-8">Loading…</TableCell>
                  </TableRow>
                ) : events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-slate-500 py-8">
                      No fees collected for this filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  events.map((e) => (
                    <Fragment key={e.eventId}>
                      <TableRow className="cursor-pointer hover:bg-slate-50" onClick={() => toggle(e.eventId)}>
                        <TableCell className="text-slate-400">
                          {expanded.has(e.eventId) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell className="font-medium">{e.eventName}</TableCell>
                        <TableCell className="text-right">{e.ticketsSold.toLocaleString()}</TableCell>
                        <TableCell className="text-right text-slate-500">{money(e.faceValue)}</TableCell>
                        <TableCell className="text-right">{money(e.bookingFees)}</TableCell>
                        <TableCell className="text-right">{money(e.platformFees)}</TableCell>
                        <TableCell className="text-right font-semibold">{money(e.totalFees)}</TableCell>
                      </TableRow>
                      {expanded.has(e.eventId) && (
                        <TableRow className="bg-slate-50/60">
                          <TableCell />
                          <TableCell colSpan={6} className="py-2">
                            <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">By payment method</div>
                            <table className="w-full text-sm">
                              <tbody>
                                {e.byMethod.map((m) => (
                                  <tr key={m.method} className="text-slate-600">
                                    <td className="py-1">{paymentLabel(m.method)}</td>
                                    <td className="py-1 text-right">{m.ticketsSold.toLocaleString()} tix</td>
                                    <td className="py-1 text-right">Booking {money(m.bookingFees)}</td>
                                    <td className="py-1 text-right">Commission {money(m.platformFees)}</td>
                                    <td className="py-1 text-right font-medium">{money(m.totalFees)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {pagination && pagination.total > 0 && (
            <div className="flex items-center justify-between pt-4 text-sm text-slate-500">
              <span>
                Page {pagination.page} of {pagination.totalPages} · {pagination.total.toLocaleString()} events
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1 || isLoading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= pagination.totalPages || isLoading} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Register the route**

In `carrot-tickets/dashboard/src/App.tsx`, add the import beside the other page imports (near line 43):

```ts
import { FeesPage } from '@/pages/FeesPage';
```

And add the route right after the `payouts` route (near line 94):

```tsx
<Route path="fees" element={<AdminRoute><FeesPage /></AdminRoute>} />
```

- [ ] **Step 3: Add the sidebar nav item**

In `carrot-tickets/dashboard/src/components/layout/Sidebar.tsx`, add `Receipt` to the lucide-react import block (near line 4-27):

```ts
  Receipt,
```

And add the nav entry inside the `user?.isSuperAdmin` array (near line 174-179), after `Payouts`:

```ts
      { name: 'Fees', href: '/fees', icon: Receipt, show: true },
```

- [ ] **Step 4: Verify it builds**

Run: `cd carrot-tickets/dashboard && npm run build`
Expected: build succeeds, no TS/unused-import errors.

- [ ] **Step 5: Live verification in the dashboard preview**

Start the dashboard dev server (Browser pane `preview_start`, do NOT use Bash). Log in as a **super-admin** account, then:
- Confirm a "Fees" item appears in the sidebar (and is absent for a non-super-admin login).
- Open `/fees`: KPI tiles populate, the table lists events sorted by total fees, and a row expands to show the per-method breakdown.
- Pick a single event in the event filter → the table narrows to that event and the tiles update.
- Change the date range → results update.
- Check `read_console_messages` and `read_network_requests` — the page calls `GET /tickets/admin/fees` and returns 200, no console errors.

Capture a screenshot of the working page for the user.

- [ ] **Step 6: Commit**

```bash
cd carrot-tickets/dashboard
git add src/pages/FeesPage.tsx src/App.tsx src/components/layout/Sidebar.tsx
git commit -m "feat(fees): super-admin Fees page with per-event + per-method breakdown"
```

---

## Self-Review Notes

- **Spec coverage:** booking fee + platform commission (Task 1 sums both) ✓; per-event + per-method breakdown (Task 1 `byMethod`, Task 4 expandable rows) ✓; date filter (Tasks 1/2/4) ✓; filter-by-event (Task 1 `eventId`, Task 4 picker) ✓; super-admin gating (Task 2 `requireSuperAdmin`, Task 4 `AdminRoute` + sidebar block) ✓; completed-only, refunds excluded (Task 1 test) ✓; fail-loud error path (Task 2 catch → 500; Task 4 empty-state, no canned data) ✓; `E x.xx` formatting (Task 4 `money`) ✓.
- **Type consistency:** `FeesByEventResult`/`FeesResponse` field name `events` matches the client unwrap and the page (`data.events`); `byMethod` shape identical backend/frontend; `round2` reused, not re-declared.
- **No placeholders:** every code step is complete and runnable.
