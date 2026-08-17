# Cashless Stock — Slice 7: Seed & Demo Data (Design)

**Date:** 2026-08-13
**Status:** Design — awaiting review
**Branch (base):** api `feat/cashless-cashier` (@869a733). FF-merge back onto the cashless line, not `main`.
**Repos:** `api` only (a seed script). Runs against the **dev** database.
**Builds on:** the whole stock stack (Slices 1-4) + the existing `src/scripts/seedCashlessDemo.ts` (`npm run seed:cashless`), which today enriches the demo event with a cashier + sample cash-outs.

---

## 1. Why / scope

The stock backend, POS, and dashboard are built but there's no demo data — a fresh dev event shows empty boards and blank reports. Slice 7 (the last) extends `seedCashlessDemo.ts` so one command populates a realistic stock story on the existing demo cashless event, exercising every surface: the live board, reconciliation, the event dashboard (revenue-by-product, best-sellers, sales-by-bar/till, peak times, itemised split, variances), and the POS tile grid.

**In scope (api only):** extend `seedCashlessDemo.ts` to also seed, **idempotently**, on the existing demo event:
- a **product catalogue** (find-or-create): a spread of categories with barcodes, prices, and pack sizes;
- **≥2 bars** (Merchants) — find-or-create;
- **per-bar opening stock** (receive movements);
- a couple of **low-stock thresholds**;
- one **bar→bar transfer**;
- a few **itemised sales** + one **amount-only sale**, each with a `staffName`, on funded bands;
- an **opening count** and a **closing count with a deliberate non-zero variance** (so reconciliation shows shrinkage).

**Out of scope:** creating the base demo event/reseller/gate (those pre-exist — the script enriches); any schema/API change; deploying; a brand-new funded-band-from-scratch flow (reuse/top-up existing bands).

## 2. Decisions

| # | Decision | Choice |
|---|----------|--------|
| A | Use the real services | Everything goes through `StockService.applyMovement`, `MerchantService.charge`, `StockTransferService.transfer`, `StockCountService.recordCount`, `WalletService.topUpCash` — so the demo data satisfies every invariant (`onHand == Σ deltas`, money ledger sums-to-zero, itemised charges deduct stock) and exercises the real code paths. No hand-built documents. |
| B | Idempotency | **Safe to re-run** (matches the existing script). Products: find-or-create by `(eventId, name)`. Receive: skip a bar-product that already has a `ProductStock` row. Transfer: skip if a matching `StockTransfer` exists. Counts: skip if a `StockCount` for that `(merchant, product, phase)` exists — so a re-run never zeroes out the demo's variance. Charges/top-ups: idempotent via fixed `clientTxnId`s (service-level). |
| C | Sales are best-effort | Itemised/amount-only charges need a funded band. The script **tops up** a couple of existing event band-wallets (`topUpCash`, idempotent) then charges them; if the demo event has **no** band-wallets at all, it logs a loud warning and **skips only the sales** (catalogue + stock + counts still populate the board + reconciliation). Never fabricate a wallet balance (would break the ledger invariant). |
| D | Bars | Find existing event Merchants; if fewer than 2, create demo bars (`Main Bar`, `VIP Bar`) with stable login codes + PIN, so transfers + per-bar reports have ≥2 bars. |
| E | Not auto-run against dev | The script is committed + typechecked; **running it mutates shared dev data**, so it is run explicitly (`MONGODB_URI='<dev>' npm run seed:cashless`) — not executed unprompted as part of this slice. |

## 3. What it seeds (the demo story)

- **Catalogue (~7 products):** Castle Lite (beer, barcode, R25, 24/case), Heineken (beer, barcode, R30, 24/case), Savanna (wine/cider, barcode, R35), Coca-Cola (soft_drink, barcode, R18), Still Water (water, R15), Red Bull (soft_drink, barcode, R28), Ice (other, R20, no barcode).
- **Opening stock:** each bar receives a realistic opening load (e.g. Main Bar 120 Castle, 80 Heineken, …; VIP Bar smaller) via `receive` — recorded before/at the doors-open marker so reconciliation's Opening column is meaningful.
- **Thresholds:** a low threshold on one or two fast movers so the board can show LOW.
- **Transfer:** move some Castle Lite from Main Bar → VIP Bar.
- **Sales:** 3-4 itemised charges (mixed products/qty, `staffName` of "Thandi"/"Sipho") + 1 amount-only charge — so revenue-by-product, best-sellers, sales-by-till, itemised split, and `sale`-movement peak times all populate. (Best-effort per decision C.)
- **Counts:** an `opening` count matching the load, and a `closing` count on one bar-product a few units short → a visible negative variance (shrinkage) in reconciliation + the dashboard.

## 4. Shape

One new `async function seedStock(event, { vendorId, cashierId })` added to `seedCashlessDemo.ts`, called from `main()` after the cashier setup, before the final log. Logs each step (`📦 catalogue`, `📥 received`, `🔁 transfer`, `🛒 sale`, `🔢 count`) and a summary. All imports are existing models/services. `MONGODB_URI` points at dev.

## 5. Testing / verification

- **`npx tsc -b` / typecheck** the script compiles against the real service signatures.
- **Idempotency review:** every mutating step is guarded (decision B) so a second run is a no-op on quantities and preserves the variance.
- **Not run here** against dev (decision E) — the run command is handed to the user. A future dev run is the real end-to-end check (the reports/dashboard/POS then show the seeded story).

## 6. Delivery

- Extend `seedCashlessDemo.ts` on `feat/cashless-cashier` (fresh worktree), FF-merge back. Not deployed. After this, the whole cashless stock system (Slices 1-7) is complete and ready to deploy together (api `--source`, pos EAS, dashboard CF Pages).
- **Fail loud:** a missing demo event still throws (as today); a missing funded band warns + skips sales (never fabricates balance); every real service enforces its own invariants.

## 7. Open questions / carry-forward

- The demo event must exist on dev (`Cashless NFC Tap Test Fest`) — the script enriches, it doesn't create it (unchanged from today).
- Sales depend on the demo event having ≥1 band-wallet; if the base demo has none, the operator tops one up first (or the script's warning points them there).
- Carry-forward from Slices 1-6 unchanged (receive/transfer not client-idempotent at the API — the seed guards its own re-runs).
