# Cashless Stock — Slice 5: POS Basket UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the cashier handheld's Charge tab into a basket POS — scan/tap products into a basket, settle the whole round with one band-tap (itemised, server-priced, stock auto-deducting) — plus a per-shift `staffName` and a stock-take screen; backed by one enriched merchant endpoint.

**Architecture:** Small api change (enrich `GET /merchant/stock` with price/barcode/category/status) + Flutter: a pure-Dart `Basket` model, `MerchantApi` gains `stock()`/`submitCount()` and `charge(items,staffName)`, `ChargePage` becomes a two-mode (basket ⇄ amount) POS, and `MerchantShell` gains a Stock tab. Client-side barcode match against the fetched stock list.

**Tech Stack:** api — Node/TS, Express, Mongoose, Jest. pos-app — Flutter/Dart, `http`, `mobile_scanner ^5.2.3`, `nfc_manager ^4.0.2`, no state-mgmt lib (local `setState`), `flutter test` for pure-Dart logic.

**Spec:** `docs/superpowers/specs/2026-08-13-cashless-stock-slice5-pos-basket-design.md`

## Global Constraints

- **api base:** `feat/cashless-stock-posfeed` off `feat/cashless-cashier` (worktree `api-stock-posfeed-wt`); FF-merge back. **pos base:** `feat/cashless-pos-stock` off `feat/cashless-pos-cashier` (worktree `pos-app-stock-wt`); FF-merge back. Neither onto `main`.
- **Server prices the charge.** POS sends `items:[{productId,qty}]`; server computes the amount. The client running total is display-only and must never be sent as `amount` when items exist (backend rejects amount+items).
- **Amount XOR items** — the two POS modes are mutually exclusive; switching clears the other's state.
- **Fail loudly** (workspace rule): unknown scan → toast, never a silent/zero add; stock load failure → retry state, never a blank/fake grid; 402 (balance) and 409 (out_of_stock) declines surfaced distinctly; charge stays idempotent on a fresh `clientTxnId` per attempt.
- **Do NOT run the Flutter app or build an APK** (standing user rule). Verify pos-app with `flutter analyze` + `flutter test` on the `Basket` model only. Money is integer ZAR cents; stock integer base units.
- **Full api suite flakes** under `--maxWorkers=4` (replica-set hook timeouts, non-deterministic unrelated suites) — re-run any failed suite isolated to confirm.

---

### Task 1 (api): enrich `GET /api/merchant/stock`

**Files:**
- Modify: `src/controllers/merchant.controller.ts` (the `stock` method, ~line 129)
- Test: `src/routes/__tests__/merchantStock.route.test.ts` (existing Slice-3 test — extend; if absent, add)

**Interfaces:**
- Produces: `GET /merchant/stock` rows gain `price`, `barcode`, `category`, `imageUrl`, `unitsPerPack`, `packLabel`, `status` ('in_stock'|'low'|'sold_out').

- [ ] **Step 1: Write/extend the failing route test**

```typescript
// asserts the enriched shape + status rule (add to the Slice-3 merchant stock test)
it('returns enriched product fields + status', async () => {
  const { token, eventId } = await ownedMerchantSession(); // existing helper: a merchant JWT + its event
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500, barcode: '6001240100015', unitsPerPack: 24, packLabel: 'case' } as any);
  const merchantId = /* merchant from the session */ ;
  await ProductStock.create({ eventId, merchantId, productId: p._id, onHand: 3, lowStockThreshold: 5 } as any); // 3 <= 5 -> low

  const res = await request(app).get('/api/merchant/stock').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const row = res.body.data.stock.find((r: any) => r.productId === String(p._id));
  expect(row).toMatchObject({ price: 2500, barcode: '6001240100015', category: 'beer', status: 'low' });
  expect(row.imageUrl ?? null).toBeNull();
});
```
(Model the harness on the existing Slice-3 merchant-stock test — a merchant JWT via the operator login helper. Reuse whatever `ownedMerchantSession`-equivalent it already has.)

- [ ] **Step 2: Run it — FAIL** (`price`/`status` undefined). `npx jest merchantStock`

- [ ] **Step 3: Implement** — in `MerchantController.stock`, map the extra fields + status:

```typescript
const stock = products.map((p) => {
  const r = byProduct.get(String(p._id));
  const onHand = r?.onHand ?? 0;
  const threshold = r?.lowStockThreshold ?? null;
  const status = onHand <= 0 ? 'sold_out' : (threshold != null && threshold > 0 && onHand <= threshold ? 'low' : 'in_stock');
  return {
    productId: String(p._id), name: p.name, price: p.price,
    barcode: p.barcode ?? null, category: p.category, imageUrl: p.imageUrl ?? null,
    unitLabel: p.unitLabel, unitsPerPack: p.unitsPerPack ?? null, packLabel: p.packLabel ?? null,
    onHand, lowStockThreshold: threshold, status,
  };
});
```

- [ ] **Step 4: Run it — PASS.** `npx jest merchantStock`
- [ ] **Step 5: `npx tsc --noEmit` clean, then commit** `feat(cashless-stock): enrich GET /merchant/stock with price/barcode/category/status (Slice 5)`

---

### Task 2 (pos): `Basket` model + unit tests

**Files:**
- Create: `lib/pages/cashless/basket.dart`
- Test: `test/basket_test.dart`

**Interfaces:**
- Produces: `StockProduct`, `BasketLine`, `Basket` (see §4.2). Consumed by Task 3 (`MerchantApi`) and Task 4 (Charge tab).

- [ ] **Step 1: Write the failing `Basket` test**

```dart
// test/basket_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:carrot_pos/pages/cashless/basket.dart'; // confirm the package name from pubspec `name:`

StockProduct _p(String id, {int price = 100, String status = 'in_stock'}) => StockProduct(
  productId: id, name: 'P$id', price: price, barcode: null, category: 'beer',
  imageUrl: null, unitLabel: 'unit', unitsPerPack: null, packLabel: null,
  onHand: 10, lowStockThreshold: null, status: status);

void main() {
  test('add creates a qty-1 line; re-add increments', () {
    final b = Basket();
    b.add(_p('a'));
    expect(b.count, 1);
    b.add(_p('a'));
    expect(b.lines.single.qty, 2);
    expect(b.count, 2);
  });
  test('decrement to zero removes the line', () {
    final b = Basket()..add(_p('a'));
    b.decrement('a');
    expect(b.isEmpty, true);
  });
  test('totalCents = sum of price*qty', () {
    final b = Basket()..add(_p('a', price: 250))..add(_p('a', price: 250))..add(_p('b', price: 100));
    expect(b.totalCents, 250 * 2 + 100);
    expect(b.count, 3);
  });
  test('remove + clear', () {
    final b = Basket()..add(_p('a'))..add(_p('b'));
    b.remove('a');
    expect(b.lines.length, 1);
    b.clear();
    expect(b.isEmpty, true);
  });
}
```
(Confirm the import package name from `pubspec.yaml`'s `name:` — replace `carrot_pos` accordingly.)

- [ ] **Step 2: Run it — FAIL** (`basket.dart` missing). `flutter test test/basket_test.dart`

- [ ] **Step 3: Implement `basket.dart`**

```dart
/// Client-side POS basket (design 2026-08-13, Slice 5). Pure logic — no I/O.
/// The running total is DISPLAY-ONLY; the server prices the actual charge.
class StockProduct {
  final String productId;
  final String name;
  final int price;              // integer ZAR cents, per base unit
  final String? barcode;        // scan-match key (client-side); null for barcodeless items
  final String category;
  final String? imageUrl;
  final String unitLabel;
  final int? unitsPerPack;
  final String? packLabel;
  final int onHand;
  final int? lowStockThreshold;
  final String status;          // 'in_stock' | 'low' | 'sold_out'

  const StockProduct({
    required this.productId, required this.name, required this.price,
    required this.barcode, required this.category, required this.imageUrl,
    required this.unitLabel, required this.unitsPerPack, required this.packLabel,
    required this.onHand, required this.lowStockThreshold, required this.status,
  });

  bool get soldOut => status == 'sold_out';

  factory StockProduct.fromJson(Map<String, dynamic> j) => StockProduct(
        productId: (j['productId'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        price: (j['price'] as num?)?.toInt() ?? 0,
        barcode: j['barcode'] as String?,
        category: (j['category'] ?? 'other').toString(),
        imageUrl: j['imageUrl'] as String?,
        unitLabel: (j['unitLabel'] ?? 'unit').toString(),
        unitsPerPack: (j['unitsPerPack'] as num?)?.toInt(),
        packLabel: j['packLabel'] as String?,
        onHand: (j['onHand'] as num?)?.toInt() ?? 0,
        lowStockThreshold: (j['lowStockThreshold'] as num?)?.toInt(),
        status: (j['status'] ?? 'in_stock').toString(),
      );
}

class BasketLine {
  final StockProduct product;
  int qty;
  BasketLine(this.product, [this.qty = 1]);
  int get lineTotal => product.price * qty;
  Map<String, dynamic> toJson() => {'productId': product.productId, 'qty': qty};
}

class Basket {
  final List<BasketLine> lines = [];

  BasketLine? _find(String productId) {
    for (final l in lines) {
      if (l.product.productId == productId) return l;
    }
    return null;
  }

  void add(StockProduct p) {
    final l = _find(p.productId);
    if (l != null) {
      l.qty += 1;
    } else {
      lines.add(BasketLine(p));
    }
  }

  void increment(String productId) {
    final l = _find(productId);
    if (l != null) l.qty += 1;
  }

  void decrement(String productId) {
    final l = _find(productId);
    if (l == null) return;
    l.qty -= 1;
    if (l.qty <= 0) lines.removeWhere((x) => x.product.productId == productId);
  }

  void remove(String productId) => lines.removeWhere((x) => x.product.productId == productId);
  void clear() => lines.clear();

  int get totalCents => lines.fold(0, (s, l) => s + l.lineTotal);
  int get count => lines.fold(0, (s, l) => s + l.qty);
  bool get isEmpty => lines.isEmpty;
  List<Map<String, dynamic>> toItemsJson() => lines.map((l) => l.toJson()).toList();
}
```

- [ ] **Step 4: Run it — PASS.** `flutter test test/basket_test.dart`
- [ ] **Step 5: `flutter analyze lib/pages/cashless/basket.dart test/basket_test.dart` clean, then commit** `feat(cashless-pos): basket model + StockProduct (Slice 5)`

---

### Task 3 (pos): `MerchantApi` — stock(), submitCount(), charge(items,staffName)

**Files:**
- Modify: `lib/api.dart` (`MerchantApi`, `ChargeResult`)

**Interfaces:**
- Consumes: `Basket`/`StockProduct` (Task 2), `kApiBase`, `ResellerApi._unwrapMap`, `ApiException`.
- Produces: `MerchantApi.stock() -> Future<List<StockProduct>>`; `MerchantApi.submitCount({productId, countedOnHand, phase}) -> Future<CountResult>`; `MerchantApi.charge({bandUid, clientTxnId, amountCents?, items?, staffName?})`; `ChargeResult` gains `reason`/`outOfStockProductId`/`available` (409 stock decline).

- [ ] **Step 1: Extend `ChargeResult`** — add `final String? reason; final String? outOfStockProductId; final int? available;` and a `ChargeResult.outOfStock({productId, available, message})` factory (`ok=false, declined=true, reason='out_of_stock'`). Keep the existing `.success`/`.declined` factories (set the new fields null there).

- [ ] **Step 2: Extend `MerchantApi.charge`** — add optional `int? amountCents`, `List<Map<String,dynamic>>? items`, `String? staffName`; build the body with `amount` XOR `items`; on `ApiException` map `402 → ChargeResult.declined`, `409 → ChargeResult.outOfStock(productId: e.data?['productId'], available: (e.data?['available'] as num?)?.toInt(), message: e.message)`, else rethrow. (Callers pass EITHER `amountCents` OR `items`, never both.)

```dart
static Future<ChargeResult> charge({
  required String bandUid,
  required String clientTxnId,
  int? amountCents,
  List<Map<String, dynamic>>? items,
  String? staffName,
}) async {
  final res = await http.post(
    Uri.parse('$kApiBase/merchant/charge'),
    headers: _h(),
    body: jsonEncode({
      'bandUid': bandUid,
      'clientTxnId': clientTxnId,
      if (items != null) 'items': items else 'amount': amountCents,
      if (staffName != null && staffName.isNotEmpty) 'staffName': staffName,
    }),
  );
  try {
    final data = ResellerApi._unwrapMap(res);
    return ChargeResult.success(
      newBalance: (data['newBalance'] as num?)?.toInt(),
      fee: (data['fee'] as num?)?.toInt(),
      merchantNet: (data['merchantNet'] as num?)?.toInt(),
    );
  } on ApiException catch (e) {
    if (e.status == 402) {
      return ChargeResult.declined(
        currentBalance: (e.data?['currentBalance'] as num?)?.toInt(), message: e.message);
    }
    if (e.status == 409) {
      return ChargeResult.outOfStock(
        productId: e.data?['productId'] as String?,
        available: (e.data?['available'] as num?)?.toInt(),
        message: e.message);
    }
    rethrow;
  }
}
```

- [ ] **Step 3: Add `stock()` + `submitCount()` + `CountResult`**

```dart
static Future<List<StockProduct>> stock() async {
  final res = await http.get(Uri.parse('$kApiBase/merchant/stock'), headers: _h());
  final data = ResellerApi._unwrapMap(res);
  final list = (data['stock'] as List?) ?? const [];
  return list.map((e) => StockProduct.fromJson(e as Map<String, dynamic>)).toList();
}

static Future<CountResult> submitCount({
  required String productId, required int countedOnHand, String phase = 'interim',
}) async {
  final res = await http.post(
    Uri.parse('$kApiBase/merchant/stock/count'),
    headers: _h(),
    body: jsonEncode({'productId': productId, 'countedOnHand': countedOnHand, 'phase': phase}),
  );
  final data = ResellerApi._unwrapMap(res);
  return CountResult(
    expectedOnHand: (data['expectedOnHand'] as num?)?.toInt() ?? 0,
    countedOnHand: (data['countedOnHand'] as num?)?.toInt() ?? countedOnHand,
    variance: (data['variance'] as num?)?.toInt() ?? 0,
    onHand: (data['onHand'] as num?)?.toInt() ?? countedOnHand,
  );
}
```
`class CountResult { final int expectedOnHand, countedOnHand, variance, onHand; const CountResult({...}); }` (add near `ChargeResult`). Import `basket.dart` at the top of `api.dart`.

- [ ] **Step 4: `flutter analyze lib/api.dart` clean, then commit** `feat(cashless-pos): MerchantApi stock()/submitCount()/charge(items,staffName) (Slice 5)`

---

### Task 4 (pos): Charge tab → basket POS (tiles + scan + settle + staffName)

**Files:**
- Modify: `lib/pages/charge_page.dart` (the big transform)
- Create: `lib/pages/cashless/product_tile_grid.dart`, `lib/pages/cashless/basket_panel.dart`, `lib/pages/cashless/scan_barcode_sheet.dart` (extracted widgets to keep `charge_page.dart` focused)

**Interfaces:**
- Consumes: `MerchantApi.stock()`/`charge()`, `Basket`, `StockProduct`, `TagReader`, the cashless theme widgets (`CashlessColors`/`CashlessText`/`CashlessTapButton`/`CashlessTagLine`/`CashlessErrorBanner`/`fmtCents`).

Build order (commit after each sub-step's `flutter analyze` is clean; no widget tests — logic lives in `Basket`, already tested):

- [ ] **Step 1: State + data load.** Extend `_ChargePageState`: `enum _Mode { basket, amount }` (default basket); `Basket _basket = Basket()`; `List<StockProduct> _products = []`; `bool _loadingStock`; `String? _stockError`; `String? _staffName`. On `initState`, `_loadStock()` → `MerchantApi.stock()` (set loading/error/empty). Keep the existing amount-only fields for amount mode.

- [ ] **Step 2: Product tile grid** (`product_tile_grid.dart`) — `GridView` of `_products`; each tile: name, `fmtCents(price)`, an `onHand`/status badge; `soldOut` → dimmed, non-tappable, "SOLD OUT" pill; `onTap: () => setState(() => _basket.add(product))`. A loading spinner / empty ("No products yet") / error+retry state gate it.

- [ ] **Step 3: Basket panel** (`basket_panel.dart`) — the `_basket.lines` with name·qty·lineTotal, ± steppers (`setState(_basket.increment/decrement)`), remove; a footer total `fmtCents(_basket.totalCents)`. Empty ⇒ hidden or "Scan or tap to add".

- [ ] **Step 4: Scan** (`scan_barcode_sheet.dart`) — a modal `MobileScanner` (reuse the `scan_page.dart` controller pattern); `onDetect` → look up `_products.firstWhereOrNull((p) => p.barcode == raw)`; hit → `setState(_basket.add(p))` + haptic, stay open; miss → a transient "Not in catalogue" label. A done button closes.

- [ ] **Step 5: Settle** — the `CashlessTapButton` label becomes `Charge ${fmtCents(_basket.totalCents)} — tap band`, enabled when `!_basket.isEmpty`. `_charge()` reads the band (existing flow) then `MerchantApi.charge(bandUid: tag.uid!, items: _basket.toItemsJson(), staffName: _staffName, clientTxnId: ...)`. Map results: `success` → itemised result view + New sale (clears basket); `outOfStock` → `_errorMessage = 'Out of stock: ${name for productId}'` banner, basket kept, status back to idle; `declined` (402) → the existing decline view.

- [ ] **Step 6: Mode toggle + staffName.** A header segmented toggle Basket ⇄ Amount (switching `setState` clears the other's state). Amount mode = the current keypad flow, calling `charge(amountCents: _cents, staffName: _staffName, ...)`. A header chip "Till: ${_staffName ?? 'Set till'}" opens a `showDialog` `TextField` → sets `_staffName`. Prompt once on first basket build (skippable).

- [ ] **Step 7: `flutter analyze` clean on all changed/new files; commit** `feat(cashless-pos): basket POS charge tab — tiles, scan, settle, staffName (Slice 5)`

---

### Task 5 (pos): Stock-take screen (Stock tab) + wire the shell

**Files:**
- Create: `lib/pages/merchant_stock_page.dart`
- Modify: `lib/pages/merchant_shell.dart` (3rd tab)

**Interfaces:**
- Consumes: `MerchantApi.stock()`/`submitCount()`, cashless theme.

- [ ] **Step 1: `MerchantStockPage`** — loads `MerchantApi.stock()`; a list where each row shows name + current `onHand` + a counted-qty number field + a Submit; on submit `MerchantApi.submitCount(productId, countedOnHand)` then show the returned `variance` inline (`−`=error red, `0`=muted, `+`=success) and update that row's `onHand`. Loading/empty/error+retry states.

- [ ] **Step 2: Add the Stock tab** to `MerchantShell`: `static const _pages = [ChargePage(), MerchantTransactionsPage(), MerchantStockPage()];` and a third `NavigationDestination(icon: Icon(Icons.inventory_2_outlined), selectedIcon: Icon(Icons.inventory_2_rounded), label: 'Stock')`.

- [ ] **Step 3: `flutter analyze` clean; commit** `feat(cashless-pos): merchant stock-take screen + Stock tab (Slice 5)`

- [ ] **Step 4: Final gates + review + merge.**
  - api: `npx jest merchantStock` green + `npx tsc --noEmit`; FF-merge `feat/cashless-stock-posfeed` → `feat/cashless-cashier`.
  - pos: `flutter test` (basket) green + `flutter analyze` clean; independent review of the pos diff; FF-merge `feat/cashless-pos-stock` → `feat/cashless-pos-cashier`.

## Self-Review checklist

- **Spec coverage:** enriched endpoint (T1), Basket + StockProduct (T2), MerchantApi charge(items,staffName)/stock/submitCount + 409 handling (T3), basket POS tiles/scan/basket/settle + amount-mode + staffName (T4), stock-take + Stock tab (T5). ✅
- **Amount XOR items:** the charge body sends `items` OR `amount`, never both; the mode toggle keeps them separate. ✅
- **Server-priced:** the running total is display-only; settle sends items, not amount. ✅
- **Fail loudly:** unknown scan toast, stock-load retry state, 402 vs 409 distinct, fresh clientTxnId. ✅
- **No app run / no APK:** verification is `flutter analyze` + `flutter test` (Basket) only. ✅
