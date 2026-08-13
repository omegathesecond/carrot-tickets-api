# Per-event Currency Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let organizers choose an event's display currency (E / R) so it renders across every buyer, organizer, accounting, and POS surface, while recording the rail-native settlement currency truthfully on every sale.

**Architecture:** `event.currency` (already on the model, `'SZL'|'ZAR'`, default `'SZL'`) becomes the **display currency**, un-gated from external-only to all events. It is snapshotted onto each `Ticket` and `TicketSale`. A new `ticketSale.settlementCurrency` records the rail's native code (MoMo→`SZL`, card→`ZAR`, DeltaPay→`SZL`, wallet/cash→`SZL`). Every price render routes through a single currency-aware formatter per frontend app. Payment-gateway request currencies and verify/reconcile guards are untouched.

**Tech Stack:** Node/TypeScript + Mongoose + Joi (`api`); React + Vite + TypeScript (`dashboard`, `landing`); Flutter/Dart (`pos-app`). Each subproject is its **own git repo** — commits are per-repo.

**Spec:** `api/docs/superpowers/specs/2026-08-13-event-currency-selection-design.md`

## Global Constraints

- **Currencies:** exactly `'SZL'` (symbol `E`) and `'ZAR'` (symbol `R`). No other codes. `'ZAR' → 'R'`, everything else → `'E'`.
- **Peg:** SZL = ZAR 1:1. No conversion math anywhere.
- **No silent fallbacks** (workspace rule): where an event is in scope, pass its `currency` explicitly — do not default to `'SZL'` at the call site. A default currency is allowed only in genuinely event-less contexts.
- **Payments frozen:** do NOT change gateway request currencies or the MoMo/card/DeltaPay verify/reconcile guards. Only *persist* the settlement currency they already use.
- **Cross-event aggregates** (totals summed over mixed-currency events) render in base **`E`**, never a per-event symbol.
- **No data migration.** New fields default to `'SZL'` — the correct historical value.
- **Out of scope, do not touch:** the cashless/wallet `fmtR` ZAR-cents system; the transport/bus vertical (`services/transport/*`); per-ticket-type currency.
- **Frontend verification uses `npm run build`** (tsc `-b`), NOT `tsc --noEmit` — the latter misses `noUnusedLocals` and Pages build failures.
- **Never build/run the Flutter POS app** unless the human explicitly asks. Dart is written but not built in this plan.
- Do not commit or push beyond the per-task `git commit` steps; never push to a prod branch.

---

## File Structure

**api/** (repo `api`)
- Create `src/utils/currency.util.ts` — pure helpers: `settlementCurrencyForMethod(method)`, `EVENT_CURRENCIES`.
- Create `src/utils/currency.util.test.ts` (or the repo's test location).
- Modify `src/interfaces/ticket.interface.ts` — add `currency` to `ITicket`, `currency`+`settlementCurrency` to `ITicketSale`.
- Modify `src/interfaces/event.interface.ts:67-73` — doc comment only (drop "external only").
- Modify `src/models/ticket.model.ts:30-35` — add `currency` field.
- Modify `src/models/ticketSale.model.ts:64-155` — add `currency` + `settlementCurrency` fields.
- Modify `src/services/ticket.service.ts` — thread `currency` through `buildTicket` (:110) and `buildSaleSnapshot` (:146); confirm all `new TicketSale({...})` sites (375, 427, 741, 1168, 1312, 1451) spread the snapshot.

**dashboard/** (repo `dashboard`)
- Modify `src/lib/currency.ts` — add `formatMoney`, `formatMoneyRange`.
- Modify `src/lib/chartColors.ts:125-132` — `formatCurrency(value, currency)` delegates.
- Modify `src/lib/ticketing.ts:94-107` — currency always in payload for carrot + external.
- Modify `src/pages/EventsPage.tsx` — move currency `<select>` out of the external block.
- Modify `src/pages/EventDetailsPage.tsx` — mirror the un-gating.
- Modify the ~20 organizer/accounting display sites (enumerated in Task 6).

**landing/** (repo `landing`)
- Modify `src/lib/currency.ts` — add `formatMoney`, `formatMoneyRange`.
- Modify `src/lib/pricing.ts:55-59` — `formatAdmissionPrice(priceRange, currency)`.
- Modify the ~18 buyer display sites (enumerated in Task 8).

**pos-app/** (repo `pos-app`)
- Modify `lib/printer.dart:46-47` and `lib/pages/pos_page.dart:49-50` — `_money(v, currency)`.

---

## Task 1: API — currency util (pure helpers)

**Files:**
- Create: `api/src/utils/currency.util.ts`
- Test: `api/src/utils/currency.util.test.ts`

**Interfaces:**
- Produces:
  - `type EventCurrency = 'SZL' | 'ZAR'`
  - `settlementCurrencyForMethod(method: PaymentMethod): EventCurrency` — the rail-native settlement code for a payment method (card → `'ZAR'`, everything else → `'SZL'`).

- [ ] **Step 1: Write the failing test**

```ts
// api/src/utils/currency.util.test.ts
import { settlementCurrencyForMethod } from './currency.util';
import { PaymentMethod } from '@interfaces/ticket.interface';

describe('settlementCurrencyForMethod', () => {
  it('settles card payments in ZAR (Peach is ZAR-native)', () => {
    expect(settlementCurrencyForMethod(PaymentMethod.PEACH_CARD)).toBe('ZAR');
  });
  it('settles MoMo in SZL', () => {
    expect(settlementCurrencyForMethod(PaymentMethod.MTN_MOMO)).toBe('SZL');
  });
  it('settles wallet / cash / deltapay in SZL', () => {
    expect(settlementCurrencyForMethod(PaymentMethod.CASH)).toBe('SZL');
    expect(settlementCurrencyForMethod(PaymentMethod.KESHLESS_WALLET)).toBe('SZL');
  });
});
```

> Before writing, open `api/src/interfaces/ticket.interface.ts` and use the EXACT `PaymentMethod` enum member names (e.g. `PEACH_CARD`, `MTN_MOMO`, `CASH`, `KESHLESS_WALLET`, `DELTAPAY`). Card is whichever member Peach uses; only the card member returns `'ZAR'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/utils/currency.util.test.ts`
Expected: FAIL — `settlementCurrencyForMethod` is not defined. (If the repo uses a different test runner, match `package.json`'s `test` script.)

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/utils/currency.util.ts
import { PaymentMethod } from '@interfaces/ticket.interface';

export type EventCurrency = 'SZL' | 'ZAR';

/** The two display currencies an organizer may pick for an event. */
export const EVENT_CURRENCIES: readonly EventCurrency[] = ['SZL', 'ZAR'] as const;

/**
 * The currency a payment rail natively settles in. Card (Peach) settles in ZAR;
 * every other rail (MoMo, DeltaPay, Keshless wallet, cash/POS) settles in SZL.
 * This is what the existing MoMo/card verify guards already assert — we only
 * persist it per sale, we do NOT change what the guards check.
 */
export function settlementCurrencyForMethod(method: PaymentMethod): EventCurrency {
  return method === PaymentMethod.PEACH_CARD ? 'ZAR' : 'SZL';
}
```

> Use the real card enum member. If card and MoMo/cash names differ from the guesses, adjust the single `===` and the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/utils/currency.util.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd api && git add src/utils/currency.util.ts src/utils/currency.util.test.ts
git commit -m "feat(currency): add settlementCurrencyForMethod + EventCurrency helper"
```

---

## Task 2: API — persist display + settlement currency on every ticket & sale

**Files:**
- Modify: `api/src/interfaces/ticket.interface.ts` (`ITicket` ~:33-43, `ITicketSale` ~:70-113)
- Modify: `api/src/interfaces/event.interface.ts:67-73` (doc comment only)
- Modify: `api/src/models/ticket.model.ts:30-35`
- Modify: `api/src/models/ticketSale.model.ts:64-155`
- Modify: `api/src/services/ticket.service.ts` (`buildTicket` :110-136, `buildSaleSnapshot` :146-160, sale-build sites 375/427/741/1168/1312/1451, buildTicket call sites)
- Test: `api/src/services/ticket.currency.test.ts` (new)

**Interfaces:**
- Consumes: `EventCurrency`, `settlementCurrencyForMethod` (Task 1).
- Produces: every `Ticket` carries `currency`; every `TicketSale` carries `currency` (display snapshot) and `settlementCurrency` (rail-native). `buildSaleSnapshot` now takes `displayCurrency` and returns `currency` + `settlementCurrency` in its spread.

- [ ] **Step 1: Add the interface fields**

In `api/src/interfaces/ticket.interface.ts`:
- `ITicket`: add `currency?: EventCurrency;` (import `EventCurrency` from `@utils/currency.util`).
- `ITicketSale`: add `currency?: EventCurrency;` and `settlementCurrency?: EventCurrency;`.

- [ ] **Step 2: Add the model fields**

In `api/src/models/ticket.model.ts`, after the `price` block (:35):

```ts
  // Snapshot of the event's DISPLAY currency at mint time, so a printed stub /
  // receipt renders the right symbol even if the organizer later changes it.
  currency: {
    type: String,
    enum: ['SZL', 'ZAR'],
    default: 'SZL'
  },
```

In `api/src/models/ticketSale.model.ts`, inside the `// Payment` block (after `totalAmount`, ~:69):

```ts
  // DISPLAY currency snapshot (from event.currency) — what buyer/organizer see.
  currency: {
    type: String,
    enum: ['SZL', 'ZAR'],
    default: 'SZL'
  },
  // Rail-native SETTLEMENT currency actually used (card→ZAR, else→SZL). May
  // differ from `currency` at par (e.g. a ZAR event paid via MoMo settles SZL).
  // Recorded for honest reconciliation; the verify guards are unchanged.
  settlementCurrency: {
    type: String,
    enum: ['SZL', 'ZAR']
  },
```

- [ ] **Step 3: Write the failing test**

```ts
// api/src/services/ticket.currency.test.ts
import { TicketService } from './ticket.service';
import { PaymentMethod } from '@interfaces/ticket.interface';

describe('TicketService currency snapshots', () => {
  it('buildSaleSnapshot stamps display + settlement currency', async () => {
    const snap = await (TicketService as any).buildSaleSnapshot({
      totalAmount: 100,
      paymentMethod: PaymentMethod.PEACH_CARD,
      mappedSoldByType: 'Vendor',
      displayCurrency: 'ZAR',
    });
    expect(snap.currency).toBe('ZAR');           // display = organizer choice
    expect(snap.settlementCurrency).toBe('ZAR'); // card is ZAR-native
  });

  it('records SZL settlement for a ZAR event paid by MoMo', async () => {
    const snap = await (TicketService as any).buildSaleSnapshot({
      totalAmount: 100,
      paymentMethod: PaymentMethod.MTN_MOMO,
      mappedSoldByType: 'Vendor',
      displayCurrency: 'ZAR',
    });
    expect(snap.currency).toBe('ZAR');
    expect(snap.settlementCurrency).toBe('SZL');
  });
});
```

> `buildSaleSnapshot` needs `PaymentConfigService.get()`; if that requires a DB, either mock it (`jest.spyOn(PaymentConfigService, 'get').mockResolvedValue({ platformFeePercent: 0 } as any)`) or move the currency stamping into a pure branch the test can reach without a DB. Prefer the mock.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd api && npx jest src/services/ticket.currency.test.ts`
Expected: FAIL — `snap.currency` / `snap.settlementCurrency` are `undefined`.

- [ ] **Step 5: Thread currency through `buildSaleSnapshot`**

In `api/src/services/ticket.service.ts`, extend the `buildSaleSnapshot` param and return (:146-160):

```ts
  private static async buildSaleSnapshot(p: {
    totalAmount: number;
    paymentMethod: PaymentMethod;
    mappedSoldByType: SaleSoldByType;
    resellerCommissionPercent?: number;
    displayCurrency: EventCurrency;          // NEW — the event's display currency
  }): Promise<SaleEconomics & { currency: EventCurrency; settlementCurrency: EventCurrency }> {
    const cfg = await PaymentConfigService.get();
    const economics = computeSaleEconomics({
      faceAmount: p.totalAmount,
      paymentMethod: p.paymentMethod,
      soldByType: p.mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent ?? 0,
      platformFeePercent: cfg.platformFeePercent,
    });
    return {
      ...economics,
      currency: p.displayCurrency,
      settlementCurrency: settlementCurrencyForMethod(p.paymentMethod),
    };
  }
```

Add imports at the top: `import { EventCurrency, settlementCurrencyForMethod } from '@utils/currency.util';`

- [ ] **Step 6: Pass `displayCurrency` at each `buildSaleSnapshot` call & confirm each `new TicketSale` spreads the snapshot**

At every `buildSaleSnapshot({...})` call, add `displayCurrency: event.currency ?? 'SZL'` (the loaded event is in scope at each; `?? 'SZL'` guards a legacy event doc with no currency — this is an event-less-legacy default, permitted). Confirm each `new TicketSale({...})` site (375, 427, 741, 1168, 1312, 1451) spreads the snapshot object (`...snapshot`/`...economics`) so `currency` + `settlementCurrency` land automatically. If any site sets fields explicitly instead of spreading, add `currency` and `settlementCurrency` there.

- [ ] **Step 7: Thread `currency` through `buildTicket`**

In `buildTicket` (:110-136) add `currency?: EventCurrency;` to the param and `currency: p.currency ?? 'SZL',` to the `new Ticket({...})`. At each `buildTicket({...})` call site (sellTickets main loop, no-tx fallback, finalizeMomoSale), pass `currency: event.currency ?? 'SZL'`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd api && npx jest src/services/ticket.currency.test.ts src/utils/currency.util.test.ts`
Expected: PASS. Then `cd api && npm run build` (or `npx tsc --noEmit`) — Expected: clean.

- [ ] **Step 9: Update the interface doc comment**

In `api/src/interfaces/event.interface.ts:67-73`, change the comment so `currency` is documented as the event's display currency for **all** events (drop "Only meaningful for external events").

- [ ] **Step 10: Commit**

```bash
cd api && git add src/interfaces/ src/models/ticket.model.ts src/models/ticketSale.model.ts src/services/ticket.service.ts src/services/ticket.currency.test.ts
git commit -m "feat(currency): snapshot display currency + record rail settlement currency on sales/tickets"
```

---

## Task 3: Dashboard — currency formatter (consolidate)

**Files:**
- Modify: `dashboard/src/lib/currency.ts`
- Modify: `dashboard/src/lib/chartColors.ts:124-132`
- Test: `dashboard/src/lib/currency.test.ts` (new; match the repo's frontend test setup — Vitest/Jest. If no test runner exists, skip Steps 1-2 and verify via `npm run build` + a manual render.)

**Interfaces:**
- Produces:
  - `formatMoney(amount: number, currency: Currency, opts?: { space?: boolean; decimals?: number }): string`
  - `formatMoneyRange(min: number, max: number, currency: Currency): string`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/src/lib/currency.test.ts
import { formatMoney, formatMoneyRange } from './currency';

it('formats SZL with E and ZAR with R', () => {
  expect(formatMoney(100, 'SZL')).toBe('E100');
  expect(formatMoney(100, 'ZAR')).toBe('R100');
});
it('supports spaced + fixed-decimal variant (chart/receipt style)', () => {
  expect(formatMoney(1500, 'SZL', { space: true, decimals: 0 })).toBe('E 1,500');
});
it('formats a range', () => {
  expect(formatMoneyRange(100, 250, 'ZAR')).toBe('R100–R250');
  expect(formatMoneyRange(100, 100, 'SZL')).toBe('E100');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/lib/currency.test.ts` (or the repo's test command)
Expected: FAIL — `formatMoney` not exported.

- [ ] **Step 3: Implement**

Append to `dashboard/src/lib/currency.ts`:

```ts
/**
 * Format a money amount with the currency's symbol. Default is tight ("R100")
 * to match inline price sites. `space` inserts a gap ("E 100") and `decimals`
 * forces fixed decimals with thousands separators (the chart/receipt style).
 */
export function formatMoney(
  amount: number,
  currency: Currency,
  opts: { space?: boolean; decimals?: number } = {}
): string {
  const sym = currencySymbol(currency);
  const gap = opts.space ? ' ' : '';
  const body = opts.decimals != null
    ? amount.toLocaleString('en-US', {
        minimumFractionDigits: opts.decimals,
        maximumFractionDigits: opts.decimals,
      })
    : String(amount);
  return `${sym}${gap}${body}`;
}

/** A min–max admission range; collapses to a single figure when equal. */
export function formatMoneyRange(min: number, max: number, currency: Currency): string {
  const lo = formatMoney(min, currency);
  return max > min ? `${lo}–${formatMoney(max, currency)}` : lo;
}
```

- [ ] **Step 4: Refactor `chartColors.formatCurrency` to take a currency**

Replace `dashboard/src/lib/chartColors.ts:125-132` with:

```ts
import { formatMoney, type Currency } from '@/lib/currency';

// Format an amount for charts/tiles. `currency` defaults to 'SZL' ONLY for
// cross-event aggregate totals that have no single event currency (base = E).
export const formatCurrency = (value: number, currency: Currency = 'SZL'): string =>
  formatMoney(value, currency, { space: true, decimals: 0 });
```

- [ ] **Step 5: Run test + build**

Run: `cd dashboard && npx vitest run src/lib/currency.test.ts && npm run build`
Expected: tests PASS; build clean. (Build may flag `formatCurrency` call sites that now need a currency — those are fixed in Task 5. If build fails only on those, that's expected; proceed and let Task 5 close them, or temporarily keep the default param so the build stays green between tasks. The default param keeps it green.)

- [ ] **Step 6: Commit**

```bash
cd dashboard && git add src/lib/currency.ts src/lib/currency.test.ts src/lib/chartColors.ts
git commit -m "feat(currency): add formatMoney/formatMoneyRange, make formatCurrency currency-aware"
```

---

## Task 4: Landing — currency formatter (consolidate)

**Files:**
- Modify: `landing/src/lib/currency.ts`
- Modify: `landing/src/lib/pricing.ts:55-59`
- Test: `landing/src/lib/currency.test.ts` (new; same test-runner caveat as Task 3)

**Interfaces:**
- Produces: `formatMoney`, `formatMoneyRange` (identical signatures to Task 3).
- Changes: `formatAdmissionPrice(priceRange: { min: number; max: number }, currency: Currency): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// landing/src/lib/currency.test.ts
import { formatMoney, formatMoneyRange } from './currency';
it('symbols by currency', () => {
  expect(formatMoney(50, 'ZAR')).toBe('R50');
  expect(formatMoney(50, 'SZL')).toBe('E50');
});
it('range collapses when equal', () => {
  expect(formatMoneyRange(80, 80, 'ZAR')).toBe('R80');
});
```

Also a pricing test:

```ts
// landing/src/lib/pricing.test.ts (add case)
import { formatAdmissionPrice } from './pricing';
it('renders admission in the event currency', () => {
  expect(formatAdmissionPrice({ min: 100, max: 250 }, 'ZAR')).toBe('R100–R250');
  expect(formatAdmissionPrice({ min: 0, max: 0 }, 'ZAR')).toBe('Free');
  expect(formatAdmissionPrice({ min: Infinity, max: Infinity }, 'SZL')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd landing && npx vitest run src/lib/currency.test.ts src/lib/pricing.test.ts`
Expected: FAIL — `formatMoney` not exported; `formatAdmissionPrice` arity mismatch.

- [ ] **Step 3: Implement the formatter**

Append the SAME `formatMoney` + `formatMoneyRange` from Task 3 Step 3 to `landing/src/lib/currency.ts` (same code — the two apps have no shared package; this is the accepted DRY boundary).

- [ ] **Step 4: Refactor `formatAdmissionPrice`**

Replace `landing/src/lib/pricing.ts:55-59`:

```ts
import { formatMoneyRange, type Currency } from '@/lib/currency';

export function formatAdmissionPrice(
  priceRange: { min: number; max: number },
  currency: Currency
): string | null {
  if (!Number.isFinite(priceRange.min)) return null;
  if (priceRange.min === 0) return 'Free';
  return formatMoneyRange(priceRange.min, priceRange.max, currency);
}
```

(Add the `import type { Currency }` if not already imported; keep the existing `import type { TicketType }`.)

- [ ] **Step 5: Run test + build**

Run: `cd landing && npx vitest run src/lib/currency.test.ts src/lib/pricing.test.ts && npm run build`
Expected: tests PASS. Build will flag `formatAdmissionPrice` call sites missing the new `currency` arg — fixed in Task 6. If you want the build green between tasks, close those call sites now as part of this commit (they're listed in Task 6); otherwise proceed.

- [ ] **Step 6: Commit**

```bash
cd landing && git add src/lib/currency.ts src/lib/currency.test.ts src/lib/pricing.ts src/lib/pricing.test.ts
git commit -m "feat(currency): add formatMoney/formatMoneyRange, make formatAdmissionPrice currency-aware"
```

---

## Task 5: Dashboard — un-gate the currency picker

**Files:**
- Modify: `dashboard/src/lib/ticketing.ts:89-107`
- Modify: `dashboard/src/pages/EventsPage.tsx` (picker ~:297-320, submit merge ~:235)
- Modify: `dashboard/src/pages/EventDetailsPage.tsx` (picker ~:605-606, payload merge ~:201)
- Test: `dashboard/src/lib/ticketing.test.ts` (new or existing)

**Interfaces:**
- Consumes: `Currency` (currency.ts).
- Produces: `buildPricePayload(ticketing, currency, priceMin, priceMax)` — always includes `currency`; includes `priceMin/priceMax` only for external. (Renamed from `buildExternalPricePayload`.)

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/src/lib/ticketing.test.ts
import { buildPricePayload } from './ticketing';

it('sends currency for carrot events (no price bounds)', () => {
  expect(buildPricePayload('carrot', 'ZAR', '', '')).toEqual({ currency: 'ZAR' });
});
it('sends currency + bounds for external events', () => {
  expect(buildPricePayload('external', 'ZAR', '100', '250'))
    .toEqual({ currency: 'ZAR', priceMin: 100, priceMax: 250 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/lib/ticketing.test.ts`
Expected: FAIL — `buildPricePayload` not exported (currently `buildExternalPricePayload` drops currency for carrot).

- [ ] **Step 3: Rewrite the payload builder**

Replace `buildExternalPricePayload` (`dashboard/src/lib/ticketing.ts:89-107`) with:

```ts
/**
 * Builds the currency/price fields to merge into the event payload. `currency`
 * is the event's DISPLAY currency and is ALWAYS sent (carrot + external). Price
 * bounds are external-only (carrot prices come from the ticket tiers).
 */
export function buildPricePayload(
  ticketing: Ticketing,
  currency: Currency,
  priceMin: string | number | undefined | null,
  priceMax: string | number | undefined | null,
): { currency: Currency; priceMin?: number; priceMax?: number } {
  const out: { currency: Currency; priceMin?: number; priceMax?: number } = { currency };
  if (ticketing === 'external') {
    const min = parsePrice(priceMin);
    const max = parsePrice(priceMax);
    if (min != null) out.priceMin = min;
    if (max != null) out.priceMax = max;
  }
  return out;
}
```

Update the two importers (`EventsPage.tsx`, `EventDetailsPage.tsx`) to call `buildPricePayload` and grep for any other `buildExternalPricePayload` references.

- [ ] **Step 4: Move the currency `<select>` out of the external block (EventsPage)**

In `dashboard/src/pages/EventsPage.tsx`, lift the currency `<div>` (currently :298-309) OUT of the `{ticketing === 'external' && (...)}` block so it renders for all events — place it directly under the ticketing `<Tabs>` (after :276). Leave `priceMin`/`priceMax` inside the external block (change its grid to `grid-cols-2`). Suggested standalone block:

```tsx
<div className="space-y-2">
  <Label htmlFor="currency">Currency</Label>
  <select
    id="currency"
    value={currency}
    onChange={(e) => setCurrency(e.target.value as Currency)}
    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  >
    <option value="SZL">E (SZL) — Eswatini Lilangeni</option>
    <option value="ZAR">R (ZAR) — South African Rand</option>
  </select>
  <p className="text-xs text-slate-500">
    Prices for this event are shown with this currency's symbol
    ({currencySymbol(currency)}).
  </p>
</div>
```

- [ ] **Step 5: Mirror in EventDetailsPage**

In `dashboard/src/pages/EventDetailsPage.tsx`, apply the same lift-out for the edit form and switch its payload call to `buildPricePayload`.

- [ ] **Step 6: Run test + build**

Run: `cd dashboard && npx vitest run src/lib/ticketing.test.ts && npm run build`
Expected: tests PASS; build clean.

- [ ] **Step 7: Commit**

```bash
cd dashboard && git add src/lib/ticketing.ts src/lib/ticketing.test.ts src/pages/EventsPage.tsx src/pages/EventDetailsPage.tsx
git commit -m "feat(currency): let all events pick a display currency (un-gate from external-only)"
```

---

## Task 6: Dashboard — thread event currency through organizer + accounting displays

**Files (modify — replace each hardcoded `E`/`formatCurrency(x)` with the event-currency-aware call):**
- `src/pages/DashboardPage.tsx:91`
- `src/pages/EventsPage.tsx:246`
- `src/pages/EventDetailsPage.tsx:685,854,876`
- `src/pages/TicketSalesPage.tsx:128,226,237`
- `src/pages/SalesHistoryPage.tsx:211`
- `src/pages/FeesPage.tsx:14,148,164`
- `src/pages/OrganizerPayoutsPage.tsx:126,133,140,147`
- `src/pages/HubDetailPage.tsx:98`
- `src/pages/ResellerDetailPage.tsx:480,654,703`
- `src/pages/reseller/ResellerPosPage.tsx:518,657,665,701`
- `src/pages/reseller/ResellerPayoutsPage.tsx`, `ResellerSalesHistoryPage.tsx`, `ResellerReportsPage.tsx`, `ResellerHubDetailPage.tsx:100`
- `src/components/EventCreatorTab.tsx:106,145`
- `src/components/TicketSuccessDialog.tsx:122`
- `src/lib/ticketReceipt.ts:111,112,183`
- `formatCurrency` consumers: `AnalyticsPage`, `OrganizersPage`, `UsersPage`, `EventAnalyticsTab`, `DashboardPage`

**Transform rule (apply per site):**
- A site rendering **one event's** money → `formatMoney(x, ev.currency)` (or `formatMoney(x, ev.currency, { space: true, decimals: 0 })` where the old code used `formatCurrency`/`E `). The event object is in scope on these pages; if a list row, use that row's `event.currency` / `sale.currency`.
- A **cross-event aggregate** (platform-wide total over mixed events, e.g. AnalyticsPage/OrganizersPage/UsersPage totals) → leave `formatCurrency(x)` with the **default `'SZL'`** (base `E`). Do NOT stamp a per-event symbol on a mixed sum (Global Constraint).
- Receipts/tickets (`ticketReceipt.ts`, `TicketSuccessDialog`) → use the **sale/ticket snapshot** `sale.currency` (Task 2), not a live event lookup.

**Interfaces:**
- Consumes: `formatMoney`, `formatMoneyRange`, `formatCurrency(value, currency)` (Tasks 2-3).

- [ ] **Step 1: Confirm the currency is available at each site**

For each file above, verify the event/sale object with `currency` is already in scope (it is on these pages — they load the event or the sale). Where a component receives only a bare amount as a prop, thread a `currency` prop from its parent (which has the event). List any site where currency is genuinely unavailable and treat it as an aggregate (base `E`).

- [ ] **Step 2: Apply the transform (representative diffs)**

```tsx
// before  (dashboard/src/pages/EventDetailsPage.tsx:685-ish)
<span>E {sale.totalAmount}</span>
// after
<span>{formatMoney(sale.totalAmount, sale.currency ?? event.currency)}</span>
```

```tsx
// before  (a formatCurrency consumer showing ONE event's revenue)
<div>{formatCurrency(event.totalRevenue)}</div>
// after
<div>{formatCurrency(event.totalRevenue, event.currency)}</div>
```

```ts
// before  (dashboard/src/lib/ticketReceipt.ts:111)
`E${line.price}`
// after   (import formatMoney from '@/lib/currency')
formatMoney(line.price, sale.currency ?? 'SZL')
```

Work file-by-file; add the `import { formatMoney } from '@/lib/currency'` where needed.

- [ ] **Step 3: Surface settlement currency in reconciliation (super-admin fees / sales history)**

Where a finance/reconciliation view shows what was actually charged (e.g. `SalesHistoryPage`, the super-admin fees view), when `sale.settlementCurrency` is present and differs from `sale.currency`, show the settled figure with `formatMoney(sale.amountCharged ?? sale.totalAmount, sale.settlementCurrency)` alongside the display figure. Organizer/buyer-facing figures keep `sale.currency`.

- [ ] **Step 4: Build & grep-verify no stray hardcoded symbols remain**

Run: `cd dashboard && npm run build`
Expected: clean (no missing-arg errors from the Task 3 `formatCurrency` signature).
Run: `grep -rn "E \${" src/ ; grep -rn "\`E\${" src/` — Expected: only intentional base-`E` aggregate sites remain; no per-event site still hardcodes `E`.

- [ ] **Step 5: Commit**

```bash
cd dashboard && git add src/
git commit -m "feat(currency): render organizer + accounting prices in each event's currency"
```

---

## Task 7: Landing — thread event currency through buyer displays

**Files (modify):**
- `src/components/EventCard.tsx:110-111` (Carrot branch — the external branch already uses `currencySymbol`)
- `src/components/PurchaseModal.tsx:426,432,438,628-633` (subtotal, service fee, total, "Pay …" buttons)
- `src/components/PrintableTicket.tsx:59`
- `src/components/discover/DiscoverGrid.tsx:42`
- `src/pages/CalendarPage.tsx:21`
- Any remaining `formatAdmissionPrice(...)` caller (now needs the `currency` arg — grep for it)

**Transform rule:**
- Every Carrot-branch price → `formatMoney(x, event.currency)` / `formatMoneyRange(min, max, event.currency)`. The event is in scope on all these components/pages (each renders a specific event).
- `PurchaseModal` totals use the event being purchased → `event.currency`. The printed ticket uses the sale/ticket snapshot currency if available, else `event.currency`.

**Interfaces:**
- Consumes: `formatMoney`, `formatMoneyRange`, `formatAdmissionPrice(range, currency)` (Task 4).

- [ ] **Step 1: Fix `formatAdmissionPrice` callers**

Grep `cd landing && grep -rn "formatAdmissionPrice" src/`. At each caller, pass the event's currency: `formatAdmissionPrice(ev.priceRange, ev.currency)`.

- [ ] **Step 2: Apply the transform (representative diffs)**

```tsx
// before  (landing/src/components/EventCard.tsx:110-111, Carrot branch)
<span>E{minPrice}</span>
// after   (import { formatMoney } from '@/lib/currency')
<span>{formatMoney(minPrice, event.currency)}</span>
```

```tsx
// before  (landing/src/components/PurchaseModal.tsx:628-633)
<button>Pay E{total}</button>
// after
<button>Pay {formatMoney(total, event.currency)}</button>
```

```tsx
// before  (landing/src/pages/CalendarPage.tsx:21)
`E${min}–E${max}`
// after
formatMoneyRange(min, max, ev.currency)
```

- [ ] **Step 3: Build & grep-verify**

Run: `cd landing && npm run build`
Expected: clean (this repo's Pages build; `tsc -b`).
Run: `cd landing && grep -rn "E\${" src/ ; grep -rn "E {" src/` — Expected: no Carrot-branch price still hardcodes `E`.

- [ ] **Step 4: Commit**

```bash
cd landing && git add src/
git commit -m "feat(currency): render buyer-facing prices in the event's currency"
```

---

## Task 8: POS (Flutter) — currency-aware receipts  *(written, NOT built)*

**Files:**
- Modify: `pos-app/lib/printer.dart:46-47` and its call site `:162`
- Modify: `pos-app/lib/pages/pos_page.dart:49-50` and its call sites `:662,768,880`

**Note:** The POS has zero currency awareness today (both `_money` helpers hardcode `'E '`). Per the workspace rule, **do not run `flutter build`/`flutter run`** — write the Dart and stop. On-device verification waits for an explicit build request.

- [ ] **Step 1: Find where the event/sale currency is available to the POS**

Run: `cd pos-app && grep -rn "totalAmount\|class .*Sale\|class .*Event\|fromJson" lib/ | head -40`. Identify the model/object behind `sale`, `t` (ticket), and `_total` and whether it carries `currency` from the API JSON (the API now returns `event.currency` and `sale.currency`). Add a `currency` field (default `'SZL'`) to the relevant Dart model's `fromJson` if missing.

- [ ] **Step 2: Make `_money` currency-aware (both files, identical change)**

```dart
String _money(num v, [String currency = 'SZL']) {
  final sym = currency == 'ZAR' ? 'R' : 'E';
  final n = v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2);
  return '$sym $n';
}
```

- [ ] **Step 3: Pass currency at each call site**

- `printer.dart:162` → `_money(sale.totalAmount, sale.currency)`
- `pos_page.dart:662` → `_money(t.price, t.currency ?? _event?.currency ?? 'SZL')`
- `pos_page.dart:768` → `_money(_total, _event?.currency ?? 'SZL')`
- `pos_page.dart:880` → `_money(s.totalAmount, s.currency ?? 'SZL')`

(Use the actual field names discovered in Step 1; the default `'SZL'` is the permitted legacy-doc fallback.)

- [ ] **Step 4: Static-analyze only (no build)**

Run: `cd pos-app && flutter analyze lib/printer.dart lib/pages/pos_page.dart`
Expected: no new errors. Do NOT run `flutter build`.

- [ ] **Step 5: Commit**

```bash
cd pos-app && git add lib/printer.dart lib/pages/pos_page.dart
git commit -m "feat(currency): POS receipts render event currency (E/R) — not yet built"
```

---

## Task 9: End-to-end verification (manual, dev)

- [ ] **Step 1:** In the dashboard dev build, create a **Carrot-sold** event with **Currency = R (ZAR)** and a ticket tier priced 100. Save. Reopen the event — the currency shows `R (ZAR)` and tier prices render `R100`.
- [ ] **Step 2:** On landing (dev), open that event — the card, admission figure, and checkout all show `R`; the pay button reads `Pay R…`.
- [ ] **Step 3:** Complete a dev purchase by MoMo. Confirm the ticket/receipt shows `R`, and in the DB the `TicketSale` has `currency: 'ZAR'` and `settlementCurrency: 'SZL'` (display R, settled E at par).
- [ ] **Step 4:** Complete a dev purchase by card. Confirm `settlementCurrency: 'ZAR'`.
- [ ] **Step 5:** In organizer sales/fees pages, the event's rows show `R`; a cross-event platform total still shows `E`.
- [ ] **Step 6:** Create a second event with the default (E/SZL) and confirm nothing regressed — everything still shows `E`.

No commit — this task is a gate before rollout.

---

## Rollout (after all tasks reviewed & merged)

Deploy order, per the spec and workspace conventions:
1. **api** — `cd api && gcloud run deploy carrot-tickets-api --source .` (env preserved by `--source`). Verify with `--format=json` (not `traffic[0].percent`).
2. **dashboard** + **landing** — Cloudflare Pages per each repo's deploy convention (`main`/`master` push or direct-upload). No DB migration.
3. **pos-app** — deferred; build only on explicit request.

---

## Self-Review (completed by plan author)

- **Spec coverage:** Data model + snapshots → Task 2. Un-gate picker → Task 5. Display threading (buyer) → Tasks 4,7; (organizer/accounting) → Tasks 3,6. Settlement recording → Tasks 1,2; surfacing → Task 6 Step 3. POS → Task 8. Aggregate rule → Task 6 Step 2 + Global Constraints. Payments-frozen → respected (no gateway/guard tasks). Cashless/transport out-of-scope → not touched.
- **Placeholder scan:** the only discovery step is Task 8 Step 1 (POS model shape), bounded and explicit — not a deferred TODO.
- **Type consistency:** `EventCurrency`/`Currency` (`'SZL'|'ZAR'`) and `formatMoney`/`formatMoneyRange`/`formatCurrency(value, currency)`/`buildPricePayload`/`formatAdmissionPrice(range, currency)`/`settlementCurrencyForMethod` are named identically across every referencing task.
