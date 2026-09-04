# Cashless Stock — Slice 5: POS Basket UI (Design)

**Date:** 2026-08-13
**Status:** Design — awaiting review
**Branches (base):** api `feat/cashless-cashier` (@27e8e09, Slices 1-4 merged) → small endpoint change on `feat/cashless-stock-posfeed` (worktree `api-stock-posfeed-wt`); pos-app `feat/cashless-pos-cashier` (@fac39a3) → `feat/cashless-pos-stock` (worktree `pos-app-stock-wt`). Both FF-merge back onto their cashless lines, not `main`.
**Repos:** `api` (one enriched endpoint) + `pos-app` (Flutter handheld — the bulk).
**Builds on:** parent design `2026-08-12-cashless-stock-management-design.md` §8 (POS app) + Slice 2 (`POST /merchant/charge` accepts `items`/`staffName`, amount XOR items, server-priced) + Slice 3 (`GET /merchant/stock`, `POST /merchant/stock/count`). The existing cashier POS `ChargePage` (amount-only keypad + NFC tap) is what this transforms.

---

## 1. Why / scope

Slices 1-4 built the whole stock backend; the handheld still charges **amount-only**. Slice 5 turns the Charge tab into a **basket POS** so a bartender scans/taps products into a basket and settles the whole round with one band-tap — the charge is itemised, so stock auto-decrements and the organiser's Slice-4 reports light up. Per the user (2026-08-13): **full slice, one branch**; **client-side scan resolution**.

**In scope:**
- **api (small):** enrich `GET /api/merchant/stock` to carry `price`, `barcode`, `category`, `imageUrl`, `unitsPerPack`, `packLabel`, and a computed `status` — so ONE endpoint drives the tile grid, client-side scan match, and the stock-take screen (no new `GET /merchant/products` endpoint; deviates from parent §8, called out below).
- **pos-app:**
  - `MerchantApi`: `charge()` grows optional `items` + `staffName`; new `stock()` (the enriched list) and `submitCount()`; a `StockProduct` model.
  - A pure-Dart **`Basket`** model (lines, add/inc/dec/remove, running total from client prices, clear) — unit-tested.
  - **Charge tab → basket POS:** product-tile grid + barcode scan (`mobile_scanner`, matched locally) + basket panel with running total + single band-tap to settle. Amount-only keypad preserved as a **mode toggle** (backend is amount XOR items).
  - **"Who's on this till?"** optional `staffName`, captured once per shift, shown as a header chip, sent with each charge.
  - **Stock-take screen** on a new **Stock** tab: list this bar's products, enter counts, submit → see variance.

**Out of scope:** dashboard Stock UI (Slice 6); seed/demo (Slice 7); offline queueing of charges (the charge stays online + idempotent as today); editing the catalogue from the POS (organiser-only, dashboard). Running the Flutter app / building an APK is **not** done here (verify by `flutter analyze` + `flutter test` on the pure-Dart `Basket` model only).

## 2. Locked decisions (parent) + Slice-5 decisions

Parent locks: POS = scan (`mobile_scanner` reads EAN/UPC) + product tiles; oversell = HARD BLOCK (server 409); amount-only kept but flagged; per-employee via optional `staffName` per till (no new auth); sales in base units.

| # | Decision | Choice |
|---|----------|--------|
| A | Product data source | **Enrich `GET /api/merchant/stock`** (not a new `GET /merchant/products`). One fetch returns the bar's catalogue+stock; tiles, scan-match and stock-take all read it. DRY; fewer endpoints. Deviates from parent §8's two-endpoint plan — called out. |
| B | Scan resolution | **Client-side.** The POS holds the fetched `stock()` list and matches a scanned EAN/UPC against `product.barcode` locally — instant, resilient to venue wifi, no per-scan round-trip. Unknown barcode → a "not in catalogue" toast + offer the amount-only keypad (never silently no-op). |
| C | Pricing authority | **Server prices the charge** (Slice 2 unchanged): the POS sends `items:[{productId, qty}]`, the server computes `amount` from the catalogue. The client-side running total (from `stock().price`) is **display only** — labelled as such is unnecessary, but the settle never trusts it. |
| D | Amount XOR items | The backend rejects a charge carrying both. So the POS has **two modes**: *Basket* (items) is the default; an **"Enter amount" toggle** switches to the legacy keypad amount-only charge (parent decision #5 — amount-only preserved for un-catalogued items). Switching modes clears the other's state. |
| E | Oversell | **Never blocked client-side by stale stock.** A tile at `onHand 0` shows **SOLD OUT** and is not tappable, but the authority is the server: a race that empties stock between fetch and tap returns **409** `{reason:'out_of_stock', productId, available}`, surfaced as "Out of stock: <name>" with the basket kept so the operator can adjust. Nothing is charged (server rolled back). |
| F | staffName | Optional, **per shift**, held in POS memory (not persisted to `Session`/disk — a till hand-off is a fresh prompt, and we never store a person's name on the device longer than the shift). Prompted once on first entering the basket (skippable); a header chip shows "Till: <name>" / "Set till" and reopens the prompt. Sent with every charge (basket and amount-only). |
| G | Basket state | Local widget state (the app has no state-mgmt lib; mirrors `ChargePage`'s existing `setState`). The `Basket` is a plain Dart model the widget holds and mutates via `setState`. Lines keyed by `productId`; qty≥1; a second scan/tap of the same product increments. |
| H | Stock-take placement | A **third tab** on `MerchantShell` (Charge · Takings · **Stock**), reusing the existing `IndexedStack` so counts-in-progress survive tab hops. Reuses `GET /merchant/stock` (now enriched) for the list and `POST /merchant/stock/count` (Slice 3) to submit. |

## 3. API change — enriched `GET /api/merchant/stock`

`MerchantController.stock` (api `src/controllers/merchant.controller.ts`) today returns `{ productId, name, unitLabel, onHand, lowStockThreshold }`. Add the fields the POS needs, computed from the `Product` docs it already loads:

```jsonc
// GET /api/merchant/stock  ->  { stock: StockRow[] }
{
  "productId": "…", "name": "Castle Lite 330ml",
  "price": 2500,                 // NEW — integer ZAR cents, per base unit
  "barcode": "6001240100015",   // NEW — string | null (client-side scan match key)
  "category": "beer",           // NEW
  "imageUrl": null,             // NEW — string | null (tile image)
  "unitLabel": "unit",
  "unitsPerPack": 24,           // NEW — number | null (display only)
  "packLabel": "case",          // NEW — string | null
  "onHand": 63,
  "lowStockThreshold": 20,      // number | null
  "status": "in_stock"          // NEW — 'in_stock' | 'low' | 'sold_out' (same rule as Slice-4 board)
}
```

`status`: `onHand <= 0` → `sold_out`; else `lowStockThreshold != null && lowStockThreshold > 0 && onHand <= lowStockThreshold` → `low`; else `in_stock`. Still `Product.find({ eventId, active: true })` joined to this bar's `ProductStock` — additive fields only; the Slice-3 stock-take screen keeps working unchanged. Money/stock untouched (read-only endpoint).

## 4. POS — API client + Basket model (`pos-app`)

### 4.1 `MerchantApi` (`lib/api.dart`)
- **`charge()`** grows optional `List<BasketLine>? items` and `String? staffName`. Body becomes `{ bandUid, clientTxnId, amount? , items?: [{productId, qty}], staffName? }` — send `amount` XOR `items`. Success parsing unchanged (`newBalance/fee/merchantNet`), plus optional `items` echoed back (priced) for the receipt. **New:** a `409` is a stock decline → return `ChargeResult.declined` with `reason:'out_of_stock'`, `productId`, `available` (extend `ChargeResult` with nullable `reason`/`outOfStockProductId`/`available`, distinct from the 402 balance decline).
- **`stock()`** → `GET /merchant/stock` → `List<StockProduct>` (the §3 shape).
- **`submitCount({ productId, countedOnHand, phase })`** → `POST /merchant/stock/count` → `CountResult { expectedOnHand, countedOnHand, variance, onHand }`.

### 4.2 Models
- **`StockProduct`** — `{ productId, name, price (cents), barcode?, category, imageUrl?, unitLabel, unitsPerPack?, packLabel?, onHand, lowStockThreshold?, status }` with `bool get soldOut => status == 'sold_out'`.
- **`BasketLine`** — `{ StockProduct product, int qty }`; `int get lineTotal => product.price * qty`; `toJson() => { 'productId': product.productId, 'qty': qty }`.
- **`Basket`** (pure Dart, `lib/pages/cashless/basket.dart`) — `List<BasketLine> lines`; `add(product)` (inc if present, else qty 1), `increment(productId)`, `decrement(productId)` (removes at 0), `remove(productId)`, `clear()`; `int get totalCents => Σ lineTotal`; `int get count => Σ qty`; `bool get isEmpty`. No I/O; unit-tested.

## 5. POS UI — basket POS Charge tab

`ChargePage` becomes two modes behind the existing coral/cream cashless theme:

**Basket mode (default):**
- On first build, `MerchantApi.stock()` loads the catalogue (loading/empty/error states; a load failure shows a retry, never a blank grid).
- **Product tiles** — a scrollable grid of the bar's `active` products: name, price (`fmtCents`), a small `onHand`/status badge; `sold_out` tiles are dimmed + non-tappable ("SOLD OUT"). Tap adds to the basket (increments on re-tap).
- **Scan** — an app-bar scan icon opens a `mobile_scanner` sheet; on a barcode, match `rawValue` against `stock` by `barcode`: hit → add + haptic + keep scanning; miss → "Not in catalogue" toast. (Reuses the `scan_page.dart` MobileScanner pattern.)
- **Basket panel** — the lines with qty steppers (±) and remove; a running **total** (`Basket.totalCents`, display-only). Empty basket ⇒ settle disabled.
- **Settle** — the existing `CashlessTapButton` ("Charge R{total} — tap band"): reads the band (existing `TagReader.readUid`), then `charge(bandUid, items: basket.lines, staffName, clientTxnId)`. Success → the existing result view, now itemised (list `result.items` + new balance); **409** → "Out of stock: <name>" banner, basket kept; **402** → the existing decline view. On success, "New sale" clears the basket.

**Amount mode (toggle):** the current keypad + amount-only `charge(amount, staffName)` flow, unchanged except it now also sends `staffName`. Toggling modes clears the other's state.

**staffName:** a header chip "Till: <name>" / "Set till"; tapping opens a small text prompt (decision F). Held in `_ChargePageState` (memory only); passed to both charge calls.

## 6. POS UI — stock-take screen (Stock tab)

New `MerchantStockPage` on `MerchantShell` (third `IndexedStack` tab, `Icons.inventory_2_outlined`):
- Loads `MerchantApi.stock()` (reuses the enriched list); each row: product name, current `onHand`, a number field for the counted quantity, and a per-row **Submit** (or a batch submit) → `submitCount({ productId, countedOnHand, phase:'interim' })`.
- On submit, show the returned **variance** inline ("−3" in error red, "0" muted, "+2" success) and refresh that row's `onHand`. Loading/empty/error states as the Charge tab.
- `phase` defaults `interim` (an opening/closing count is an organiser action on the dashboard, Slice 6).

## 7. Testing

- **api:** extend the existing `MerchantController.stock` route test — assert the new fields (`price`, `barcode`, `category`, `status`) and the `status` rule (`sold_out` at 0, `low` at/below threshold, `in_stock` above; a barcodeless product → `barcode:null`). Run the merchant-stock suite (`--maxWorkers=4` for the full suite; remember the documented replica-set flake — re-run failures isolated).
- **pos-app (pure Dart, `flutter test`):** `Basket` — add creates a qty-1 line; re-add increments; decrement to 0 removes; `remove`/`clear`; `totalCents` = Σ price×qty; `count` = Σ qty. (These are logic tests; no widget rendering / no app run / no APK.)
- **pos-app static:** `flutter analyze` clean on the changed files.
- **Not run here** (per the standing rule): launching the app, on-device NFC/scan, APK build. On-device tap remains unverified (carry-forward, as with Slice 1 POS).

## 8. Delivery

- api change on `feat/cashless-stock-posfeed` (worktree `api-stock-posfeed-wt`) off `feat/cashless-cashier`; FF-merge back. pos change on `feat/cashless-pos-stock` (worktree `pos-app-stock-wt`) off `feat/cashless-pos-cashier`; FF-merge back. Neither deployed (whole cashless system ships together).
- **Fail loudly:** unknown scan → toast (never silent add of a wrong/zero item); load failure → retry state (never a blank/fake grid); 402/409 declines are surfaced distinctly; the client running total never overrides the server-priced charge.

## 9. Open questions / carry-forward

- **Custom-priced amount line inside a basket** — not possible (backend is amount XOR items); the amount-mode toggle covers un-catalogued items as a separate charge. If the client later wants "3 beers + R20 misc" on one tap, that's a backend change (allow amount + items), deferred.
- **On-device verification** — scan/NFC/tile-tap on the real ZCS handheld is unverified until the app is run on device (out of scope here).
- **Barcode collisions / no-barcode products** — tiles cover barcodeless products (food/ice); only barcoded products are scan-resolvable. Fine.
- Carry-forward from Slices 1-4 unchanged (receive/transfer not client-idempotent; etc.).
