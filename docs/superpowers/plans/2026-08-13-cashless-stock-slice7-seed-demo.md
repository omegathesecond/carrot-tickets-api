# Cashless Stock — Slice 7: Seed & Demo Data Implementation Plan

> **For agentic workers:** implement in one task; steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend `seedCashlessDemo.ts` to idempotently seed a realistic stock story (catalogue, per-bar stock, transfer, itemised + amount-only sales with staffName, opening/closing counts with variance) on the existing demo cashless event, via the real services.

**Spec:** `docs/superpowers/specs/2026-08-13-cashless-stock-slice7-seed-demo-design.md`

## Global Constraints

- **Base:** `feat/cashless-cashier` (worktree `api-stock-seed-wt`); FF-merge back.
- **Idempotent** (safe to re-run): products find-or-create; receive/transfer/count guarded by existence checks; charges/top-ups via fixed `clientTxnId`.
- **Real services only** — no hand-built documents. `MerchantService.charge` needs a funded band → `WalletService.topUpCash` an existing event wallet; if none exists, warn + skip sales (never fabricate a balance).
- **Not auto-run against dev** — commit + typecheck; hand the run command to the user.

---

### Task 1: `seedStock()` in `seedCashlessDemo.ts`

**Files:** Modify `src/scripts/seedCashlessDemo.ts`.

**Interfaces consumed (verified signatures):**
- `StockService.applyMovement({ eventId, merchantId, productId, delta, reason, byType:'Organizer', by, refType?, refId?, note? }) -> { onHand, movement }`
- `StockTransferService.transfer({ eventId, productId, fromMerchantId, toMerchantId, qty, byType:'Organizer', by, note? }) -> { transfer, fromOnHand, toOnHand }`
- `StockCountService.recordCount({ eventId, merchantId, productId, countedOnHand, phase, byType:'Organizer', by }) -> { count, onHand }`
- `MerchantService.charge({ merchantId, eventId, walletId, bandUid, clientTxnId, items?:[{productId,qty}], amount?, staffName? }) -> { wallet, charge }` (amount XOR items)
- `WalletService.topUpCash({ walletId, eventId, amount, recordedBy, recordedByType:'Cashier', clientTxnId }) -> { wallet, topup }`
- Models `Product`, `ProductStock`, `Merchant`, `StockTransfer`, `StockCount`, `Wallet`; enums `ProductCategory`, `StockMovementReason`.

- [ ] **Step 1:** Add imports (models/services/enums above) to the script.

- [ ] **Step 2: bars** — `Merchant.find({ eventId })`; if `< 2`, create `Main Bar` / `VIP Bar` (find-or-create by `(eventId, name)`, stable `loginCode` `'701001'`/`'701002'`, `pin:'000000'`). Return the two bar ids.

- [ ] **Step 3: catalogue** — a `PRODUCTS` array (name, category, priceCents, barcode?, unitsPerPack?, packLabel?); for each, `Product.findOne({ eventId, name })` else `Product.create`. Collect a `bySku` map.

- [ ] **Step 4: opening stock (guarded)** — per (bar, product) in an opening-load table: if `await ProductStock.exists({ merchantId, productId })` → skip (already loaded); else `applyMovement({ delta, reason: RECEIVE, refType:'seed', refId:'seed-open-<bar>-<sku>', byType:'Organizer', by })`. Backdate the movement `at` to just before `event.startTime` so it reads as Opening (a `StockMovement.updateOne` on the returned movement id — only touches `at`).

- [ ] **Step 5: thresholds** — `ProductStock.updateOne({ merchantId, productId }, { $set:{ lowStockThreshold } })` on one or two fast movers.

- [ ] **Step 6: transfer (guarded)** — if no `StockTransfer.exists({ eventId, productId: castleId, fromMerchantId: mainBar, toMerchantId: vipBar })` → `StockTransferService.transfer({ ..., qty: 24 })`.

- [ ] **Step 7: sales (best-effort)** — `Wallet.find({ eventId, bandUid: { $ne: null } }).limit(2)`. If none → `console.warn('no band-wallet to sell to; skipping demo sales')` and skip. Else for each chosen wallet: `topUpCash({ amount: 20000, recordedBy: cashierId, recordedByType:'Cashier', clientTxnId:'seed-topup-<n>' })` (idempotent), then a few `charge()`:
  - itemised: `charge({ merchantId: mainBar, walletId, bandUid, clientTxnId:'seed-sale-1', items:[{productId: castleId, qty:2}], staffName:'Thandi' })`, etc.
  - amount-only: `charge({ merchantId: mainBar, walletId, bandUid, clientTxnId:'seed-sale-amt', amount: 1500, staffName:'Sipho' })`.
  Wrap each charge in try/catch → on a decline/insufficient-balance just log and continue (don't fail the whole seed).

- [ ] **Step 8: counts (guarded)** — `opening` count == the loaded qty (matches; variance 0) and a `closing` count on one bar-product a few units short (visible negative variance). Each guarded by `StockCount.exists({ eventId, merchantId, productId, phase })`.

- [ ] **Step 9:** Call `seedStock(event, { vendorId, cashierId })` from `main()` after the cashier block; add a summary log.

- [ ] **Step 10:** `npx tsc -b` (or `npx tsc --noEmit`) — the script compiles against the real signatures. Review each mutating step's guard for re-run safety.

- [ ] **Step 11: commit** `feat(cashless-stock): seed demo stock (catalogue/stock/sales/counts) (Slice 7)`; FF-merge onto `feat/cashless-cashier`. Hand the user the run command:
  `MONGODB_URI='<dev uri>' npm run seed:cashless`

## Self-Review checklist

- **Spec coverage:** catalogue, bars, opening stock, thresholds, transfer, itemised+amount sales w/ staffName, opening+closing counts w/ variance. ✅
- **Idempotent:** find-or-create products; existence-guarded receive/transfer/count; fixed clientTxnId charges/top-ups. ✅
- **Real services / invariants intact; no fabricated wallet balance; sales best-effort.** ✅
- **Typechecks; not auto-run against dev.** ✅
