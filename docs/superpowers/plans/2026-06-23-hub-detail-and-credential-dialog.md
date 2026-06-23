# Hub Detail + Operator Credential Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable copy/print operator-credentials dialog, and make hubs clickable drill-in pages with KPI + per-operator analytics (date-filtered), on both the super-admin dashboard and the in-portal reseller views.

**Architecture:** Backend adds a shared `HubAnalyticsService` aggregating completed `TicketSale`s by `hubId`, exposed through super-admin (`/api/admin`) and scope-enforced portal (`/api/reseller`) endpoints. Frontend adds a reusable `OperatorCredentialsDialog` (replacing credential toasts) and four new pages (super-admin + portal hub list/detail) consuming the analytics.

**Tech Stack:** TypeScript, Express, Mongoose aggregation, Jest + supertest (api); React, Vite, TanStack Query, react-router-dom, sonner, existing `DateRangePicker`/`StatsCard`/shadcn UI (dashboard).

## Global Constraints

- Analytics match `TicketSale` `{ hubId, paymentStatus: 'completed' }`; with a date range, add `soldAt: { $gte: from, $lte: to }` (use `soldAt`, NOT `createdAt` — matches the settlement service convention).
- KPI shape (verbatim, used by API + dashboard): `{ hubId, revenue, ticketsSold, salesCount, operatorsCount, byOperator: [{ operatorId, fullName, loginCode, salesCount, revenue, ticketsSold }] }`. Money rounded to 2 dp.
- `byOperator` includes every operator in the hub, even with zero sales in range (zeroed).
- Portal endpoints derive scope from `req.reseller` (JWT), never client: `reseller_admin` → its `resellerId`; `reseller_hub_manager` → its own `hubId`. Out-of-scope hub → 404. A hub_manager passing a foreign `?hubId` → 403.
- Portal hub read endpoints gated by `ResellerPermission.VIEW_HUB_SALES`; operator create/reset stay gated by `MANAGE_OPERATORS`.
- No silent fallbacks: every fetch/clipboard/print failure surfaces via toast/error state.
- Credentials (loginCode/pin) are shown via the dialog, never logged.
- API repo: `~/Documents/omevision/contracts/carrot-tickets/api`. Dashboard: `~/Documents/omevision/contracts/carrot-tickets/dashboard`. API tests: `npx jest <path>` from `api/`. Dashboard gate: `npx tsc -p tsconfig.app.json --noEmit` then `npx vite build` from `dashboard/`.
- Commit message bodies end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 1: HubAnalyticsService

**Files:**
- Create: `api/src/services/hubAnalytics.service.ts`
- Test: `api/src/services/__tests__/hubAnalytics.service.test.ts`

**Interfaces:**
- Consumes: `seedOperator`/`seedReseller` fixtures (`src/__tests__/helpers/fixtures.ts`); `TicketSale`, `ResellerOperator` models.
- Produces: `HubAnalyticsService.getHubAnalytics(hubId: string, from?: Date, to?: Date): Promise<HubAnalytics>` and the exported `HubAnalytics` / `HubOperatorStat` interfaces (shape per Global Constraints).

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/services/__tests__/hubAnalytics.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedOperator } from '../../__tests__/helpers/fixtures';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { HubAnalyticsService } from '@services/hubAnalytics.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function sale(opts: {
  resellerId: string; hubId: string; soldBy: string;
  amount: number; qty: number; status?: PaymentStatus; soldAt?: Date;
}) {
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: Array.from({ length: opts.qty }, () => new mongoose.Types.ObjectId()),
    quantity: opts.qty,
    totalAmount: opts.amount,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: opts.status ?? PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(opts.soldBy),
    soldByType: 'ResellerOperator',
    resellerId: new mongoose.Types.ObjectId(opts.resellerId),
    hubId: new mongoose.Types.ObjectId(opts.hubId),
    soldAt: opts.soldAt ?? new Date(),
  });
}

it('aggregates KPIs and per-operator stats for completed sales only', async () => {
  const a = await seedOperator({ loginCode: '900001' });
  const b = await seedOperator({ resellerId: a.resellerId, hubId: a.hubId, loginCode: '900002' });

  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: a.operator._id.toString(), amount: 100, qty: 2 });
  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: a.operator._id.toString(), amount: 50, qty: 1 });
  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: b.operator._id.toString(), amount: 200, qty: 4 });
  // A pending sale must be excluded.
  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: b.operator._id.toString(), amount: 999, qty: 9, status: PaymentStatus.PENDING });

  const res = await HubAnalyticsService.getHubAnalytics(a.hubId);

  expect(res.revenue).toBe(350);          // 100+50+200, pending excluded
  expect(res.ticketsSold).toBe(7);        // 2+1+4
  expect(res.salesCount).toBe(3);
  expect(res.operatorsCount).toBe(2);

  const byA = res.byOperator.find((o) => o.operatorId === a.operator._id.toString())!;
  const byB = res.byOperator.find((o) => o.operatorId === b.operator._id.toString())!;
  expect(byA.revenue).toBe(150);
  expect(byA.salesCount).toBe(2);
  expect(byA.loginCode).toBe('900001');
  expect(byB.revenue).toBe(200);
  expect(byB.ticketsSold).toBe(4);
});

it('includes zero-sales operators and respects the date range', async () => {
  const a = await seedOperator({ loginCode: '900100' });
  const old = new Date('2020-01-01T00:00:00Z');
  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: a.operator._id.toString(), amount: 100, qty: 1, soldAt: old });

  // Range that excludes the 2020 sale.
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-12-31T23:59:59Z');
  const res = await HubAnalyticsService.getHubAnalytics(a.hubId, from, to);

  expect(res.revenue).toBe(0);
  expect(res.salesCount).toBe(0);
  expect(res.operatorsCount).toBe(1);
  expect(res.byOperator).toHaveLength(1);
  expect(res.byOperator[0]!.revenue).toBe(0); // zero-sales operator still listed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/__tests__/hubAnalytics.service.test.ts`
Expected: FAIL — cannot find module `@services/hubAnalytics.service`.

- [ ] **Step 3: Write the service**

```typescript
// api/src/services/hubAnalytics.service.ts
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { ResellerOperator } from '@models/resellerOperator.model';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface HubOperatorStat {
  operatorId: string;
  fullName: string;
  loginCode: string;
  salesCount: number;
  revenue: number;
  ticketsSold: number;
}

export interface HubAnalytics {
  hubId: string;
  revenue: number;
  ticketsSold: number;
  salesCount: number;
  operatorsCount: number;
  byOperator: HubOperatorStat[];
}

export class HubAnalyticsService {
  static async getHubAnalytics(hubId: string, from?: Date, to?: Date): Promise<HubAnalytics> {
    const hubOid = new mongoose.Types.ObjectId(hubId);
    const match: Record<string, unknown> = { hubId: hubOid, paymentStatus: 'completed' };
    if (from && to) match['soldAt'] = { $gte: from, $lte: to };

    const [totalsRow] = await TicketSale.aggregate([
      { $match: match },
      { $group: { _id: null, revenue: { $sum: '$totalAmount' }, ticketsSold: { $sum: '$quantity' }, salesCount: { $sum: 1 } } },
    ]);

    const perOp = await TicketSale.aggregate([
      { $match: { ...match, soldByType: 'ResellerOperator' } },
      { $group: { _id: '$soldBy', revenue: { $sum: '$totalAmount' }, ticketsSold: { $sum: '$quantity' }, salesCount: { $sum: 1 } } },
    ]);
    const statByOp = new Map<string, { revenue: number; ticketsSold: number; salesCount: number }>();
    for (const r of perOp) {
      statByOp.set(String(r._id), { revenue: r.revenue, ticketsSold: r.ticketsSold, salesCount: r.salesCount });
    }

    const operators = await ResellerOperator.find({ hubId: hubOid }).select('fullName loginCode');
    const byOperator: HubOperatorStat[] = operators.map((op) => {
      const s = statByOp.get(String(op._id)) ?? { revenue: 0, ticketsSold: 0, salesCount: 0 };
      return {
        operatorId: String(op._id),
        fullName: op.fullName,
        loginCode: op.loginCode,
        salesCount: s.salesCount,
        revenue: round2(s.revenue),
        ticketsSold: s.ticketsSold,
      };
    });

    return {
      hubId,
      revenue: round2(totalsRow?.revenue ?? 0),
      ticketsSold: totalsRow?.ticketsSold ?? 0,
      salesCount: totalsRow?.salesCount ?? 0,
      operatorsCount: operators.length,
      byOperator,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/services/__tests__/hubAnalytics.service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd api && git add src/services/hubAnalytics.service.ts src/services/__tests__/hubAnalytics.service.test.ts
git commit -m "feat(hubs): add hub analytics aggregation service"
```

---

## Task 2: Super-admin hub detail + analytics endpoints

**Files:**
- Modify: `api/src/controllers/resellerAdmin.controller.ts` (add `getHub`, `getHubAnalytics`)
- Modify: `api/src/routes/resellerAdmin.route.ts`
- Modify: `api/src/routes/__tests__/resellerAdmin.route.test.ts`

**Interfaces:**
- Consumes: `HubAnalyticsService.getHubAnalytics` (Task 1); existing `parseDate` helper in `resellerAdmin.controller.ts`; `signSuperAdminToken()` + `seedReseller`/`seedOperator` in tests.
- Produces: `GET /api/admin/hubs/:hubId` → `{ ...hub }`; `GET /api/admin/hubs/:hubId/analytics?from&to` → `HubAnalytics`.

- [ ] **Step 1: Write failing route tests**

Add to `api/src/routes/__tests__/resellerAdmin.route.test.ts` (it already imports `signSuperAdminToken`, `connectTestDb` from `helpers/db`; add `seedReseller` from `helpers/fixtures` if not present):

```typescript
it('super-admin gets a single hub and its analytics', async () => {
  const { hubId } = await seedReseller();
  const token = signSuperAdminToken();

  const hub = await request(app).get(`/api/admin/hubs/${hubId}`).set('Authorization', `Bearer ${token}`);
  expect(hub.status).toBe(200);
  expect(hub.body.data._id).toBe(hubId);

  const analytics = await request(app).get(`/api/admin/hubs/${hubId}/analytics`).set('Authorization', `Bearer ${token}`);
  expect(analytics.status).toBe(200);
  expect(analytics.body.data).toMatchObject({ hubId, revenue: 0, ticketsSold: 0, salesCount: 0 });
  expect(Array.isArray(analytics.body.data.byOperator)).toBe(true);
});

it('returns 404 for an unknown hub', async () => {
  const token = signSuperAdminToken();
  const missing = new (require('mongoose').Types.ObjectId)().toString();
  const res = await request(app).get(`/api/admin/hubs/${missing}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/routes/__tests__/resellerAdmin.route.test.ts`
Expected: FAIL — routes 404 / not registered.

- [ ] **Step 3: Add controller methods**

In `api/src/controllers/resellerAdmin.controller.ts`, add the import near the top:

```typescript
import { HubAnalyticsService } from '@services/hubAnalytics.service';
```

Add these methods inside the `ResellerAdminController` class (e.g. after `listHubs`):

```typescript
  static async getHub(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await ResellerHub.findById(req.params['hubId']);
      if (!hub) {
        ApiResponseUtil.notFound(res, 'Hub not found');
        return;
      }
      ApiResponseUtil.success(res, hub);
    } catch (err: any) {
      next(err);
    }
  }

  static async getHubAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await ResellerHub.findById(req.params['hubId']);
      if (!hub) {
        ApiResponseUtil.notFound(res, 'Hub not found');
        return;
      }
      let from: Date | undefined;
      let to: Date | undefined;
      if (req.query['from'] && req.query['to']) {
        const f = parseDate(req.query['from'], 'from', res);
        if (!f) return;
        const t = parseDate(req.query['to'], 'to', res);
        if (!t) return;
        from = f; to = t;
      }
      const analytics = await HubAnalyticsService.getHubAnalytics(req.params['hubId']!, from, to);
      ApiResponseUtil.success(res, analytics);
    } catch (err: any) {
      next(err);
    }
  }
```

- [ ] **Step 4: Wire the routes**

In `api/src/routes/resellerAdmin.route.ts`, in the Hubs section add:

```typescript
router.get('/hubs/:hubId', ResellerAdminController.getHub);
router.get('/hubs/:hubId/analytics', ResellerAdminController.getHubAnalytics);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && npx jest src/routes/__tests__/resellerAdmin.route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd api && git add src/controllers/resellerAdmin.controller.ts src/routes/resellerAdmin.route.ts src/routes/__tests__/resellerAdmin.route.test.ts
git commit -m "feat(hubs): super-admin hub detail + analytics endpoints"
```

---

## Task 3: Portal hub endpoints + operator hubId filter

**Files:**
- Create: `api/src/controllers/resellerHubAdmin.controller.ts`
- Modify: `api/src/controllers/resellerOperatorAdmin.controller.ts` (add optional `hubId` filter to `list`)
- Modify: `api/src/routes/reseller.route.ts`
- Create: `api/src/routes/__tests__/resellerHubs.route.test.ts`

**Interfaces:**
- Consumes: `HubAnalyticsService` (Task 1); `authenticateReseller`, `requireResellerPermission`, `ResellerPermission.VIEW_HUB_SALES`/`MANAGE_OPERATORS`; `ResellerHub` model; `seedOperator` fixture.
- Produces: `GET /reseller/hubs`, `GET /reseller/hubs/:hubId`, `GET /reseller/hubs/:hubId/analytics?from&to` (all `VIEW_HUB_SALES`, scope-enforced); `GET /reseller/operators?hubId=` filter behavior.

- [ ] **Step 1: Write failing scope tests**

```typescript
// api/src/routes/__tests__/resellerHubs.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { seedOperator, seedReseller } from '../../__tests__/helpers/fixtures';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function tokenFor(role: string) {
  const seeded = await seedOperator({ role, pin: '123456' });
  const login = await request(app).post('/api/reseller/auth/login').send({ loginCode: seeded.loginCode, pin: '123456' });
  return { token: login.body.data.accessToken as string, ...seeded };
}

it('admin lists hubs in their reseller; hub_manager sees only their hub', async () => {
  const admin = await tokenFor('reseller_admin');
  const res = await request(app).get('/api/reseller/hubs').set('Authorization', `Bearer ${admin.token}`);
  expect(res.status).toBe(200);
  for (const h of res.body.data) expect(h.resellerId).toBe(admin.resellerId);

  const mgr = await tokenFor('reseller_hub_manager');
  const res2 = await request(app).get('/api/reseller/hubs').set('Authorization', `Bearer ${mgr.token}`);
  expect(res2.status).toBe(200);
  for (const h of res2.body.data) expect(h._id).toBe(mgr.hubId);
});

it('a plain operator cannot view hubs (403)', async () => {
  const op = await tokenFor('reseller_operator');
  const res = await request(app).get('/api/reseller/hubs').set('Authorization', `Bearer ${op.token}`);
  expect(res.status).toBe(403);
});

it('admin gets analytics for own hub; cross-reseller hub → 404', async () => {
  const admin = await tokenFor('reseller_admin');
  const ok = await request(app).get(`/api/reseller/hubs/${admin.hubId}/analytics`).set('Authorization', `Bearer ${admin.token}`);
  expect(ok.status).toBe(200);
  expect(ok.body.data.hubId).toBe(admin.hubId);

  const other = await seedReseller();
  const denied = await request(app).get(`/api/reseller/hubs/${other.hubId}/analytics`).set('Authorization', `Bearer ${admin.token}`);
  expect(denied.status).toBe(404);
});

it('operator list accepts a hubId filter within scope', async () => {
  const admin = await tokenFor('reseller_admin');
  const res = await request(app).get(`/api/reseller/operators?hubId=${admin.hubId}`).set('Authorization', `Bearer ${admin.token}`);
  expect(res.status).toBe(200);
  for (const o of res.body.data) expect(o.hubId).toBe(admin.hubId);

  // hub_manager passing a foreign hub → 403
  const mgr = await tokenFor('reseller_hub_manager');
  const foreign = await seedReseller();
  const denied = await request(app).get(`/api/reseller/operators?hubId=${foreign.hubId}`).set('Authorization', `Bearer ${mgr.token}`);
  expect(denied.status).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/routes/__tests__/resellerHubs.route.test.ts`
Expected: FAIL — hub routes 404.

- [ ] **Step 3: Write the portal hub controller**

```typescript
// api/src/controllers/resellerHubAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { ResellerHub } from '@models/resellerHub.model';
import { HubAnalyticsService } from '@services/hubAnalytics.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/** Load a hub only if it is within the actor's scope, else null. */
async function findScopedHub(actor: any, hubId: string) {
  const hub = await ResellerHub.findById(hubId);
  if (!hub) return null;
  if (actor.role === 'reseller_hub_manager') {
    return hub._id.toString() === actor.hubId ? hub : null;
  }
  return hub.resellerId.toString() === actor.resellerId ? hub : null;
}

function parseDate(raw: unknown, fieldName: string, res: Response): Date | null {
  const d = new Date(raw as string);
  if (isNaN(d.getTime())) {
    ApiResponseUtil.badRequest(res, `Invalid date for '${fieldName}'`);
    return null;
  }
  return d;
}

export class ResellerHubAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const filter = actor.role === 'reseller_hub_manager'
        ? { _id: actor.hubId }
        : { resellerId: actor.resellerId };
      const hubs = await ResellerHub.find(filter).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, hubs);
    } catch (err: any) {
      next(err);
    }
  }

  static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await findScopedHub((req as any).reseller, req.params['hubId']!);
      if (!hub) {
        ApiResponseUtil.notFound(res, 'Hub not found');
        return;
      }
      ApiResponseUtil.success(res, hub);
    } catch (err: any) {
      next(err);
    }
  }

  static async analytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await findScopedHub((req as any).reseller, req.params['hubId']!);
      if (!hub) {
        ApiResponseUtil.notFound(res, 'Hub not found');
        return;
      }
      let from: Date | undefined;
      let to: Date | undefined;
      if (req.query['from'] && req.query['to']) {
        const f = parseDate(req.query['from'], 'from', res);
        if (!f) return;
        const t = parseDate(req.query['to'], 'to', res);
        if (!t) return;
        from = f; to = t;
      }
      const analytics = await HubAnalyticsService.getHubAnalytics(req.params['hubId']!, from, to);
      ApiResponseUtil.success(res, analytics);
    } catch (err: any) {
      next(err);
    }
  }
}
```

- [ ] **Step 4: Add the `hubId` filter to operator `list`**

In `api/src/controllers/resellerOperatorAdmin.controller.ts`, replace the `list` method with:

```typescript
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const filter: Record<string, unknown> = scopeFilter(actor);
      const requestedHubId = req.query['hubId'];
      if (typeof requestedHubId === 'string' && requestedHubId) {
        if (actor.role === 'reseller_hub_manager' && requestedHubId !== actor.hubId) {
          ApiResponseUtil.forbidden(res, 'Hub is outside your scope');
          return;
        }
        filter['hubId'] = requestedHubId;
      }
      const operators = await ResellerOperator.find(filter).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, operators);
    } catch (err: any) {
      next(err);
    }
  }
```

(For `reseller_admin`, `scopeFilter` returns `{ resellerId }`, so adding `hubId` scopes to a hub within the reseller — a foreign hubId simply yields no rows, which is acceptable. The explicit 403 is only required for hub_manager, matching the test.)

- [ ] **Step 5: Wire the routes**

In `api/src/routes/reseller.route.ts`, add the import and routes (alongside the operator routes, after `router.use(authenticateReseller)`):

```typescript
import { ResellerHubAdminController } from '@controllers/resellerHubAdmin.controller';

// Hubs (VIEW_HUB_SALES)
router.get('/hubs',
  requireResellerPermission(ResellerPermission.VIEW_HUB_SALES),
  ResellerHubAdminController.list);
router.get('/hubs/:hubId',
  requireResellerPermission(ResellerPermission.VIEW_HUB_SALES),
  ResellerHubAdminController.get);
router.get('/hubs/:hubId/analytics',
  requireResellerPermission(ResellerPermission.VIEW_HUB_SALES),
  ResellerHubAdminController.analytics);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && npx jest src/routes/__tests__/resellerHubs.route.test.ts src/routes/__tests__/resellerOperators.route.test.ts`
Expected: PASS (new hub tests + existing operator tests still green). Then `npx tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
cd api && git add src/controllers/resellerHubAdmin.controller.ts src/controllers/resellerOperatorAdmin.controller.ts src/routes/reseller.route.ts src/routes/__tests__/resellerHubs.route.test.ts
git commit -m "feat(hubs): portal hub list/detail/analytics + operator hubId filter"
```

---

## Task 4: `OperatorCredentialsDialog` + super-admin Operators tab rewire

**Files:**
- Create: `dashboard/src/components/OperatorCredentialsDialog.tsx`
- Modify: `dashboard/src/pages/ResellerDetailPage.tsx` (`OperatorsTab`: use the dialog for create + reset)

**Interfaces:**
- Produces: `OperatorCredentialsDialog` React component with props
  `{ open: boolean; onClose: () => void; title: string; loginCode?: string; pin: string; businessName?: string; hubName?: string }`.

- [ ] **Step 1: Create the dialog component**

```tsx
// dashboard/src/components/OperatorCredentialsDialog.tsx
import { toast } from 'sonner';
import { Copy, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface OperatorCredentialsDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  loginCode?: string;
  pin: string;
  businessName?: string;
  hubName?: string;
}

export function OperatorCredentialsDialog({
  open, onClose, title, loginCode, pin, businessName, hubName,
}: OperatorCredentialsDialogProps) {
  const copyText = `${loginCode ? `User ID: ${loginCode}\n` : ''}PIN: ${pin}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      toast.success('Credentials copied');
    } catch {
      toast.error('Could not copy — please write them down');
    }
  };

  const handlePrint = () => {
    const w = window.open('', '_blank', 'width=420,height=520');
    if (!w) {
      toast.error('Could not open print window (popup blocked)');
      return;
    }
    w.document.write(`<!doctype html><html><head><title>Operator Credentials</title>
      <style>
        body{font-family:system-ui,sans-serif;padding:32px;color:#0f172a}
        h1{font-size:18px;margin:0 0 4px}
        .sub{color:#64748b;font-size:13px;margin-bottom:24px}
        .row{margin:16px 0}
        .label{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em}
        .value{font-size:32px;font-weight:700;font-family:ui-monospace,monospace;letter-spacing:.1em}
        .warn{margin-top:28px;font-size:12px;color:#b91c1c}
      </style></head><body>
      <h1>${businessName ?? 'Carrot Tickets'}</h1>
      <div class="sub">${hubName ? `Hub: ${hubName}` : 'Operator credentials'}</div>
      ${loginCode ? `<div class="row"><div class="label">User ID</div><div class="value">${loginCode}</div></div>` : ''}
      <div class="row"><div class="label">PIN</div><div class="value">${pin}</div></div>
      <div class="warn">Keep confidential — do not share. PIN can only be reset, not recovered.</div>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {loginCode && (
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">User ID</p>
              <p className="text-3xl font-bold font-mono tracking-widest text-slate-900">{loginCode}</p>
            </div>
          )}
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">PIN</p>
            <p className="text-3xl font-bold font-mono tracking-widest text-slate-900">{pin}</p>
          </div>
          <p className="text-xs text-red-600">
            Shown once. Keep it confidential — the PIN can be reset but never recovered.
          </p>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleCopy}>
            <Copy className="h-4 w-4 mr-2" /> Copy
          </Button>
          <Button variant="outline" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-2" /> Print
          </Button>
          <Button
            onClick={onClose}
            className="bg-gradient-to-r from-orange-600 to-amber-600 text-white hover:opacity-90"
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> If `@/components/ui/dialog` does not export `DialogFooter`, use a `<div className="flex justify-end gap-2 pt-2">` wrapper instead — check the existing dialog usage in `ResellerDetailPage.tsx` first.

- [ ] **Step 2: Wire it into `OperatorsTab` (create + reset)**

In `dashboard/src/pages/ResellerDetailPage.tsx`, import the dialog and add credential state to `OperatorsTab`:

```tsx
import { OperatorCredentialsDialog } from '@/components/OperatorCredentialsDialog';
```

```tsx
  const [issued, setIssued] = useState<{ title: string; loginCode?: string; pin: string } | null>(null);
```

Change the `createOperator` mutation `onSuccess` to open the dialog instead of the credential toast:

```tsx
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['operators', selectedHubId] });
      toast.success('Operator created');
      setIssued({ title: 'Operator created', loginCode: res.loginCode, pin: res.pin });
      setIsAddOpen(false);
      setForm({ fullName: '', phoneNumber: '', email: '', role: 'reseller_operator' });
    },
```

Change the `resetPin` mutation `onSuccess`:

```tsx
    onSuccess: (res) => setIssued({ title: 'PIN reset', pin: res.pin }),
```

Render the dialog once inside `OperatorsTab`'s returned JSX (e.g. just before the closing tag):

```tsx
      {issued && (
        <OperatorCredentialsDialog
          open={!!issued}
          onClose={() => setIssued(null)}
          title={issued.title}
          loginCode={issued.loginCode}
          pin={issued.pin}
        />
      )}
```

- [ ] **Step 3: Type-check**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit`
Expected: clean. The credential toasts in `OperatorsTab` are now replaced by the dialog; non-credential toasts remain.

- [ ] **Step 4: Commit**

```bash
cd dashboard && git add src/components/OperatorCredentialsDialog.tsx src/pages/ResellerDetailPage.tsx
git commit -m "feat(operators): durable copy/print credentials dialog (super-admin)"
```

---

## Task 5: Super-admin hub detail page + clickable hubs

**Files:**
- Modify: `dashboard/src/lib/api.ts` (`resellerAdmin`: add `getHub`, `getHubAnalytics`)
- Modify: `dashboard/src/types/reseller.ts` (add `HubAnalytics` type)
- Create: `dashboard/src/pages/HubDetailPage.tsx`
- Modify: `dashboard/src/App.tsx` (add route `/resellers/:id/hubs/:hubId`)
- Modify: `dashboard/src/pages/ResellerDetailPage.tsx` (`HubsTab`: rows clickable → navigate)

**Interfaces:**
- Consumes: super-admin endpoints (Task 2); `OperatorCredentialsDialog` (Task 4); existing `DateRangePicker`, `StatsCard`, `apiClient.resellerAdmin.listOperators/createOperator/resetOperatorPin`.
- Produces: `apiClient.resellerAdmin.getHub(hubId)`, `apiClient.resellerAdmin.getHubAnalytics(hubId, from?, to?)`; `HubAnalytics`/`HubOperatorStat` types.

- [ ] **Step 1: Add the `HubAnalytics` type**

In `dashboard/src/types/reseller.ts` add:

```typescript
export interface HubOperatorStat {
  operatorId: string;
  fullName: string;
  loginCode: string;
  salesCount: number;
  revenue: number;
  ticketsSold: number;
}

export interface HubAnalytics {
  hubId: string;
  revenue: number;
  ticketsSold: number;
  salesCount: number;
  operatorsCount: number;
  byOperator: HubOperatorStat[];
}
```

- [ ] **Step 2: Add admin API client methods**

In `dashboard/src/lib/api.ts`, in the `resellerAdmin` object, add (import `HubAnalytics` from `@/types` where the other reseller types are imported):

```typescript
    getHub: async (hubId: string): Promise<ResellerHub> =>
      this.request<ResellerHub>(`/admin/hubs/${hubId}`),

    getHubAnalytics: async (hubId: string, from?: string, to?: string): Promise<HubAnalytics> => {
      const qs = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
      return this.request<HubAnalytics>(`/admin/hubs/${hubId}/analytics${qs}`);
    },
```

- [ ] **Step 3: Create the hub detail page**

```tsx
// dashboard/src/pages/HubDetailPage.tsx
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, DollarSign, Ticket, Receipt, Users } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { StatsCard } from '@/components/ui/stats-card';
import { DateRangePicker, type DateRange } from '@/components/DateRangePicker';
import { OperatorCredentialsDialog } from '@/components/OperatorCredentialsDialog';

export function HubDetailPage() {
  const { id, hubId } = useParams<{ id: string; hubId: string }>();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<DateRange>({ startDate: undefined, endDate: undefined });
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [form, setForm] = useState({ fullName: '', role: 'reseller_operator' });
  const [issued, setIssued] = useState<{ title: string; loginCode?: string; pin: string } | null>(null);

  const { data: hub } = useQuery({
    queryKey: ['hub', hubId],
    queryFn: () => apiClient.resellerAdmin.getHub(hubId!),
    enabled: !!hubId,
  });

  const { data: analytics } = useQuery({
    queryKey: ['hub-analytics', hubId, range.startDate, range.endDate],
    queryFn: () => apiClient.resellerAdmin.getHubAnalytics(hubId!, range.startDate, range.endDate),
    enabled: !!hubId,
  });

  const { data: operators = [] } = useQuery({
    queryKey: ['operators', hubId],
    queryFn: () => apiClient.resellerAdmin.listOperators(hubId!),
    enabled: !!hubId,
  });

  const createOperator = useMutation({
    mutationFn: () => apiClient.resellerAdmin.createOperator(hubId!, { fullName: form.fullName, role: form.role }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['operators', hubId] });
      queryClient.invalidateQueries({ queryKey: ['hub-analytics', hubId] });
      toast.success('Operator created');
      setIssued({ title: 'Operator created', loginCode: res.loginCode, pin: res.pin });
      setIsAddOpen(false);
      setForm({ fullName: '', role: 'reseller_operator' });
    },
    onError: (e: any) => toast.error(e.message || 'Failed to create operator'),
  });

  const resetPin = useMutation({
    mutationFn: (operatorId: string) => apiClient.resellerAdmin.resetOperatorPin(operatorId),
    onSuccess: (res) => setIssued({ title: 'PIN reset', pin: res.pin }),
    onError: (e: any) => toast.error(e.message || 'Failed to reset PIN'),
  });

  return (
    <div className="p-8 space-y-6">
      <Link to={`/resellers/${id}`} className="inline-flex items-center text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to Reseller
      </Link>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{hub?.name ?? 'Hub'}</h1>
            {hub && (
              <Badge variant={hub.isActive ? 'default' : 'secondary'}>
                {hub.isActive ? 'Active' : 'Inactive'}
              </Badge>
            )}
          </div>
          {hub?.location && (hub.location.city || hub.location.region) && (
            <p className="text-slate-500 text-sm mt-1">
              {[hub.location.city, hub.location.region].filter(Boolean).join(', ')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Analytics */}
      <div className="space-y-4">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <StatsCard title="Revenue" value={`E ${(analytics?.revenue ?? 0).toFixed(2)}`} description="Completed sales" icon={DollarSign} gradient="from-green-500 to-emerald-600" />
          <StatsCard title="Tickets Sold" value={analytics?.ticketsSold ?? 0} description="Tickets" icon={Ticket} gradient="from-orange-500 to-amber-600" />
          <StatsCard title="Sales" value={analytics?.salesCount ?? 0} description="Completed sales" icon={Receipt} gradient="from-blue-500 to-indigo-600" />
          <StatsCard title="Operators" value={analytics?.operatorsCount ?? 0} description="In this hub" icon={Users} gradient="from-purple-500 to-fuchsia-600" />
        </div>

        <Card>
          <CardContent className="pt-6">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Per-operator</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Operator</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">Tickets</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(analytics?.byOperator ?? []).map((o) => (
                  <TableRow key={o.operatorId}>
                    <TableCell className="font-medium">{o.fullName}</TableCell>
                    <TableCell className="font-mono">{o.loginCode}</TableCell>
                    <TableCell className="text-right">{o.salesCount}</TableCell>
                    <TableCell className="text-right">{o.ticketsSold}</TableCell>
                    <TableCell className="text-right">E {o.revenue.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Operators management */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-800">Operators</h3>
            <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-orange-600 to-amber-600 text-white hover:opacity-90">Add Operator</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Add Operator</DialogTitle></DialogHeader>
                <form onSubmit={(e) => { e.preventDefault(); if (form.fullName.trim()) createOperator.mutate(); }} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="hub-op-name">Full Name *</Label>
                    <Input id="hub-op-name" value={form.fullName} required onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hub-op-role">Role</Label>
                    <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                      <SelectTrigger id="hub-op-role"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="reseller_operator">Operator</SelectItem>
                        <SelectItem value="reseller_hub_manager">Manager</SelectItem>
                        <SelectItem value="reseller_admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                    <Button type="submit" disabled={createOperator.isPending || !form.fullName.trim()} className="bg-gradient-to-r from-orange-600 to-amber-600 text-white hover:opacity-90">
                      {createOperator.isPending ? 'Creating…' : 'Create'}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {operators.length === 0 ? (
            <p className="text-slate-500 text-sm py-4">No operators in this hub yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {operators.map((op) => (
                  <TableRow key={op._id}>
                    <TableCell className="font-medium">{op.fullName}</TableCell>
                    <TableCell className="font-mono">{op.loginCode}</TableCell>
                    <TableCell className="text-slate-600">{op.role}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" disabled={resetPin.isPending} onClick={() => resetPin.mutate(op._id)}>
                        Reset PIN
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {issued && (
        <OperatorCredentialsDialog
          open={!!issued}
          onClose={() => setIssued(null)}
          title={issued.title}
          loginCode={issued.loginCode}
          pin={issued.pin}
          businessName={hub?.name}
          hubName={hub?.name}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the route**

In `dashboard/src/App.tsx`, import `HubDetailPage` and add — inside the same `ProtectedRoute`/`AdminRoute` nested group as `resellers/:id` — a route:

```tsx
import { HubDetailPage } from '@/pages/HubDetailPage';
```

```tsx
                  <Route path="resellers/:id/hubs/:hubId" element={<AdminRoute><HubDetailPage /></AdminRoute>} />
```

(Place it next to the existing `<Route path="resellers/:id" ... />`.)

- [ ] **Step 5: Make hub rows clickable**

In `dashboard/src/pages/ResellerDetailPage.tsx`, the `HubsTab` needs `resellerId` to build the link (it already receives `resellerId` as a prop) and `useNavigate`. Add at the top of the file's imports if missing: `useNavigate` from `react-router-dom`. In `HubsTab`:

```tsx
  const navigate = useNavigate();
```

Change the hub `<TableRow>` to be clickable:

```tsx
              <TableRow
                key={hub._id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => navigate(`/resellers/${resellerId}/hubs/${hub._id}`)}
              >
```

- [ ] **Step 6: Type-check + build**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit && npx vite build`
Expected: clean tsc, successful build.

- [ ] **Step 7: Commit**

```bash
cd dashboard && git add src/lib/api.ts src/types/reseller.ts src/pages/HubDetailPage.tsx src/App.tsx src/pages/ResellerDetailPage.tsx
git commit -m "feat(hubs): super-admin clickable hubs + drill-in detail/analytics page"
```

---

## Task 6: In-portal hubs list + hub detail page

**Files:**
- Modify: `dashboard/src/lib/resellerApi.ts` (add `resellerHubsApi`; add optional `hubId` to `resellerOperatorsApi.list`; add `HubAnalytics`/`HubRow` types)
- Create: `dashboard/src/pages/reseller/ResellerHubsPage.tsx`
- Create: `dashboard/src/pages/reseller/ResellerHubDetailPage.tsx`
- Modify: `dashboard/src/App.tsx` (routes `/reseller/hubs`, `/reseller/hubs/:hubId`)
- Modify: `dashboard/src/pages/reseller/ResellerPosPage.tsx` (Hubs nav link)

**Interfaces:**
- Consumes: portal endpoints (Task 3); `OperatorCredentialsDialog` (Task 4); `useResellerAuth().operator`; `DateRangePicker`, `StatsCard`.
- Produces: `resellerHubsApi.list()/get(id)/analytics(id, from?, to?)`; `resellerOperatorsApi.list(hubId?)`.

- [ ] **Step 1: Add portal API client + types**

In `dashboard/src/lib/resellerApi.ts`, add types and the hubs client, and extend the operator `list` signature:

```typescript
export interface HubRow {
  _id: string;
  name: string;
  resellerId: string;
  location?: { city?: string; region?: string };
  isActive: boolean;
}

export interface HubOperatorStat {
  operatorId: string; fullName: string; loginCode: string;
  salesCount: number; revenue: number; ticketsSold: number;
}
export interface HubAnalytics {
  hubId: string; revenue: number; ticketsSold: number; salesCount: number;
  operatorsCount: number; byOperator: HubOperatorStat[];
}

export const resellerHubsApi = {
  list: () => request<HubRow[]>('/reseller/hubs'),
  get: (hubId: string) => request<HubRow>(`/reseller/hubs/${hubId}`),
  analytics: (hubId: string, from?: string, to?: string) => {
    const qs = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
    return request<HubAnalytics>(`/reseller/hubs/${hubId}/analytics${qs}`);
  },
};
```

In the existing `resellerOperatorsApi`, change `list` to accept an optional hubId:

```typescript
  list: (hubId?: string) =>
    request<OperatorAdminRow[]>(`/reseller/operators${hubId ? `?hubId=${encodeURIComponent(hubId)}` : ''}`),
```

- [ ] **Step 2: Create the portal hubs list page**

```tsx
// dashboard/src/pages/reseller/ResellerHubsPage.tsx
import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useResellerAuth } from '@/contexts/ResellerAuthContext';
import { resellerHubsApi } from '@/lib/resellerApi';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

const HUB_VIEW_ROLES = ['reseller_admin', 'reseller_hub_manager'];

export function ResellerHubsPage() {
  const { operator } = useResellerAuth();
  const { data: hubs = [], isLoading } = useQuery({
    queryKey: ['portal-hubs'],
    queryFn: () => resellerHubsApi.list(),
  });

  if (operator && !HUB_VIEW_ROLES.includes(operator.role)) {
    return <Navigate to="/reseller" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 space-y-6">
      <Link to="/reseller" className="inline-flex items-center text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to POS
      </Link>
      <h1 className="text-2xl font-bold text-slate-900">Hubs</h1>
      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <p className="text-slate-500 text-sm py-4">Loading…</p>
          ) : hubs.length === 0 ? (
            <p className="text-slate-500 text-sm py-4">No hubs.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hubs.map((hub) => (
                  <TableRow key={hub._id} className="cursor-pointer hover:bg-slate-50">
                    <TableCell className="font-medium">
                      <Link to={`/reseller/hubs/${hub._id}`} className="block">{hub.name}</Link>
                    </TableCell>
                    <TableCell className="text-slate-600">
                      <Link to={`/reseller/hubs/${hub._id}`} className="block">
                        {hub.location?.city || hub.location?.region
                          ? [hub.location.city, hub.location.region].filter(Boolean).join(', ')
                          : '—'}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={hub.isActive ? 'default' : 'secondary'}>
                        {hub.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Create the portal hub detail page**

```tsx
// dashboard/src/pages/reseller/ResellerHubDetailPage.tsx
import { useState } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, DollarSign, Ticket, Receipt, Users } from 'lucide-react';
import { useResellerAuth } from '@/contexts/ResellerAuthContext';
import { resellerHubsApi, resellerOperatorsApi } from '@/lib/resellerApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { StatsCard } from '@/components/ui/stats-card';
import { DateRangePicker, type DateRange } from '@/components/DateRangePicker';
import { OperatorCredentialsDialog } from '@/components/OperatorCredentialsDialog';

const HUB_VIEW_ROLES = ['reseller_admin', 'reseller_hub_manager'];

export function ResellerHubDetailPage() {
  const { hubId } = useParams<{ hubId: string }>();
  const { operator } = useResellerAuth();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<DateRange>({ startDate: undefined, endDate: undefined });
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [issued, setIssued] = useState<{ title: string; loginCode?: string; pin: string } | null>(null);

  const { data: hub } = useQuery({ queryKey: ['portal-hub', hubId], queryFn: () => resellerHubsApi.get(hubId!), enabled: !!hubId });
  const { data: analytics } = useQuery({
    queryKey: ['portal-hub-analytics', hubId, range.startDate, range.endDate],
    queryFn: () => resellerHubsApi.analytics(hubId!, range.startDate, range.endDate),
    enabled: !!hubId,
  });
  const { data: operators = [] } = useQuery({
    queryKey: ['portal-hub-operators', hubId],
    queryFn: () => resellerOperatorsApi.list(hubId),
    enabled: !!hubId,
  });

  const canManage = operator?.role === 'reseller_admin' || operator?.role === 'reseller_hub_manager';

  const createOperator = useMutation({
    mutationFn: () => resellerOperatorsApi.create({ fullName, role: 'reseller_operator', hubId }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['portal-hub-operators', hubId] });
      queryClient.invalidateQueries({ queryKey: ['portal-hub-analytics', hubId] });
      toast.success('Operator created');
      setIssued({ title: 'Operator created', loginCode: res.loginCode, pin: res.pin });
      setIsAddOpen(false);
      setFullName('');
    },
    onError: (e: any) => toast.error(e.message || 'Failed to create operator'),
  });

  const resetPin = useMutation({
    mutationFn: (id: string) => resellerOperatorsApi.resetPin(id),
    onSuccess: (res) => setIssued({ title: 'PIN reset', pin: res.pin }),
    onError: (e: any) => toast.error(e.message || 'Failed to reset PIN'),
  });

  if (operator && !HUB_VIEW_ROLES.includes(operator.role)) {
    return <Navigate to="/reseller" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 space-y-6">
      <Link to="/reseller/hubs" className="inline-flex items-center text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to Hubs
      </Link>
      <h1 className="text-2xl font-bold text-slate-900">{hub?.name ?? 'Hub'}</h1>

      <DateRangePicker value={range} onChange={setRange} />
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatsCard title="Revenue" value={`E ${(analytics?.revenue ?? 0).toFixed(2)}`} description="Completed sales" icon={DollarSign} gradient="from-green-500 to-emerald-600" />
        <StatsCard title="Tickets Sold" value={analytics?.ticketsSold ?? 0} description="Tickets" icon={Ticket} gradient="from-orange-500 to-amber-600" />
        <StatsCard title="Sales" value={analytics?.salesCount ?? 0} description="Completed sales" icon={Receipt} gradient="from-blue-500 to-indigo-600" />
        <StatsCard title="Operators" value={analytics?.operatorsCount ?? 0} description="In this hub" icon={Users} gradient="from-purple-500 to-fuchsia-600" />
      </div>

      <Card>
        <CardContent className="pt-6">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Per-operator</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Operator</TableHead>
                <TableHead>User ID</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Tickets</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(analytics?.byOperator ?? []).map((o) => (
                <TableRow key={o.operatorId}>
                  <TableCell className="font-medium">{o.fullName}</TableCell>
                  <TableCell className="font-mono">{o.loginCode}</TableCell>
                  <TableCell className="text-right">{o.salesCount}</TableCell>
                  <TableCell className="text-right">{o.ticketsSold}</TableCell>
                  <TableCell className="text-right">E {o.revenue.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-800">Operators</h3>
            {canManage && (
              <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-gradient-to-r from-orange-600 to-amber-600 text-white hover:opacity-90">Add Operator</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Add Operator</DialogTitle></DialogHeader>
                  <form onSubmit={(e) => { e.preventDefault(); if (fullName.trim()) createOperator.mutate(); }} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="p-op-name">Full Name *</Label>
                      <Input id="p-op-name" value={fullName} required onChange={(e) => setFullName(e.target.value)} />
                    </div>
                    <div className="flex justify-end gap-2 pt-2">
                      <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                      <Button type="submit" disabled={createOperator.isPending || !fullName.trim()} className="bg-gradient-to-r from-orange-600 to-amber-600 text-white hover:opacity-90">
                        {createOperator.isPending ? 'Creating…' : 'Create'}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            )}
          </div>
          {operators.length === 0 ? (
            <p className="text-slate-500 text-sm py-4">No operators in this hub yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead>Role</TableHead>
                  {canManage && <TableHead></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {operators.map((op) => (
                  <TableRow key={op._id}>
                    <TableCell className="font-medium">{op.fullName}</TableCell>
                    <TableCell className="font-mono">{op.loginCode}</TableCell>
                    <TableCell className="text-slate-600">{op.role}</TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" disabled={resetPin.isPending} onClick={() => resetPin.mutate(op._id)}>
                          Reset PIN
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {issued && (
        <OperatorCredentialsDialog
          open={!!issued}
          onClose={() => setIssued(null)}
          title={issued.title}
          loginCode={issued.loginCode}
          pin={issued.pin}
          businessName={hub?.name}
          hubName={hub?.name}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add routes + POS nav link**

In `dashboard/src/App.tsx`, import both pages and add routes inside their own `ResellerAuthProvider` + `ResellerProtectedRoute` wrappers (same pattern as `/reseller/operators`):

```tsx
import { ResellerHubsPage } from '@/pages/reseller/ResellerHubsPage';
import { ResellerHubDetailPage } from '@/pages/reseller/ResellerHubDetailPage';
```

```tsx
                <Route path="/reseller/hubs" element={
                  <ResellerAuthProvider><ResellerProtectedRoute><ResellerHubsPage /></ResellerProtectedRoute></ResellerAuthProvider>
                } />
                <Route path="/reseller/hubs/:hubId" element={
                  <ResellerAuthProvider><ResellerProtectedRoute><ResellerHubDetailPage /></ResellerProtectedRoute></ResellerAuthProvider>
                } />
```

In `dashboard/src/pages/reseller/ResellerPosPage.tsx`, in the header (next to the existing Operators link added previously), add a Hubs link for the same roles:

```tsx
          {operator && ['reseller_admin', 'reseller_hub_manager'].includes(operator.role) && (
            <Link to="/reseller/hubs" className="text-sm text-orange-600 hover:underline mr-4">
              Hubs
            </Link>
          )}
```

- [ ] **Step 5: Type-check + build**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit && npx vite build`
Expected: clean tsc, successful build.

- [ ] **Step 6: Commit**

```bash
cd dashboard && git add src/lib/resellerApi.ts src/pages/reseller/ResellerHubsPage.tsx src/pages/reseller/ResellerHubDetailPage.tsx src/App.tsx src/pages/reseller/ResellerPosPage.tsx
git commit -m "feat(hubs): in-portal hubs list + hub detail/analytics page"
```

---

## Task 7: Full suites + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Full API suite**

Run: `cd api && npx jest`
Expected: all green.

- [ ] **Step 2: Dashboard build**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit && npx vite build`
Expected: clean.

- [ ] **Step 3: Manual smoke (local)**

1. Super admin → reseller → Hubs tab → click a hub → see detail, KPIs, per-operator table; change the date range and confirm metrics update; Add Operator → credential dialog appears with Copy + Print; Reset PIN → dialog appears.
2. Log in to the portal as a `reseller_admin` → POS header shows Hubs → open it → hub detail loads with analytics + operators; a `reseller_hub_manager` sees only its own hub; a plain operator sees no Hubs link and `/reseller/hubs` redirects to `/reseller`.

---

## Self-Review Notes

- **Spec coverage:** credential dialog (Task 4, reused in 5 & 6); shared analytics service (Task 1); super-admin endpoints (Task 2) + page (Task 5); portal endpoints + scope + `?hubId` filter (Task 3) + pages (Task 6); date-range filter (analytics service + both pages); per-operator breakdown incl. zero-sales operators (Task 1). All spec sections map to a task.
- **Type consistency:** `HubAnalytics`/`HubOperatorStat` shape identical across the service (Task 1), admin types (Task 5), and portal types (Task 6). `getHubAnalytics(hubId, from?, to?)` signature consistent.
- **No date range = all-time:** `DateRange.startDate/endDate` are `undefined` until the user picks a range; the client omits the query string, and the service matches without a `soldAt` filter.
- **Out of scope (per spec):** charts, hub editing, analytics caching/pagination.
