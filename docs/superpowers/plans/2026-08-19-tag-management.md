# Tag Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give organizers a Tags screen on a cashless event — per-tag balances, holders and history, plus lost-tag handling and recorded office cash refunds.

**Architecture:** Read endpoints aggregate existing collections (`Wallet` is the per-tag record, `BandBinding` the bind history, `WalletTopup`/`MerchantCharge`/`WalletWithdrawal` the movements) behind the existing `loadOwnedCashlessEvent` guard. Writes reuse `WalletService` rather than reimplementing money code: `unbindBand` for lost tags, and a generalised `withdrawCash` for office refunds so the cashier path and the office path run one balanced-posting routine.

**Tech Stack:** Node/TypeScript, Express, Mongoose, Jest + supertest (api); React 19 + Vite, react-query, shadcn/ui, vitest + Testing Library (dashboard).

**Spec:** `docs/superpowers/specs/2026-08-19-tag-management-design.md`

## Global Constraints

- **Money is integer ZAR cents** everywhere on the wire and in the DB. Never floats.
- **UI word is "tag"; code word is `band`** (`bandUid`, `BandBinding`, `bindBand`). Do not rename model fields.
- **No silent fallbacks.** A failed or declined call surfaces its error. Never substitute placeholder data for a failed request.
- **`WalletService.applyMovement`-style sole-writer rule holds for money:** only `WalletService` mutates `Wallet.balance`. Report code never writes.
- **`cashFundedBalance <= balance`** is maintained by an atomic `$max` pipeline, not a model hook. Read both as stored; never derive one from the other.
- **Ownership guard on every endpoint:** `loadOwnedCashlessEvent(req, res, eventId)` from `@controllers/organizerCashless.controller`. It responds and returns `null` on failure — callers `if (!event) return;`.
- **Cursor pagination convention** (copy from `StockReportController.movements`): `limit + 1` fetch → `hasMore` + `nextCursor`; reject non-24-hex cursors/ids with 400 before they reach the aggregation.
- **Two field-name traps, confirmed in the code:**
  - The human-readable ticket code is **`ticket.ticketId`** (a short string), NOT `ticketCode`. `ticket._id` is the ObjectId.
  - **`WalletStatus` is `'active' | 'frozen' | 'closed'`** — there is no "deactivated". A deactivated (lost) tag is a wallet whose **`bandUid` is `null`** while the wallet itself stays `active`.
- **Derived tag status** (used by list + detail + filters), define once and reuse:
  - `active` — `bandUid != null` and `wallet.status === 'active'`
  - `unbound` — `bandUid == null` and `wallet.status === 'active'` (lost/deactivated, awaiting reissue)
  - `frozen` / `closed` — mirrors `wallet.status`

## Deltas from the spec — read before starting

Two things the spec asks for that this plan deliberately does NOT build. Both
are judgement calls; reject either and the plan needs a task added.

1. **The Tags stats strip carries tag-shaped figures only** (tags in use,
   balance outstanding, cash-funded outstanding, average balance) — not
   `toppedUp` / `spent` / `cashedOut` / `refundedAtOffice`. The spec says to
   reuse `OrganizerCashlessService.summary` rather than recompute those, and
   that service already renders them one tab away under **Money**. Duplicating
   them onto Tags means two screens that must agree forever. If you want them
   here, the right move is to call the existing summary endpoint from the panel
   and render its numbers verbatim — not to add them to `TagReportService`.

2. **`lastActivityAt` is not on the tag row.** The spec specifies it as the
   newest `LedgerEntry` for the wallet, which is a second aggregation across a
   collection that grows with every tap at every stall — the most expensive
   field on the busiest screen, for a column nobody sorts by. Deferred until
   someone asks for it; the detail sheet already shows the newest movement
   first for any tag you open.

---

## File Structure

**api** (worktree `api-tagmgmt-wt`, branch `feat/tag-management`)

| File | Responsibility |
|---|---|
| Create `src/services/tagReport.service.ts` | All read aggregations: summary, list, detail. No writes. |
| Create `src/controllers/tagReport.controller.ts` | HTTP shape + param validation for the three GETs. |
| Create `src/controllers/tagAdmin.controller.ts` | The three write actions (deactivate, reissue, refund). |
| Modify `src/routes/tickets.route.ts` | Six new routes, each with its permission. |
| Modify `src/models/walletWithdrawal.model.ts` | `method` += `'office_cash'`; `recordedByType` += `'Vendor'`. |
| Modify `src/interfaces/ledger.interface.ts` | `FloatTag` += `OFFICE = 'office'`. |
| Modify `src/services/wallet.service.ts` | Generalise `withdrawCash` over method/recorder/floatTag. |

**dashboard** (worktree `dashboard-tagmgmt-wt`, branch `feat/tag-management-ui`)

| File | Responsibility |
|---|---|
| Modify `src/lib/api.ts` | `tags` client group + row/detail types. |
| Create `src/components/cashless/EventTagsPanel.tsx` | Stats strip + table + filters. |
| Create `src/components/cashless/TagDetailSheet.tsx` | One tag: holder, history, actions. |
| Modify `src/components/EventCashlessTab.tsx` | `Tags` sub-tab. |

---

## Task 1: Tag summary (api)

**Files:**
- Create: `src/services/tagReport.service.ts`
- Create: `src/controllers/tagReport.controller.ts`
- Modify: `src/routes/tickets.route.ts`
- Test: `src/services/__tests__/tagReportSummary.test.ts`

**Interfaces:**
- Consumes: `loadOwnedCashlessEvent` from `@controllers/organizerCashless.controller`.
- Produces: `TagReportService.summary(eventId: string): Promise<TagSummary>` where
  `TagSummary = { tagsInUse: number; activeTags: number; unboundTags: number; balanceOutstanding: number; cashFundedOutstanding: number; averageBalance: number }`.
  Route: `GET /api/tickets/events/:eventId/tags/summary`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/tagReportSummary.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { TagReportService } from '@services/tagReport.service';

const EVENT = new mongoose.Types.ObjectId();
const OTHER_EVENT = new mongoose.Types.ObjectId();

const wallet = (over: Record<string, unknown> = {}) =>
  Wallet.create({
    eventId: EVENT,
    ticketId: new mongoose.Types.ObjectId(),
    bandUid: 'UID' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    balance: 0,
    cashFundedBalance: 0,
    status: 'active',
    ...over,
  });

describe('TagReportService.summary', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('counts tags in use and totals what is still owed to attendees', async () => {
    await wallet({ balance: 15000, cashFundedBalance: 5000 });
    await wallet({ balance: 5000, cashFundedBalance: 0 });

    const s = await TagReportService.summary(String(EVENT));

    expect(s.tagsInUse).toBe(2);
    expect(s.activeTags).toBe(2);
    expect(s.balanceOutstanding).toBe(20000);
    expect(s.cashFundedOutstanding).toBe(5000);
    expect(s.averageBalance).toBe(10000);
  });

  it('counts a wallet whose tag was deactivated as unbound, not as gone', async () => {
    await wallet({ balance: 7000, bandUid: null });

    const s = await TagReportService.summary(String(EVENT));

    expect(s.tagsInUse).toBe(1);
    expect(s.activeTags).toBe(0);
    expect(s.unboundTags).toBe(1);
    // The money is still owed even though no plastic is holding it.
    expect(s.balanceOutstanding).toBe(7000);
  });

  it('ignores other events', async () => {
    await wallet({ balance: 100 });
    await wallet({ eventId: OTHER_EVENT, balance: 999999 });

    const s = await TagReportService.summary(String(EVENT));

    expect(s.tagsInUse).toBe(1);
    expect(s.balanceOutstanding).toBe(100);
  });

  it('reports zeroes rather than NaN for an event with no tags', async () => {
    const s = await TagReportService.summary(String(EVENT));

    expect(s).toMatchObject({
      tagsInUse: 0, activeTags: 0, unboundTags: 0,
      balanceOutstanding: 0, cashFundedOutstanding: 0, averageBalance: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/tagReportSummary.test.ts --maxWorkers=2`
Expected: FAIL — `Cannot find module '@services/tagReport.service'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/tagReport.service.ts
import mongoose from 'mongoose';
import { Wallet } from '@models/wallet.model';

export interface TagSummary {
  tagsInUse: number;
  activeTags: number;
  unboundTags: number;
  balanceOutstanding: number;
  cashFundedOutstanding: number;
  averageBalance: number;
}

/**
 * Read-only aggregations behind the organizer's Tags screen. A "tag" here is a
 * Wallet: the plastic carries only a UID, the wallet carries the money and the
 * continuity across a lost-tag reissue.
 */
export class TagReportService {
  static async summary(eventId: string): Promise<TagSummary> {
    const [row] = await Wallet.aggregate([
      { $match: { eventId: new mongoose.Types.ObjectId(eventId) } },
      {
        $group: {
          _id: null,
          tagsInUse: { $sum: 1 },
          // A deactivated tag leaves the wallet active with a null bandUid —
          // the money is still owed, so it must not drop out of the totals.
          activeTags: {
            $sum: { $cond: [{ $and: [{ $ne: ['$bandUid', null] }, { $eq: ['$status', 'active'] }] }, 1, 0] },
          },
          unboundTags: {
            $sum: { $cond: [{ $and: [{ $eq: ['$bandUid', null] }, { $eq: ['$status', 'active'] }] }, 1, 0] },
          },
          balanceOutstanding: { $sum: '$balance' },
          cashFundedOutstanding: { $sum: '$cashFundedBalance' },
        },
      },
    ]);

    const tagsInUse = row?.tagsInUse ?? 0;
    return {
      tagsInUse,
      activeTags: row?.activeTags ?? 0,
      unboundTags: row?.unboundTags ?? 0,
      balanceOutstanding: row?.balanceOutstanding ?? 0,
      cashFundedOutstanding: row?.cashFundedOutstanding ?? 0,
      // Integer cents: an average that is not a whole cent is rounded, never floated.
      averageBalance: tagsInUse ? Math.round((row?.balanceOutstanding ?? 0) / tagsInUse) : 0,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/tagReportSummary.test.ts --maxWorkers=2`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the controller and route**

```ts
// src/controllers/tagReport.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
// TagStatus is imported here in Task 2, when the list method starts casting to it.
import { TagReportService } from '@services/tagReport.service';

export class TagReportController {
  /** GET /api/tickets/events/:eventId/tags/summary */
  static async summary(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      return ApiResponseUtil.success(res, await TagReportService.summary(eventId));
    } catch (err: any) {
      console.error('Tag summary error:', err);
      return ApiResponseUtil.error(res, 'Failed to load the tag summary', 500);
    }
  }
}
```

In `src/routes/tickets.route.ts`, add the import beside the other report controllers and the route beside the stock report routes (search for `'/events/:eventId/stock/board'`):

```ts
import { TagReportController } from '@controllers/tagReport.controller';

// Tag management — the wallets behind the NFC tags at a cashless event.
router.get('/events/:eventId/tags/summary', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), TagReportController.summary);
```

- [ ] **Step 6: Verify the route compiles and is reachable**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/services/tagReport.service.ts src/controllers/tagReport.controller.ts src/routes/tickets.route.ts src/services/__tests__/tagReportSummary.test.ts
git commit -m "feat(tags): summary of the wallets behind an event's tags"
```

---

## Task 2: Tag list with search and paging (api)

**Files:**
- Modify: `src/services/tagReport.service.ts`
- Modify: `src/controllers/tagReport.controller.ts`
- Modify: `src/routes/tickets.route.ts`
- Test: `src/services/__tests__/tagReportList.test.ts`

**Interfaces:**
- Consumes: `TagReportService` from Task 1.
- Produces: `TagReportService.list(eventId, opts: { limit?: number; cursor?: string; status?: TagStatus; q?: string }): Promise<{ tags: TagRow[]; hasMore: boolean; nextCursor: string | null }>` where
  `TagStatus = 'active' | 'unbound' | 'frozen' | 'closed'` and
  `TagRow = { walletId: string; bandUid: string | null; status: TagStatus; balance: number; cashFundedBalance: number; holder: { name: string | null; phone: string | null; ticketCode: string | null } }`.
  Route: `GET /api/tickets/events/:eventId/tags?limit=&cursor=&status=&q=`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/tagReportList.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';
import { TagReportService } from '@services/tagReport.service';

const EVENT = new mongoose.Types.ObjectId();

async function tagFor(name: string, phone: string, over: Record<string, unknown> = {}) {
  const ticket = await Ticket.create({
    eventId: EVENT, ticketType: 'General', price: 0, quantity: 1,
    customerName: name, customerPhone: phone, status: 'sold',
  } as any);
  const w = await Wallet.create({
    eventId: EVENT, ticketId: ticket._id, bandUid: 'UID' + phone.slice(-4),
    balance: 1000, cashFundedBalance: 0, status: 'active', ...over,
  });
  return { ticket, wallet: w };
}

describe('TagReportService.list', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns each tag with the holder it is bound to', async () => {
    const { ticket } = await tagFor('Thandi Dlamini', '+26876001234');

    const { tags } = await TagReportService.list(String(EVENT), {});

    expect(tags).toHaveLength(1);
    expect(tags[0]!.holder).toEqual({
      name: 'Thandi Dlamini',
      phone: '+26876001234',
      // The human ticket code lives on ticket.ticketId, NOT ticket._id.
      ticketCode: (await Ticket.findById(ticket._id))!.ticketId,
    });
  });

  it('derives status from the band and the wallet, not from wallet.status alone', async () => {
    await tagFor('Bound Bongi', '+26876001111');
    await tagFor('Lost Lindiwe', '+26876002222', { bandUid: null });
    await tagFor('Frozen Fana', '+26876003333', { status: 'frozen' });

    const { tags } = await TagReportService.list(String(EVENT), {});
    const byName = Object.fromEntries(tags.map((t) => [t.holder.name, t.status]));

    expect(byName['Bound Bongi']).toBe('active');
    expect(byName['Lost Lindiwe']).toBe('unbound');
    expect(byName['Frozen Fana']).toBe('frozen');
  });

  it('filters by status', async () => {
    await tagFor('Bound Bongi', '+26876001111');
    await tagFor('Lost Lindiwe', '+26876002222', { bandUid: null });

    const { tags } = await TagReportService.list(String(EVENT), { status: 'unbound' });

    expect(tags.map((t) => t.holder.name)).toEqual(['Lost Lindiwe']);
  });

  it('searches on tag UID prefix and on holder name or phone', async () => {
    await tagFor('Thandi Dlamini', '+26876001234');
    await tagFor('Sipho Nkosi', '+26876009999');

    const byUid = await TagReportService.list(String(EVENT), { q: 'UID1234' });
    const byName = await TagReportService.list(String(EVENT), { q: 'sipho' });
    const byPhone = await TagReportService.list(String(EVENT), { q: '9999' });

    expect(byUid.tags.map((t) => t.holder.name)).toEqual(['Thandi Dlamini']);
    expect(byName.tags.map((t) => t.holder.name)).toEqual(['Sipho Nkosi']);
    expect(byPhone.tags.map((t) => t.holder.name)).toEqual(['Sipho Nkosi']);
  });

  it('pages without dropping or repeating a row across the cursor boundary', async () => {
    for (let i = 0; i < 5; i++) await tagFor(`Person ${i}`, `+2687600000${i}`);

    const first = await TagReportService.list(String(EVENT), { limit: 2 });
    const second = await TagReportService.list(String(EVENT), { limit: 2, cursor: first.nextCursor! });

    expect(first.tags).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.tags).toHaveLength(2);
    const seen = [...first.tags, ...second.tags].map((t) => t.walletId);
    expect(new Set(seen).size).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/tagReportList.test.ts --maxWorkers=2`
Expected: FAIL — `TagReportService.list is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/tagReport.service.ts` (and export the two types):

```ts
export type TagStatus = 'active' | 'unbound' | 'frozen' | 'closed';

export interface TagRow {
  walletId: string;
  bandUid: string | null;
  status: TagStatus;
  balance: number;
  cashFundedBalance: number;
  holder: { name: string | null; phone: string | null; ticketCode: string | null };
}

/** Status is derived: the plastic and the wallet each tell half the story. */
const statusStage = {
  $switch: {
    branches: [
      { case: { $in: ['$status', ['frozen', 'closed']] }, then: '$status' },
      { case: { $eq: ['$bandUid', null] }, then: 'unbound' },
    ],
    default: 'active',
  },
};
```

```ts
  static async list(
    eventId: string,
    opts: { limit?: number; cursor?: string; status?: TagStatus; q?: string },
  ): Promise<{ tags: TagRow[]; hasMore: boolean; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const match: Record<string, unknown> = { eventId: new mongoose.Types.ObjectId(eventId) };
    // _id desc + a strictly-less-than cursor: the same convention as the stock
    // movements feed, so a row can neither repeat nor be skipped at a boundary.
    if (opts.cursor) match['_id'] = { $lt: new mongoose.Types.ObjectId(opts.cursor) };

    const pipeline: any[] = [
      { $match: match },
      { $sort: { _id: -1 } },
      {
        $lookup: {
          from: 'tickets', localField: 'ticketId', foreignField: '_id', as: 'ticket',
        },
      },
      { $unwind: { path: '$ticket', preserveNullAndEmptyArrays: true } },
      { $addFields: { tagStatus: statusStage } },
    ];

    if (opts.status) pipeline.push({ $match: { tagStatus: opts.status } });

    if (opts.q) {
      // Escaped: a UID or a name is user input, and an unescaped regex here is
      // both a correctness bug and a ReDoS foothold.
      const safe = opts.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      pipeline.push({
        $match: { $or: [{ bandUid: rx }, { 'ticket.customerName': rx }, { 'ticket.customerPhone': rx }] },
      });
    }

    pipeline.push({ $limit: limit + 1 });

    const rows = await Wallet.aggregate(pipeline);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      tags: page.map((r: any) => ({
        walletId: String(r._id),
        bandUid: r.bandUid ?? null,
        status: r.tagStatus as TagStatus,
        balance: r.balance,
        cashFundedBalance: r.cashFundedBalance,
        holder: {
          name: r.ticket?.customerName ?? null,
          phone: r.ticket?.customerPhone ?? null,
          ticketCode: r.ticket?.ticketId ?? null,
        },
      })),
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]!._id) : null,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/tagReportList.test.ts --maxWorkers=2`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the controller method and route**

```ts
  /** GET /api/tickets/events/:eventId/tags */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      // Reject malformed params here so they never reach the aggregation as an
      // invalid ObjectId and surface as a 500.
      const hex24 = /^[0-9a-fA-F]{24}$/;
      const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
      if (cursor && !hex24.test(cursor)) return ApiResponseUtil.badRequest(res, 'invalid cursor');

      const rawLimit = req.query['limit'] ? Number(req.query['limit']) : undefined;
      if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) {
        return ApiResponseUtil.badRequest(res, 'invalid limit');
      }

      const status = req.query['status'] ? String(req.query['status']) : undefined;
      const allowed = ['active', 'unbound', 'frozen', 'closed'];
      if (status && !allowed.includes(status)) return ApiResponseUtil.badRequest(res, 'invalid status');

      return ApiResponseUtil.success(res, await TagReportService.list(eventId, {
        ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
        ...(cursor ? { cursor } : {}),
        ...(status ? { status: status as TagStatus } : {}),
        ...(req.query['q'] ? { q: String(req.query['q']) } : {}),
      }));
    } catch (err: any) {
      console.error('Tag list error:', err);
      return ApiResponseUtil.error(res, 'Failed to load tags', 500);
    }
  }
```

Widen the controller's import to `import { TagReportService, type TagStatus } from '@services/tagReport.service';` — the list method casts the validated query value to it.

Route (note ordering: `/tags/summary` is already registered above, and a literal path segment must be registered before the `:walletId` param route added in Task 3):

```ts
router.get('/events/:eventId/tags', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), TagReportController.list);
```

- [ ] **Step 6: Verify compile**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/services/tagReport.service.ts src/controllers/tagReport.controller.ts src/routes/tickets.route.ts src/services/__tests__/tagReportList.test.ts
git commit -m "feat(tags): searchable, paged tag list with holders"
```

---

## Task 3: Per-tag detail (api)

**Files:**
- Modify: `src/services/tagReport.service.ts`
- Modify: `src/controllers/tagReport.controller.ts`
- Modify: `src/routes/tickets.route.ts`
- Test: `src/services/__tests__/tagReportDetail.test.ts`

**Interfaces:**
- Consumes: `TagRow`, `TagStatus` from Task 2.
- Produces: `TagReportService.detail(eventId: string, walletId: string): Promise<TagDetail | null>` where
  `TagDetail = TagRow & { bindings: TagBinding[]; movements: TagMovement[] }`,
  `TagBinding = { bandUid: string; boundAt: Date; boundBy: string | null; unboundAt: Date | null; unboundReason: string | null }`,
  `TagMovement = { kind: 'topup' | 'spend' | 'cashout'; amount: number; at: Date; label: string }`.
  Route: `GET /api/tickets/events/:eventId/tags/:walletId`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/tagReportDetail.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';
import { BandBinding } from '@models/bandBinding.model';
import { WalletTopup } from '@models/walletTopup.model';
import { TagReportService } from '@services/tagReport.service';

const EVENT = new mongoose.Types.ObjectId();

async function walletFor(name: string, bandUid: string | null) {
  const ticket = await Ticket.create({
    eventId: EVENT, ticketType: 'General', price: 0, quantity: 1,
    customerName: name, customerPhone: '+26876000000', status: 'sold',
  } as any);
  return Wallet.create({
    eventId: EVENT, ticketId: ticket._id, bandUid,
    balance: 5000, cashFundedBalance: 5000, status: 'active',
  });
}

describe('TagReportService.detail', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns null for a wallet on another event rather than leaking it', async () => {
    const w = await walletFor('Thandi', 'UID1');
    const detail = await TagReportService.detail(String(new mongoose.Types.ObjectId()), String(w._id));
    expect(detail).toBeNull();
  });

  it('lists the binding history newest first, with who bound it and why it was released', async () => {
    const w = await walletFor('Thandi', 'UID2');
    await BandBinding.create({
      walletId: w._id, eventId: EVENT, bandUid: 'UID1',
      boundAt: new Date('2026-08-01T10:00:00Z'), boundBy: 'gate-op-1',
      unboundAt: new Date('2026-08-01T18:00:00Z'), unboundReason: 'lost at the bar',
    });
    await BandBinding.create({
      walletId: w._id, eventId: EVENT, bandUid: 'UID2',
      boundAt: new Date('2026-08-01T18:05:00Z'), boundBy: 'gate-op-2',
    });

    const detail = await TagReportService.detail(String(EVENT), String(w._id));

    expect(detail!.bindings.map((b) => b.bandUid)).toEqual(['UID2', 'UID1']);
    expect(detail!.bindings[1]).toMatchObject({
      unboundReason: 'lost at the bar', boundBy: 'gate-op-1',
    });
    expect(detail!.bindings[0]!.unboundAt).toBeNull();
  });

  it('keeps two wallets that shared a UID apart', async () => {
    // A UID recycled between attendees must not merge their histories.
    const first = await walletFor('First Holder', null);
    const second = await walletFor('Second Holder', 'SHARED');
    await BandBinding.create({
      walletId: first._id, eventId: EVENT, bandUid: 'SHARED',
      boundAt: new Date('2026-08-01T10:00:00Z'), unboundAt: new Date('2026-08-01T12:00:00Z'),
    });
    await BandBinding.create({
      walletId: second._id, eventId: EVENT, bandUid: 'SHARED',
      boundAt: new Date('2026-08-01T12:05:00Z'),
    });

    const a = await TagReportService.detail(String(EVENT), String(first._id));
    const b = await TagReportService.detail(String(EVENT), String(second._id));

    expect(a!.bindings).toHaveLength(1);
    expect(b!.bindings).toHaveLength(1);
    expect(a!.holder.name).toBe('First Holder');
    expect(b!.holder.name).toBe('Second Holder');
  });

  it('includes top-ups in the movement history', async () => {
    const w = await walletFor('Thandi', 'UID3');
    await WalletTopup.create({
      walletId: w._id, eventId: EVENT, amount: 5000, method: 'cash',
      status: 'completed', recordedBy: 'cashier-1', recordedByType: 'Cashier',
      clientTxnId: 'txn-1',
    });

    const detail = await TagReportService.detail(String(EVENT), String(w._id));

    expect(detail!.movements).toEqual([
      expect.objectContaining({ kind: 'topup', amount: 5000 }),
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/tagReportDetail.test.ts --maxWorkers=2`
Expected: FAIL — `TagReportService.detail is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/tagReport.service.ts`:

```ts
export interface TagBinding {
  bandUid: string;
  boundAt: Date;
  boundBy: string | null;
  unboundAt: Date | null;
  unboundReason: string | null;
}

export interface TagMovement {
  kind: 'topup' | 'spend' | 'cashout';
  amount: number;
  at: Date;
  label: string;
}

export type TagDetail = TagRow & { bindings: TagBinding[]; movements: TagMovement[] };
```

```ts
  static async detail(eventId: string, walletId: string): Promise<TagDetail | null> {
    const eid = new mongoose.Types.ObjectId(eventId);
    // Scoped by BOTH ids: another event's wallet must read as absent.
    const wallet = await Wallet.findOne({ _id: walletId, eventId: eid }).lean();
    if (!wallet) return null;

    const ticket = await Ticket.findById(wallet.ticketId).lean();

    // Keyed on walletId, never bandUid: one UID legitimately spans several
    // wallets over an event, and a UID-keyed read would merge their histories.
    const bindings = await BandBinding.find({ walletId: wallet._id })
      .sort({ boundAt: -1 })
      .lean();

    const [topups, charges, withdrawals] = await Promise.all([
      WalletTopup.find({ walletId: wallet._id }).lean(),
      MerchantCharge.find({ walletId: wallet._id }).lean(),
      WalletWithdrawal.find({ walletId: wallet._id }).lean(),
    ]);

    const merchantNames = new Map<string, string>(
      (await Merchant.find({ _id: { $in: charges.map((c: any) => c.merchantId) } })
        .select('name')
        .lean()).map((m: any) => [String(m._id), m.name]),
    );

    const movements: TagMovement[] = [
      ...topups.map((t: any) => ({
        kind: 'topup' as const, amount: t.amount, at: t.createdAt, label: 'Top-up',
      })),
      ...charges.map((c: any) => ({
        kind: 'spend' as const, amount: c.amount, at: c.createdAt,
        label: merchantNames.get(String(c.merchantId)) ?? 'Stall',
      })),
      ...withdrawals.map((w: any) => ({
        kind: 'cashout' as const, amount: w.amount, at: w.createdAt,
        label: w.method === 'office_cash' ? 'Office refund' : 'Cash-out',
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // Same rule as `statusStage` in list(), expressed in JS because this path
    // reads a document rather than running a pipeline. If you change one,
    // change both — the list and the detail disagreeing about whether a tag is
    // "unbound" is the kind of bug nobody reports and everybody distrusts.
    const status: TagStatus =
      wallet.status === 'frozen' || wallet.status === 'closed'
        ? wallet.status
        : wallet.bandUid == null
          ? 'unbound'
          : 'active';

    return {
      walletId: String(wallet._id),
      bandUid: wallet.bandUid ?? null,
      status,
      balance: wallet.balance,
      cashFundedBalance: wallet.cashFundedBalance,
      holder: {
        name: ticket?.customerName ?? null,
        phone: ticket?.customerPhone ?? null,
        ticketCode: (ticket as any)?.ticketId ?? null,
      },
      bindings: bindings.map((b: any) => ({
        bandUid: b.bandUid,
        boundAt: b.boundAt,
        boundBy: b.boundBy ?? null,
        unboundAt: b.unboundAt ?? null,
        unboundReason: b.unboundReason ?? null,
      })),
      movements,
    };
  }
```

Add the imports at the top of the service:

```ts
import { Ticket } from '@models/ticket.model';
import { BandBinding } from '@models/bandBinding.model';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Merchant } from '@models/merchant.model';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/tagReportDetail.test.ts --maxWorkers=2`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the controller method and route**

```ts
  /** GET /api/tickets/events/:eventId/tags/:walletId */
  static async detail(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const walletId = String(req.params['walletId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      if (!/^[0-9a-fA-F]{24}$/.test(walletId)) return ApiResponseUtil.badRequest(res, 'invalid tag id');

      const detail = await TagReportService.detail(eventId, walletId);
      if (!detail) return ApiResponseUtil.error(res, 'Tag not found', 404);
      return ApiResponseUtil.success(res, detail);
    } catch (err: any) {
      console.error('Tag detail error:', err);
      return ApiResponseUtil.error(res, 'Failed to load the tag', 500);
    }
  }
```

Register AFTER the `/tags/summary` route so the literal segment wins over the param:

```ts
router.get('/events/:eventId/tags/:walletId', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), TagReportController.detail);
```

- [ ] **Step 6: Verify the literal route still wins**

Run: `npx jest src/routes/__tests__ --maxWorkers=2 -t "tags"`
Expected: PASS, and manually confirm in `tickets.route.ts` that `/tags/summary` appears ABOVE `/tags/:walletId` — otherwise `summary` is swallowed as a walletId and 400s as an invalid tag id.

- [ ] **Step 7: Commit**

```bash
git add src/services/tagReport.service.ts src/controllers/tagReport.controller.ts src/routes/tickets.route.ts src/services/__tests__/tagReportDetail.test.ts
git commit -m "feat(tags): per-tag detail with binding and movement history"
```

---

## Task 4: Route-level tests for the read API

**Files:**
- Test: `src/routes/__tests__/tagReport.route.test.ts`

**Interfaces:**
- Consumes: the three routes from Tasks 1–3.
- Produces: nothing — a gate on permissions and tenancy.

- [ ] **Step 1: Write the test**

```ts
// src/routes/__tests__/tagReport.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR = '64c000000000000000000a01';
const OTHER = '64c000000000000000000b02';

const token = (perms: string[], vendorId = VENDOR) =>
  jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner', permissions: perms, isSuperAdmin: false, vendorId }, JWT_SECRET);

async function cashlessEvent(vendorId = VENDOR) {
  const future = new Date(Date.now() + 7 * 864e5);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId), name: 'Fest', venue: 'V',
    eventDate: future, startTime: future, endTime: future,
    status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
}

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

it('403s without view_revenue', async () => {
  const event = await cashlessEvent();
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags`)
    .set('Authorization', `Bearer ${token(['tickets:view_events'])}`);
  expect(res.status).toBe(403);
});

it('403s another vendor’s event', async () => {
  const event = await cashlessEvent(OTHER);
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`);
  expect(res.status).toBe(403);
});

it('400s a non-cashless event', async () => {
  const event = await cashlessEvent();
  await Event.updateOne({ _id: event._id }, { cashless: false });
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`);
  expect(res.status).toBe(400);
});

it('serves the summary route rather than treating "summary" as a tag id', async () => {
  const event = await cashlessEvent();
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags/summary`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`);
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveProperty('balanceOutstanding');
});

it('400s a malformed cursor', async () => {
  const event = await cashlessEvent();
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags?cursor=nope`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`);
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run it**

Run: `npx jest src/routes/__tests__/tagReport.route.test.ts --maxWorkers=2`
Expected: PASS (5 tests). If the summary test 400s, the routes are registered in the wrong order — fix the order, not the test.

- [ ] **Step 3: Commit**

```bash
git add src/routes/__tests__/tagReport.route.test.ts
git commit -m "test(tags): permission, tenancy and route-order gates on the read API"
```

---

## Task 5: Tags API client + types (dashboard)

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Consumes: the api routes from Tasks 1–3.
- Produces: `apiClient.tags.summary(eventId)`, `apiClient.tags.list(eventId, params)`, `apiClient.tags.detail(eventId, walletId)`; exported types `TagStatus`, `TagRow`, `TagSummary`, `TagDetail`.

- [ ] **Step 1: Add the types and client group**

Beside the other cashless types in `src/lib/api.ts`:

```ts
// ── Tags (the wallets behind an event's NFC tags) ──────────────────────────
export type TagStatus = 'active' | 'unbound' | 'frozen' | 'closed';

export interface TagSummary {
  tagsInUse: number;
  activeTags: number;
  unboundTags: number;
  balanceOutstanding: number;
  cashFundedOutstanding: number;
  averageBalance: number;
}

export interface TagRow {
  walletId: string;
  bandUid: string | null;
  status: TagStatus;
  balance: number;
  cashFundedBalance: number;
  holder: { name: string | null; phone: string | null; ticketCode: string | null };
}

export interface TagBinding {
  bandUid: string;
  boundAt: string;
  boundBy: string | null;
  unboundAt: string | null;
  unboundReason: string | null;
}

export interface TagMovement {
  kind: 'topup' | 'spend' | 'cashout';
  amount: number;
  at: string;
  label: string;
}

export type TagDetail = TagRow & { bindings: TagBinding[]; movements: TagMovement[] };
```

```ts
  tags = {
    summary: async (eventId: string): Promise<TagSummary> =>
      this.request<TagSummary>(`/tickets/events/${eventId}/tags/summary`),

    list: async (
      eventId: string,
      params: { limit?: number; cursor?: string; status?: TagStatus; q?: string } = {},
    ): Promise<{ tags: TagRow[]; hasMore: boolean; nextCursor: string | null }> => {
      const qs = new URLSearchParams();
      if (params.limit) qs.set('limit', String(params.limit));
      if (params.cursor) qs.set('cursor', params.cursor);
      if (params.status) qs.set('status', params.status);
      if (params.q) qs.set('q', params.q);
      const query = qs.toString();
      return this.request(`/tickets/events/${eventId}/tags${query ? `?${query}` : ''}`);
    },

    detail: async (eventId: string, walletId: string): Promise<TagDetail> =>
      this.request<TagDetail>(`/tickets/events/${eventId}/tags/${walletId}`),
  };
```

- [ ] **Step 2: Verify compile**

Run: `npm run build`
Expected: `✓ built`. (`tsc --noEmit` is NOT the gate here — `npm run build` runs `tsc -b`, which catches the unused-locals errors that break the Pages build.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(tags): api client for the tag read endpoints"
```

---

## Task 6: Tags panel — stats and table (dashboard)

**Files:**
- Create: `src/components/cashless/EventTagsPanel.tsx`
- Modify: `src/components/EventCashlessTab.tsx`
- Test: `src/components/__tests__/EventTagsPanel.test.tsx`

**Interfaces:**
- Consumes: `apiClient.tags` from Task 5.
- Produces: `<EventTagsPanel eventId={string} />`, rendered as the `tags` sub-tab.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EventTagsPanel } from '@/components/cashless/EventTagsPanel';

afterEach(cleanup);

const summary = vi.fn();
const list = vi.fn();
vi.mock('@/lib/api', () => ({ apiClient: { tags: { summary: (...a: any[]) => summary(...a), list: (...a: any[]) => list(...a) } } }));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EventTagsPanel eventId="e1" />
    </QueryClientProvider>,
  );
}

describe('EventTagsPanel', () => {
  it('shows what is still owed to attendees', async () => {
    summary.mockResolvedValue({
      tagsInUse: 12, activeTags: 11, unboundTags: 1,
      balanceOutstanding: 123400, cashFundedOutstanding: 40000, averageBalance: 10283,
    });
    list.mockResolvedValue({ tags: [], hasMore: false, nextCursor: null });

    renderPanel();

    await waitFor(() => expect(screen.getByText('R1,234.00')).toBeDefined());
    expect(screen.getByText('12')).toBeDefined();
  });

  it('lists a tag with its holder and balance', async () => {
    summary.mockResolvedValue({
      tagsInUse: 1, activeTags: 1, unboundTags: 0,
      balanceOutstanding: 5000, cashFundedOutstanding: 0, averageBalance: 5000,
    });
    list.mockResolvedValue({
      tags: [{
        walletId: 'w1', bandUid: 'UID123', status: 'active',
        balance: 5000, cashFundedBalance: 0,
        holder: { name: 'Thandi Dlamini', phone: '+26876001234', ticketCode: 'ABC123' },
      }],
      hasMore: false, nextCursor: null,
    });

    renderPanel();

    await waitFor(() => expect(screen.getByText('Thandi Dlamini')).toBeDefined());
    expect(screen.getByText('UID123')).toBeDefined();
    expect(screen.getByText('R50.00')).toBeDefined();
  });

  it('says so plainly when the event has no tags yet', async () => {
    summary.mockResolvedValue({
      tagsInUse: 0, activeTags: 0, unboundTags: 0,
      balanceOutstanding: 0, cashFundedOutstanding: 0, averageBalance: 0,
    });
    list.mockResolvedValue({ tags: [], hasMore: false, nextCursor: null });

    renderPanel();

    await waitFor(() => expect(screen.getByText(/no tags issued yet/i)).toBeDefined());
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/components/__tests__/EventTagsPanel.test.tsx`
Expected: FAIL — cannot resolve `@/components/cashless/EventTagsPanel`.

- [ ] **Step 3: Build the panel**

```tsx
// src/components/cashless/EventTagsPanel.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Nfc, Search } from 'lucide-react';
import { apiClient, type TagRow, type TagStatus } from '@/lib/api';
import { fmtR } from '@/lib/money';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const STATUS_META: Record<TagStatus, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-green-100 text-green-800' },
  unbound: { label: 'Unbound', className: 'bg-amber-100 text-amber-800' },
  frozen: { label: 'Frozen', className: 'bg-slate-100 text-slate-700' },
  closed: { label: 'Closed', className: 'bg-slate-100 text-slate-700' },
};

/**
 * The tags issued at one cashless event. A "tag" is really the wallet behind
 * it — the plastic carries only a UID, and the wallet is what survives a lost
 * tag being reissued.
 */
export function EventTagsPanel({ eventId }: { eventId: string }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<TagStatus | 'all'>('all');

  const { data: summary } = useQuery({
    queryKey: ['tag-summary', eventId],
    queryFn: () => apiClient.tags.summary(eventId),
  });

  const { data: page, isLoading } = useQuery({
    queryKey: ['tags', eventId, status, q],
    queryFn: () => apiClient.tags.list(eventId, {
      ...(status !== 'all' ? { status } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
    }),
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Tags in use" value={String(summary?.tagsInUse ?? 0)} hint={`${summary?.unboundTags ?? 0} unbound`} />
        <Stat label="Still on tags" value={fmtR(summary?.balanceOutstanding ?? 0)} hint="owed to attendees" />
        <Stat label="Cash-funded" value={fmtR(summary?.cashFundedOutstanding ?? 0)} hint="collected at the office" />
        <Stat label="Average balance" value={fmtR(summary?.averageBalance ?? 0)} hint="per tag" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search tag UID, name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as TagStatus | 'all')}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="unbound">Unbound</SelectItem>
            <SelectItem value="frozen">Frozen</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="pt-6 overflow-x-auto">
          {isLoading ? (
            <p className="py-8 text-center text-muted-foreground">Loading tags…</p>
          ) : !page?.tags.length ? (
            <p className="py-8 text-center text-muted-foreground">No tags issued yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tag</TableHead>
                  <TableHead>Holder</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.tags.map((t: TagRow) => (
                  <TableRow key={t.walletId} className="hover:bg-slate-50">
                    <TableCell className="font-mono text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <Nfc className="h-3.5 w-3.5 text-orange-600" />
                        {t.bandUid ?? '—'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{t.holder.name ?? 'Unknown'}</div>
                      <div className="text-xs text-muted-foreground">{t.holder.phone ?? t.holder.ticketCode ?? ''}</div>
                    </TableCell>
                    <TableCell className="text-right font-semibold">{fmtR(t.balance)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={STATUS_META[t.status].className}>
                        {STATUS_META[t.status].label}
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

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold mt-1">{value}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/components/__tests__/EventTagsPanel.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the sub-tab**

In `src/components/EventCashlessTab.tsx`, beside the other sub-tabs (they are already URL-driven via `?sub=`):

```tsx
import { EventTagsPanel } from '@/components/cashless/EventTagsPanel';
```

```tsx
        <TabsTrigger value="tags">Tags</TabsTrigger>
```

```tsx
      <TabsContent value="tags">
        <EventTagsPanel eventId={eventId} />
      </TabsContent>
```

Gate it exactly like Money and Stock — no extra permission check (the server enforces `VIEW_REVENUE`).

- [ ] **Step 6: Build and run the whole suite**

Run: `npm run build && npx vitest run`
Expected: `✓ built`, all test files pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/cashless/EventTagsPanel.tsx src/components/EventCashlessTab.tsx src/components/__tests__/EventTagsPanel.test.tsx
git commit -m "feat(tags): Tags sub-tab with balances and holders"
```

---

## Task 7: Tag detail sheet (dashboard)

**Files:**
- Create: `src/components/cashless/TagDetailSheet.tsx`
- Modify: `src/components/cashless/EventTagsPanel.tsx`
- Test: `src/components/__tests__/TagDetailSheet.test.tsx`

**Interfaces:**
- Consumes: `apiClient.tags.detail`, `TagDetail` from Task 5.
- Produces: `<TagDetailSheet eventId={string} walletId={string | null} onClose={() => void} />`.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TagDetailSheet } from '@/components/cashless/TagDetailSheet';

afterEach(cleanup);

const detail = vi.fn();
vi.mock('@/lib/api', () => ({ apiClient: { tags: { detail: (...a: any[]) => detail(...a) } } }));

const DETAIL = {
  walletId: 'w1', bandUid: 'UID2', status: 'active',
  balance: 7500, cashFundedBalance: 2500,
  holder: { name: 'Thandi Dlamini', phone: '+26876001234', ticketCode: 'ABC123' },
  bindings: [
    { bandUid: 'UID2', boundAt: '2026-08-01T18:05:00Z', boundBy: 'gate-op-2', unboundAt: null, unboundReason: null },
    { bandUid: 'UID1', boundAt: '2026-08-01T10:00:00Z', boundBy: 'gate-op-1', unboundAt: '2026-08-01T18:00:00Z', unboundReason: 'lost at the bar' },
  ],
  movements: [
    { kind: 'spend', amount: 2500, at: '2026-08-01T19:00:00Z', label: 'Main Bar' },
    { kind: 'topup', amount: 10000, at: '2026-08-01T17:00:00Z', label: 'Top-up' },
  ],
};

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TagDetailSheet eventId="e1" walletId="w1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('TagDetailSheet', () => {
  it('shows the holder and the balance split', async () => {
    detail.mockResolvedValue(DETAIL);
    renderSheet();

    await waitFor(() => expect(screen.getByText('Thandi Dlamini')).toBeDefined());
    expect(screen.getByText('R75.00')).toBeDefined();
    expect(screen.getByText(/R25\.00 cash-funded/i)).toBeDefined();
  });

  it('shows why an earlier tag was released', async () => {
    detail.mockResolvedValue(DETAIL);
    renderSheet();

    await waitFor(() => expect(screen.getByText(/lost at the bar/i)).toBeDefined());
  });

  it('lists spends with the stall that took the money', async () => {
    detail.mockResolvedValue(DETAIL);
    renderSheet();

    await waitFor(() => expect(screen.getByText('Main Bar')).toBeDefined());
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/components/__tests__/TagDetailSheet.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the sheet**

```tsx
// src/components/cashless/TagDetailSheet.tsx
import { useQuery } from '@tanstack/react-query';
import { ArrowDownCircle, ArrowUpCircle, Nfc } from 'lucide-react';
import { apiClient, type TagMovement } from '@/lib/api';
import { fmtR } from '@/lib/money';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** One tag: who holds it, what is on it, every band it has been, every movement. */
export function TagDetailSheet({
  eventId, walletId, onClose,
}: { eventId: string; walletId: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['tag-detail', eventId, walletId],
    queryFn: () => apiClient.tags.detail(eventId, walletId!),
    enabled: !!walletId,
  });

  return (
    <Dialog open={!!walletId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Tag detail</DialogTitle></DialogHeader>

        {isLoading ? (
          <p className="py-8 text-center text-muted-foreground">Loading…</p>
        ) : error || !data ? (
          <p className="py-8 text-center text-muted-foreground">
            {(error as Error)?.message || 'Could not load this tag.'}
          </p>
        ) : (
          <div className="space-y-5">
            <div>
              <div className="text-lg font-semibold">{data.holder.name ?? 'Unknown holder'}</div>
              <div className="text-sm text-muted-foreground">
                {data.holder.phone ?? '—'}{data.holder.ticketCode ? ` · ticket ${data.holder.ticketCode}` : ''}
              </div>
            </div>

            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{fmtR(data.balance)}</div>
              <div className="text-xs text-muted-foreground">
                {fmtR(data.cashFundedBalance)} cash-funded · currently on{' '}
                <span className="font-mono">{data.bandUid ?? 'no tag'}</span>
              </div>
            </div>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Tag history</h3>
              {data.bindings.map((b, i) => (
                <div key={`${b.bandUid}-${i}`} className="flex items-start gap-2 text-sm border-b border-slate-100 pb-2">
                  <Nfc className="h-4 w-4 mt-0.5 text-orange-600 shrink-0" />
                  <div>
                    <div className="font-mono text-xs">{b.bandUid}</div>
                    <div className="text-xs text-muted-foreground">
                      Bound {fmtWhen(b.boundAt)}{b.boundBy ? ` by ${b.boundBy}` : ''}
                      {b.unboundAt ? ` · released ${fmtWhen(b.unboundAt)}` : ''}
                      {b.unboundReason ? ` — ${b.unboundReason}` : ''}
                    </div>
                  </div>
                  {!b.unboundAt && <Badge variant="secondary" className="ml-auto bg-green-100 text-green-800">Current</Badge>}
                </div>
              ))}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Movements</h3>
              {data.movements.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet.</p>
              ) : data.movements.map((m: TagMovement, i) => (
                <div key={i} className="flex items-center gap-2 text-sm border-b border-slate-100 pb-2">
                  {m.kind === 'topup'
                    ? <ArrowDownCircle className="h-4 w-4 text-green-600 shrink-0" />
                    : <ArrowUpCircle className="h-4 w-4 text-orange-600 shrink-0" />}
                  <span className="flex-1">{m.label}</span>
                  <span className="text-xs text-muted-foreground">{fmtWhen(m.at)}</span>
                  <span className="font-semibold tabular-nums">{fmtR(m.amount)}</span>
                </div>
              ))}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/components/__tests__/TagDetailSheet.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Open it from a table row**

In `EventTagsPanel.tsx`, add the state, make rows clickable, and render the sheet:

```tsx
  const [openTag, setOpenTag] = useState<string | null>(null);
```

```tsx
                  <TableRow key={t.walletId} className="hover:bg-slate-50 cursor-pointer" onClick={() => setOpenTag(t.walletId)}>
```

```tsx
      <TagDetailSheet eventId={eventId} walletId={openTag} onClose={() => setOpenTag(null)} />
```

- [ ] **Step 6: Build and run the whole suite**

Run: `npm run build && npx vitest run`
Expected: `✓ built`, all pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/cashless/TagDetailSheet.tsx src/components/cashless/EventTagsPanel.tsx src/components/__tests__/TagDetailSheet.test.tsx
git commit -m "feat(tags): per-tag detail sheet with history"
```

---

## Task 8: Deactivate and reissue a lost tag (api)

**Files:**
- Create: `src/controllers/tagAdmin.controller.ts`
- Modify: `src/routes/tickets.route.ts`
- Test: `src/routes/__tests__/tagAdmin.route.test.ts`

**Interfaces:**
- Consumes: `WalletService.unbindBand(walletId, reason)` and `WalletService.bindBand(walletId, bandUid, boundBy?)` from `@services/wallet.service`; `loadOwnedCashlessEvent`.
- Produces: routes `POST /events/:eventId/tags/:walletId/deactivate` (body `{ reason: string }`) and `POST /events/:eventId/tags/:walletId/reissue` (body `{ bandUid: string }`), both `MANAGE_ACCESS`.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/tagAdmin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { EventStatus } from '@interfaces/event.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR = '64c000000000000000000a01';

const token = (perms: string[]) =>
  jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner', permissions: perms, isSuperAdmin: false, vendorId: VENDOR }, JWT_SECRET);

async function setup() {
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(VENDOR), name: 'Fest', venue: 'V',
    eventDate: future, startTime: future, endTime: future,
    status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const wallet = await Wallet.create({
    eventId: event._id, ticketId: new mongoose.Types.ObjectId(), bandUid: 'LOST1',
    balance: 9000, cashFundedBalance: 0, status: 'active',
  });
  return { event, wallet };
}

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

it('deactivates a lost tag and keeps the balance on the wallet', async () => {
  const { event, wallet } = await setup();

  const res = await request(app)
    .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/deactivate`)
    .set('Authorization', `Bearer ${token(['tickets:manage_access'])}`)
    .send({ reason: 'lost at the bar' });

  expect(res.status).toBe(200);
  const after = await Wallet.findById(wallet._id);
  expect(after!.bandUid).toBeNull();
  expect(after!.balance).toBe(9000);
});

it('403s without manage_access', async () => {
  const { event, wallet } = await setup();

  const res = await request(app)
    .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/deactivate`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`)
    .send({ reason: 'nope' });

  expect(res.status).toBe(403);
});

it('requires a reason', async () => {
  const { event, wallet } = await setup();

  const res = await request(app)
    .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/deactivate`)
    .set('Authorization', `Bearer ${token(['tickets:manage_access'])}`)
    .send({});

  expect(res.status).toBe(400);
});

it('reissues onto a fresh tag, moving the balance with the wallet', async () => {
  const { event, wallet } = await setup();
  await request(app)
    .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/deactivate`)
    .set('Authorization', `Bearer ${token(['tickets:manage_access'])}`)
    .send({ reason: 'lost' });

  const res = await request(app)
    .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
    .set('Authorization', `Bearer ${token(['tickets:manage_access'])}`)
    .send({ bandUid: 'FRESH1' });

  expect(res.status).toBe(200);
  const after = await Wallet.findById(wallet._id);
  expect(after!.bandUid).toBe('FRESH1');
  expect(after!.balance).toBe(9000);
});

it('409s when the new tag is already bound at this event', async () => {
  const { event, wallet } = await setup();
  await Wallet.create({
    eventId: event._id, ticketId: new mongoose.Types.ObjectId(), bandUid: 'TAKEN1',
    balance: 0, cashFundedBalance: 0, status: 'active',
  });

  const res = await request(app)
    .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
    .set('Authorization', `Bearer ${token(['tickets:manage_access'])}`)
    .send({ bandUid: 'TAKEN1' });

  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/routes/__tests__/tagAdmin.route.test.ts --maxWorkers=2`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Write the controller**

```ts
// src/controllers/tagAdmin.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { WalletService } from '@services/wallet.service';
import { Wallet } from '@models/wallet.model';

const hex24 = /^[0-9a-fA-F]{24}$/;

/** Writes on a single tag. Reads live in TagReportController. */
export class TagAdminController {
  /** POST /api/tickets/events/:eventId/tags/:walletId/deactivate */
  static async deactivate(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const walletId = String(req.params['walletId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      if (!hex24.test(walletId)) return ApiResponseUtil.badRequest(res, 'invalid tag id');

      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      // A deactivation without a reason is unauditable — the reason IS the record.
      if (!reason) return ApiResponseUtil.badRequest(res, 'reason is required');

      // Scoped read first: another event's wallet must 404, not be unbound.
      const owned = await Wallet.exists({ _id: walletId, eventId });
      if (!owned) return ApiResponseUtil.error(res, 'Tag not found', 404);

      const wallet = await WalletService.unbindBand(walletId, reason);
      return ApiResponseUtil.success(res, { walletId: String(wallet._id), bandUid: wallet.bandUid });
    } catch (err: any) {
      console.error('Tag deactivate error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to deactivate the tag', 400);
    }
  }

  /** POST /api/tickets/events/:eventId/tags/:walletId/reissue */
  static async reissue(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const walletId = String(req.params['walletId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      if (!hex24.test(walletId)) return ApiResponseUtil.badRequest(res, 'invalid tag id');

      const bandUid = typeof req.body?.bandUid === 'string' ? req.body.bandUid.trim() : '';
      if (!bandUid) return ApiResponseUtil.badRequest(res, 'bandUid is required');

      const owned = await Wallet.exists({ _id: walletId, eventId });
      if (!owned) return ApiResponseUtil.error(res, 'Tag not found', 404);

      // The {eventId, bandUid} partial-unique index is the real guard; this
      // read turns the race's E11000 into a sentence an organizer can act on.
      const taken = await Wallet.exists({ eventId, bandUid, _id: { $ne: walletId } });
      if (taken) return ApiResponseUtil.error(res, 'That tag is already issued at this event', 409);

      const ticketsUser = (req as any).ticketsUser;
      const wallet = await WalletService.bindBand(walletId, bandUid, ticketsUser?.userId || ticketsUser?.vendorId);
      return ApiResponseUtil.success(res, { walletId: String(wallet._id), bandUid: wallet.bandUid });
    } catch (err: any) {
      if (err?.code === 11000) {
        return ApiResponseUtil.error(res, 'That tag is already issued at this event', 409);
      }
      console.error('Tag reissue error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to reissue the tag', 400);
    }
  }
}
```

Routes:

```ts
import { TagAdminController } from '@controllers/tagAdmin.controller';

router.post('/events/:eventId/tags/:walletId/deactivate', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), TagAdminController.deactivate);
router.post('/events/:eventId/tags/:walletId/reissue', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), TagAdminController.reissue);
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/routes/__tests__/tagAdmin.route.test.ts --maxWorkers=2`
Expected: PASS (5 tests).

- [ ] **Step 5: Check the neighbours still pass**

Run: `npx jest src/services/__tests__/scanBindBand.service.test.ts src/services/__tests__/walletBindBand.test.ts --maxWorkers=2`
Expected: PASS. (If `walletBindBand.test.ts` does not exist, run `npx jest --listTests | grep -i wallet` and run what is there.)

- [ ] **Step 6: Commit**

```bash
git add src/controllers/tagAdmin.controller.ts src/routes/tickets.route.ts src/routes/__tests__/tagAdmin.route.test.ts
git commit -m "feat(tags): deactivate a lost tag and reissue onto a fresh one"
```

---

## Task 9: Office cash refund (api)

**Files:**
- Modify: `src/interfaces/ledger.interface.ts`
- Modify: `src/models/walletWithdrawal.model.ts`
- Modify: `src/services/wallet.service.ts:316-398`
- Modify: `src/controllers/tagAdmin.controller.ts`
- Modify: `src/routes/tickets.route.ts`
- Test: `src/services/__tests__/walletOfficeRefund.test.ts`

**Interfaces:**
- Consumes: `WalletService.withdrawCash` from Task 8's neighbourhood.
- Produces: `WalletService.withdrawCash(params & { method?: 'cash' | 'office_cash'; recordedByType?: 'Cashier' | 'Vendor'; floatTag?: FloatTag })` — defaults unchanged, so the cashier path is untouched. Route `POST /events/:eventId/tags/:walletId/refund` (body `{ amount: number; clientTxnId: string }`), `REFUND_TICKET`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/walletOfficeRefund.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { WalletService } from '@services/wallet.service';
import { FloatTag } from '@interfaces/ledger.interface';

const EVENT = new mongoose.Types.ObjectId();

const wallet = () =>
  Wallet.create({
    eventId: EVENT, ticketId: new mongoose.Types.ObjectId(), bandUid: 'UID1',
    balance: 10000, cashFundedBalance: 10000, status: 'active',
  });

describe('office cash refund', () => {
  // Transactions: this path uses withTransaction, so it needs the replica set.
  beforeAll(connectLedgerTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('records the refund, moves the balance and posts a balanced pair', async () => {
    const w = await wallet();

    const { wallet: after, withdrawal } = await WalletService.withdrawCash({
      walletId: String(w._id), eventId: String(EVENT), amount: 4000,
      recordedBy: 'vendor-user-1', clientTxnId: 'refund-1',
      method: 'office_cash', recordedByType: 'Vendor', floatTag: FloatTag.OFFICE,
    });

    expect(after.balance).toBe(6000);
    expect(withdrawal.method).toBe('office_cash');

    const entries = await LedgerEntry.find({ refId: 'refund-1' }).lean();
    expect(entries.reduce((s, e: any) => s + e.delta, 0)).toBe(0);
    expect(entries.find((e: any) => e.accountType === 'float')!.tag).toBe('office');
  });

  it('is idempotent on a retry of the same clientTxnId', async () => {
    const w = await wallet();
    const args = {
      walletId: String(w._id), eventId: String(EVENT), amount: 4000,
      recordedBy: 'vendor-user-1', clientTxnId: 'refund-2',
      method: 'office_cash' as const, recordedByType: 'Vendor' as const, floatTag: FloatTag.OFFICE,
    };

    await WalletService.withdrawCash(args);
    const second = await WalletService.withdrawCash(args);

    expect(second.wallet.balance).toBe(6000);
    expect(await WalletWithdrawal.countDocuments({ clientTxnId: 'refund-2' })).toBe(1);
  });

  it('declines a refund larger than the balance, leaving everything untouched', async () => {
    const w = await wallet();

    await expect(
      WalletService.withdrawCash({
        walletId: String(w._id), eventId: String(EVENT), amount: 999999,
        recordedBy: 'vendor-user-1', clientTxnId: 'refund-3',
        method: 'office_cash', recordedByType: 'Vendor', floatTag: FloatTag.OFFICE,
      }),
    ).rejects.toThrow(/insufficient/i);

    expect((await Wallet.findById(w._id))!.balance).toBe(10000);
    expect(await LedgerEntry.countDocuments({ refId: 'refund-3' })).toBe(0);
  });

  it('still behaves as a cash-desk withdrawal when the new options are omitted', async () => {
    const w = await wallet();

    const { withdrawal } = await WalletService.withdrawCash({
      walletId: String(w._id), eventId: String(EVENT), amount: 1000,
      recordedBy: 'cashier-1', clientTxnId: 'cashout-1',
    });

    expect(withdrawal.method).toBe('cash');
    expect(withdrawal.recordedByType).toBe('Cashier');
    const float = await LedgerEntry.findOne({ refId: 'cashout-1', accountType: 'float' }).lean();
    expect((float as any).tag).toBe('cash_desk');
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/services/__tests__/walletOfficeRefund.test.ts --maxWorkers=2`
Expected: FAIL — `FloatTag.OFFICE` does not exist / extra params rejected by types.

- [ ] **Step 3: Widen the enums**

`src/interfaces/ledger.interface.ts`:

```ts
export enum FloatTag {
  /** Settled into the Keshless-held float via the gateway. */
  KESHLESS = 'keshless',
  /** Physical cash collected at a cash desk, not yet banked. */
  CASH_DESK = 'cash_desk',
  /** Cash handed back to an attendee at the office after the event. */
  OFFICE = 'office',
}
```

`src/models/walletWithdrawal.model.ts` — widen both unions and both enums:

```ts
  method: 'cash' | 'office_cash';
  recordedByType: 'Cashier' | 'ResellerOperator' | 'MerchantOperator' | 'Platform' | 'Vendor';
```

```ts
  method: { type: String, enum: ['cash', 'office_cash'], required: true, default: 'cash' },
  recordedByType: { type: String, enum: ['Cashier', 'ResellerOperator', 'MerchantOperator', 'Platform', 'Vendor'], required: true, default: 'Cashier' },
```

- [ ] **Step 4: Generalise `withdrawCash`**

In `src/services/wallet.service.ts`, widen the params and thread them through — do NOT copy the method:

```ts
  static async withdrawCash(params: {
    walletId: string;
    eventId: string;
    amount: number;
    recordedBy: string;
    clientTxnId: string;
    /** Defaults keep the cashier cash-desk behaviour byte-identical. */
    method?: 'cash' | 'office_cash';
    recordedByType?: 'Cashier' | 'Vendor';
    floatTag?: FloatTag;
  }): Promise<{ wallet: IWallet; withdrawal: IWalletWithdrawal }> {
    const {
      walletId, eventId, amount, recordedBy, clientTxnId,
      method = 'cash', recordedByType = 'Cashier', floatTag = FloatTag.CASH_DESK,
    } = params;
```

In the ledger post, replace the hardcoded tag:

```ts
            { account: { type: LedgerAccountType.FLOAT }, delta: -amount, tag: floatTag },
```

In the withdrawal insert, replace the hardcoded method/recorder:

```ts
          [{ walletId, eventId, amount, method, status: 'completed', recordedBy, recordedByType, clientTxnId }],
```

- [ ] **Step 5: Run the test**

Run: `npx jest src/services/__tests__/walletOfficeRefund.test.ts --maxWorkers=2`
Expected: PASS (4 tests).

- [ ] **Step 6: Prove the cashier path did not move**

Run: `npx jest --listTests | grep -iE "withdraw|cashier" ` then run each: `npx jest <paths> --maxWorkers=2`
Expected: PASS. This is the regression that matters — the cashier's cash-out must be unchanged.

- [ ] **Step 7: Add the refund endpoint**

In `src/controllers/tagAdmin.controller.ts`:

```ts
  /** POST /api/tickets/events/:eventId/tags/:walletId/refund */
  static async refund(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const walletId = String(req.params['walletId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      if (!hex24.test(walletId)) return ApiResponseUtil.badRequest(res, 'invalid tag id');

      const amount = Number(req.body?.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        return ApiResponseUtil.badRequest(res, 'amount must be a positive whole number of cents');
      }
      // Client-supplied so a double-submit cannot double-refund.
      const clientTxnId = typeof req.body?.clientTxnId === 'string' ? req.body.clientTxnId.trim() : '';
      if (!clientTxnId) return ApiResponseUtil.badRequest(res, 'clientTxnId is required');

      const owned = await Wallet.exists({ _id: walletId, eventId });
      if (!owned) return ApiResponseUtil.error(res, 'Tag not found', 404);

      const ticketsUser = (req as any).ticketsUser;
      const { wallet, withdrawal } = await WalletService.withdrawCash({
        walletId, eventId, amount, clientTxnId,
        recordedBy: (ticketsUser?.userId || ticketsUser?.vendorId) as string,
        method: 'office_cash', recordedByType: 'Vendor', floatTag: FloatTag.OFFICE,
      });

      return ApiResponseUtil.success(res, {
        walletId: String(wallet._id), balance: wallet.balance, withdrawalId: String(withdrawal._id),
      });
    } catch (err: any) {
      // A decline is not a server error — say which one it was.
      const reason = err?.reason ?? err?.code;
      if (reason === 'insufficient_balance') return ApiResponseUtil.error(res, 'The tag does not hold that much', 402);
      if (reason === 'wallet_not_active') return ApiResponseUtil.error(res, 'This tag is not active', 409);
      if (reason === 'wallet_not_found') return ApiResponseUtil.error(res, 'Tag not found', 404);
      console.error('Tag refund error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to record the refund', 400);
    }
  }
```

Add the imports `WalletService`, `FloatTag` and the route:

```ts
router.post('/events/:eventId/tags/:walletId/refund', requireTicketsPermission(TicketsPermission.REFUND_TICKET), TagAdminController.refund);
```

- [ ] **Step 8: Commit**

```bash
git add src/interfaces/ledger.interface.ts src/models/walletWithdrawal.model.ts src/services/wallet.service.ts src/controllers/tagAdmin.controller.ts src/routes/tickets.route.ts src/services/__tests__/walletOfficeRefund.test.ts
git commit -m "feat(tags): record an office cash refund against a tag"
```

---

## Task 10: Tag actions in the UI (dashboard)

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/components/cashless/TagDetailSheet.tsx`
- Test: `src/components/__tests__/TagDetailActions.test.tsx`

**Interfaces:**
- Consumes: the three write routes from Tasks 8–9.
- Produces: `apiClient.tags.deactivate(eventId, walletId, reason)`, `.reissue(eventId, walletId, bandUid)`, `.refund(eventId, walletId, amount, clientTxnId)`.

- [ ] **Step 1: Add the client methods**

```ts
    deactivate: async (eventId: string, walletId: string, reason: string): Promise<{ walletId: string; bandUid: string | null }> =>
      this.request(`/tickets/events/${eventId}/tags/${walletId}/deactivate`, {
        method: 'POST', body: JSON.stringify({ reason }),
      }),

    reissue: async (eventId: string, walletId: string, bandUid: string): Promise<{ walletId: string; bandUid: string | null }> =>
      this.request(`/tickets/events/${eventId}/tags/${walletId}/reissue`, {
        method: 'POST', body: JSON.stringify({ bandUid }),
      }),

    refund: async (eventId: string, walletId: string, amount: number, clientTxnId: string): Promise<{ walletId: string; balance: number }> =>
      this.request(`/tickets/events/${eventId}/tags/${walletId}/refund`, {
        method: 'POST', body: JSON.stringify({ amount, clientTxnId }),
      }),
```

- [ ] **Step 2: Write the failing test**

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TagDetailSheet } from '@/components/cashless/TagDetailSheet';

afterEach(cleanup);

const detail = vi.fn();
const refund = vi.fn();
const deactivate = vi.fn();
vi.mock('@/lib/api', () => ({
  apiClient: {
    tags: {
      detail: (...a: any[]) => detail(...a),
      refund: (...a: any[]) => refund(...a),
      deactivate: (...a: any[]) => deactivate(...a),
      reissue: vi.fn(),
    },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DETAIL = {
  walletId: 'w1', bandUid: 'UID2', status: 'active',
  balance: 7500, cashFundedBalance: 2500,
  holder: { name: 'Thandi', phone: '+26876001234', ticketCode: 'ABC123' },
  bindings: [], movements: [],
};

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TagDetailSheet eventId="e1" walletId="w1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('TagDetailSheet actions', () => {
  it('defaults the refund to the whole balance', async () => {
    detail.mockResolvedValue(DETAIL);
    renderSheet();

    fireEvent.click(await screen.findByRole('button', { name: /refund/i }));

    await waitFor(() => expect((screen.getByLabelText(/amount/i) as HTMLInputElement).value).toBe('75.00'));
  });

  it('sends the refund in cents with an idempotency key', async () => {
    detail.mockResolvedValue(DETAIL);
    refund.mockResolvedValue({ walletId: 'w1', balance: 0 });
    renderSheet();

    fireEvent.click(await screen.findByRole('button', { name: /refund/i }));
    fireEvent.click(screen.getByRole('button', { name: /record refund/i }));

    await waitFor(() => expect(refund).toHaveBeenCalled());
    const [eventId, walletId, amount, clientTxnId] = refund.mock.calls[0]!;
    expect([eventId, walletId, amount]).toEqual(['e1', 'w1', 7500]);
    expect(String(clientTxnId).length).toBeGreaterThan(8);
  });

  it('states that the refund only records cash handed over', async () => {
    detail.mockResolvedValue(DETAIL);
    renderSheet();

    fireEvent.click(await screen.findByRole('button', { name: /refund/i }));

    expect(screen.getByText(/records cash handed over/i)).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it to watch it fail**

Run: `npx vitest run src/components/__tests__/TagDetailActions.test.tsx`
Expected: FAIL — no Refund button.

- [ ] **Step 4: Add the actions to the sheet**

Inside `TagDetailSheet`, below the balance card. `randToCents`/`centsToRand` already exist in `@/lib/money`:

```tsx
  const queryClient = useQueryClient();
  const [action, setAction] = useState<null | 'refund' | 'deactivate' | 'reissue'>(null);
  const [amountRand, setAmountRand] = useState('');
  const [reason, setReason] = useState('');
  const [newUid, setNewUid] = useState('');
  // One key per opened dialog: a double-click cannot become a double refund.
  const [txnKey, setTxnKey] = useState('');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tag-detail', eventId, walletId] });
    queryClient.invalidateQueries({ queryKey: ['tags', eventId] });
    queryClient.invalidateQueries({ queryKey: ['tag-summary', eventId] });
  };

  const refundM = useMutation({
    mutationFn: () => {
      const cents = randToCents(amountRand);
      if (cents == null || cents <= 0) throw new Error('Enter a valid amount');
      return apiClient.tags.refund(eventId, walletId!, cents, txnKey);
    },
    onSuccess: () => { invalidate(); setAction(null); toast.success('Refund recorded'); },
    onError: (e: Error) => toast.error(e.message || 'Could not record the refund'),
  });

  const deactivateM = useMutation({
    mutationFn: () => apiClient.tags.deactivate(eventId, walletId!, reason.trim()),
    onSuccess: () => { invalidate(); setAction(null); toast.success('Tag deactivated'); },
    onError: (e: Error) => toast.error(e.message || 'Could not deactivate the tag'),
  });

  const reissueM = useMutation({
    mutationFn: () => apiClient.tags.reissue(eventId, walletId!, newUid.trim()),
    onSuccess: () => { invalidate(); setAction(null); toast.success('Tag reissued'); },
    onError: (e: Error) => toast.error(e.message || 'Could not reissue the tag'),
  });

  const openRefund = () => {
    setAmountRand(centsToRand(data!.balance));
    setTxnKey(`refund-${walletId}-${crypto.randomUUID()}`);
    setAction('refund');
  };
```

```tsx
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setAction('deactivate')}>Report lost</Button>
              <Button variant="outline" size="sm" onClick={() => setAction('reissue')}>Reissue</Button>
              <Button size="sm" className="bg-orange-600 hover:bg-orange-700" onClick={openRefund}>Refund</Button>
            </div>

            {action === 'refund' && (
              <div className="rounded-lg border p-3 space-y-2">
                <Label htmlFor="refund-amount">Amount (R)</Label>
                <Input id="refund-amount" inputMode="decimal" value={amountRand} onChange={(e) => setAmountRand(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  This records cash handed over at the office. It does not send money anywhere.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setAction(null)}>Cancel</Button>
                  <Button size="sm" disabled={refundM.isPending} className="bg-orange-600 hover:bg-orange-700" onClick={() => refundM.mutate()}>
                    {refundM.isPending ? 'Recording…' : 'Record refund'}
                  </Button>
                </div>
              </div>
            )}

            {action === 'deactivate' && (
              <div className="rounded-lg border p-3 space-y-2">
                <Label htmlFor="lost-reason">What happened?</Label>
                <Input id="lost-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. lost at the bar" />
                <p className="text-xs text-muted-foreground">The balance stays on the wallet and moves to the replacement tag.</p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setAction(null)}>Cancel</Button>
                  <Button size="sm" disabled={deactivateM.isPending || !reason.trim()} onClick={() => deactivateM.mutate()}>
                    {deactivateM.isPending ? 'Working…' : 'Deactivate tag'}
                  </Button>
                </div>
              </div>
            )}

            {action === 'reissue' && (
              <div className="rounded-lg border p-3 space-y-2">
                <Label htmlFor="new-uid">New tag UID</Label>
                <Input id="new-uid" value={newUid} onChange={(e) => setNewUid(e.target.value)} placeholder="Tap or type the new tag's UID" />
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setAction(null)}>Cancel</Button>
                  <Button size="sm" disabled={reissueM.isPending || !newUid.trim()} onClick={() => reissueM.mutate()}>
                    {reissueM.isPending ? 'Working…' : 'Reissue'}
                  </Button>
                </div>
              </div>
            )}
```

Imports to add: `useState` (if absent), `useMutation`, `useQueryClient`, `toast` from `sonner`, `Button`, `Input`, `Label`, and `randToCents`, `centsToRand` from `@/lib/money`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/components/__tests__/TagDetailActions.test.tsx src/components/__tests__/TagDetailSheet.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Build and run the whole suite**

Run: `npm run build && npx vitest run`
Expected: `✓ built`, all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/components/cashless/TagDetailSheet.tsx src/components/__tests__/TagDetailActions.test.tsx
git commit -m "feat(tags): report lost, reissue and record an office refund"
```

---

## Verification before calling this done

- [ ] api: `npx jest src/services/__tests__/tagReport*.test.ts src/routes/__tests__/tag*.test.ts src/services/__tests__/walletOfficeRefund.test.ts --maxWorkers=2` — all pass.
- [ ] api: run the wallet/cashier suites named in Task 9 Step 6 — unchanged.
- [ ] api: `npx tsc --noEmit -p tsconfig.json` — clean.
- [ ] dashboard: `npm run build && npx vitest run` — clean.
- [ ] dashboard: `npx eslint <changed files>` — no NEW errors (several files carry pre-existing `any` errors; compare against the branch point).
- [ ] Manual, against dev with a seeded cashless event: the Tags tab lists the seeded wallets, the detail sheet shows a top-up, a refund of part of a balance reduces it by exactly that amount, and a second submit of the same refund does not double-deduct.

## Known flake

The full api suite is contention-flaky above ~4 workers: each suite starts its own `mongodb-memory-server`, and under load unrelated suites fail their `beforeAll`/`afterEach` hooks with "Exceeded timeout of 30000 ms". Failures differ run to run and pass in isolation. Use `--maxWorkers=2` for anything you intend to believe, and re-run a failure isolated before treating it as a regression.
