# Cashless Slice 1 — POS App (NFC Tag Registration UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add native read-only NFC + the cashless flows to `carrot_tickets_pos`, so on a `cashless` event a reseller can sell-band + top-up and a gate operator can bind-to-existing, tap-to-check-in, and read balances.

**Architecture:** Additive. A shared `TagReader` reads the tag UID via native Android NFC (read-only). PosPage (reseller) gains sell-band + cash top-up; ScanPage (gate) gains bind-to-existing + tap-to-check-in + balance. Everything is gated by operator **type** (`Session.type`) + the selected event's `cashless` flag — the existing sell/scan paths are untouched when the event is not cashless.

**Tech Stack:** Flutter (Dart SDK ^3.11.1), `nfc_manager` (new), existing `http` + `shared_preferences` + `mobile_scanner` + `printing`.

**Depends on:** the backend plan (`2026-08-07-cashless-tag-ticket-backend.md`) merged/available — endpoints `POST /api/reseller/sales/sell-band`, `POST /api/reseller/wallets/cash-topup`, `GET /api/tickets/wallets/by-band/:uid`, `POST /api/tickets/scans/check-in` (with `bandUid`), plus `cashless` present on event list responses.

**Spec:** `docs/superpowers/specs/2026-08-07-cashless-tag-ticket-registration-design.md` §6.

## Global Constraints

- **Read-only NFC.** Read the tag identifier (UID) only — never NDEF read/write. Render UID as **lowercased hex, no separators**, ≥14 chars (7-byte NTAG). Reject shorter UIDs with a clear message.
- **Gating.** No permissions array exists in the app — gate by `Session.type` (`'reseller'` → PosPage, `'gate'` → ScanPage) **AND** the selected event's `cashless` flag. When `!cashless`, both screens look and behave exactly as today.
- **Fail loudly.** Surface every API failure to the operator (error banner/snackbar with the server message). No silent success, no fake balances.
- **Money is integer cents.** The UI collects Rands and converts to cents (`*100`, integer) before sending; displays cents as `R{(cents/100).toStringAsFixed(2)}`.
- **DRY.** One `TagReader` for all NFC reads. One `Event.cashless` parse point.
- **VERIFICATION IS USER-GATED.** Per the standing rule, do **not** run the app or build the APK without an explicit request. `dart analyze` (static, not running) may be used to catch type errors; on-device tap verification is the user's green-lit step (Task A5).
- All paths relative to `pos-app/`.

---

## File Structure

**Create:**
- `lib/nfc/tag_reader.dart` — native NFC session → UID string (the only NFC touch-point).
- `lib/pages/cashless/sell_band_sheet.dart` — reseller sell-band flow (bottom sheet).
- `lib/pages/cashless/cash_topup_sheet.dart` — reseller cash top-up flow.
- `lib/pages/cashless/band_ops_sheet.dart` — gate bind-to-existing + balance.

**Modify:**
- `pubspec.yaml` — add `nfc_manager`.
- `android/app/src/main/AndroidManifest.xml` — add `<uses-permission android:name="android.permission.NFC"/>`.
- `lib/api.dart` — `Event.cashless`; `ResellerApi.sellBand` + `.cashTopup`; `GateApi.walletByBand` + `.checkInByBand`.
- `lib/pages/pos_page.dart` — cashless controls when reseller + selected event cashless.
- `lib/pages/scan_page.dart` — cashless controls when gate + selected event cashless.

---

## Task A1: NFC dependency, manifest, and `TagReader`

**Files:** `pubspec.yaml`, `android/app/src/main/AndroidManifest.xml`, Create `lib/nfc/tag_reader.dart`.

- [ ] **Step 1: Add the dependency**

In `pubspec.yaml` under `dependencies:`:
```yaml
  # Read-only NFC: we read the tag UID (identifier) only, never write.
  nfc_manager: ^4.0.2
```
Then `flutter pub get`. *(Running `pub get` fetches packages; it does not run the app or build an APK — allowed. If the user prefers, defer to Task A5.)*

- [ ] **Step 2: Manifest permission**

In `android/app/src/main/AndroidManifest.xml`, inside `<manifest>` (above `<application>`):
```xml
<uses-permission android:name="android.permission.NFC" />
<uses-feature android:name="android.hardware.nfc" android:required="false" />
```
`required="false"` so the app still installs on non-NFC devices (the cashless UI simply won't be offered there).

- [ ] **Step 3: Implement `TagReader`**

```dart
// lib/nfc/tag_reader.dart
import 'package:nfc_manager/nfc_manager.dart';

class TagReadResult {
  final bool ok;
  final String? uid;      // lowercased hex, no separators
  final String? error;
  const TagReadResult.ok(this.uid) : ok = true, error = null;
  const TagReadResult.fail(this.error) : ok = false, uid = null;
}

class TagReader {
  static Future<bool> available() async => NfcManager.instance.isAvailable();

  /// Starts a session, resolves with the first tag's UID, then stops.
  static Future<TagReadResult> readUid() async {
    if (!await NfcManager.instance.isAvailable()) {
      return const TagReadResult.fail('NFC is off or unavailable on this device');
    }
    final completer = _Completer();
    await NfcManager.instance.startSession(
      pollingOptions: {NfcPollingOption.iso14443, NfcPollingOption.iso15693},
      onDiscovered: (NfcTag tag) async {
        final uid = _extractUid(tag);
        await NfcManager.instance.stopSession();
        if (uid == null || uid.length < 14) {
          completer.done(const TagReadResult.fail('Tag UID unreadable or too short (need 7-byte tag)'));
        } else {
          completer.done(TagReadResult.ok(uid));
        }
      },
    );
    return completer.future;
  }

  /// Extract the tag identifier bytes and hex-encode them.
  /// NOTE: the exact accessor depends on the installed nfc_manager version —
  /// CONFIRM ON DEVICE (Task A5). For 4.x, read the identifier off the
  /// technology view (NfcA/NfcB/etc.); render bytes as lowercase hex.
  static String? _extractUid(NfcTag tag) {
    final id = _identifierBytes(tag);
    if (id == null) return null;
    return id.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  static List<int>? _identifierBytes(NfcTag tag) {
    // Implement against the pinned nfc_manager API. Example (verify):
    //   final a = NfcA.from(tag); if (a != null) return a.identifier;
    //   final b = NfcB.from(tag); if (b != null) return b.applicationData; // etc.
    // Kept as a single seam so the rest of the app is version-agnostic.
    return null; // TODO(device): wire to the installed nfc_manager identifier accessor.
  }
}

class _Completer {
  final _c = <TagReadResult>[];
  final _f = _Async<TagReadResult>();
  Future<TagReadResult> get future => _f.future;
  void done(TagReadResult r) => _f.complete(r);
}
// Use dart:async Completer in the real file; the sketch above shows intent.
```
> Replace the `_Completer` sketch with a real `dart:async` `Completer<TagReadResult>`. The one genuinely device-specific line is `_identifierBytes` — this is the accessor to confirm in Task A5. Everything else (session lifecycle, hex render, length gate) is version-stable.

- [ ] **Step 4: `dart analyze lib/nfc/tag_reader.dart`** — resolve type errors. (Static only.)

- [ ] **Step 5: Commit**

```bash
git add pubspec.yaml android/app/src/main/AndroidManifest.xml lib/nfc/tag_reader.dart
git commit -m "feat(cashless): native read-only NFC TagReader + manifest"
```

---

## Task A2: `api.dart` — cashless flag + client calls

**Files:** Modify `lib/api.dart`.

**Interfaces:**
- Produces: `Event.cashless (bool)`; `ResellerApi.sellBand(...)`, `ResellerApi.cashTopup(...)`, `GateApi.walletByBand(uid, eventId)`, `GateApi.checkInByBand(uid, eventId)`.

- [ ] **Step 1: Add `cashless` to the `Event` model + its parser**

In the `Event` class in `lib/api.dart`, add `final bool cashless;`, set it in the constructor, and in the JSON factory:
```dart
cashless: json['cashless'] == true,
```
(Backend surfaces `cashless` on `GET /api/reseller/events` and the gate events list — see the backend plan T1 and confirm the gate list includes it.)

- [ ] **Step 2: Add the reseller calls**

```dart
// in class ResellerApi
static Future<Map<String, dynamic>> sellBand({
  required String eventId, required String ticketTypeId, required String bandUid,
  int cashAmountCents = 0, String? customerName, String? customerPhone, required String clientTxnId,
}) async {
  final res = await http.post(Uri.parse('$kApiBase/reseller/sales/sell-band'),
    headers: _headers,
    body: jsonEncode({
      'eventId': eventId, 'ticketTypeId': ticketTypeId, 'bandUid': bandUid,
      'cashAmount': cashAmountCents, if (customerName != null) 'customerName': customerName,
      if (customerPhone != null) 'customerPhone': customerPhone, 'clientTxnId': clientTxnId,
    }));
  return _decodeOrThrow(res);
}

static Future<Map<String, dynamic>> cashTopup({
  String? bandUid, String? ticketId, required String eventId, required int amountCents, required String clientTxnId,
}) async {
  final res = await http.post(Uri.parse('$kApiBase/reseller/wallets/cash-topup'),
    headers: _headers,
    body: jsonEncode({
      if (bandUid != null) 'bandUid': bandUid, if (ticketId != null) 'ticketId': ticketId,
      'eventId': eventId, 'amount': amountCents, 'clientTxnId': clientTxnId,
    }));
  return _decodeOrThrow(res);
}
```

- [ ] **Step 3: Add the gate calls**

```dart
// in class GateApi
static Future<Map<String, dynamic>> walletByBand(String uid, String eventId) async {
  final res = await http.get(Uri.parse('$kApiBase/tickets/wallets/by-band/$uid?eventId=$eventId'), headers: _h);
  return _decodeOrThrow(res);
}
static Future<Map<String, dynamic>> checkInByBand(String uid, String eventId) async {
  final res = await http.post(Uri.parse('$kApiBase/tickets/scans/check-in'),
    headers: _h, body: jsonEncode({'bandUid': uid, 'expectedEventId': eventId}));
  return _decodeOrThrow(res);
}
```

- [ ] **Step 4: Add a shared `_decodeOrThrow` (fail-loudly) if one isn't already present**

```dart
Map<String, dynamic> _decodeOrThrow(http.Response res) {
  final body = jsonDecode(res.body) as Map<String, dynamic>;
  if (res.statusCode >= 200 && res.statusCode < 300) return body;
  throw ApiException(body['message']?.toString() ?? 'Request failed (${res.statusCode})');
}
```
(Reuse the existing error type if `api.dart` already defines one; otherwise add a small `ApiException`.)

- [ ] **Step 5: `dart analyze lib/api.dart`** — clean.

- [ ] **Step 6: Commit**

```bash
git add lib/api.dart
git commit -m "feat(cashless): api client — Event.cashless + sell-band/top-up/band calls"
```

---

## Task A3: PosPage (reseller) cashless controls

**Files:** Modify `lib/pages/pos_page.dart`; Create `lib/pages/cashless/sell_band_sheet.dart`, `lib/pages/cashless/cash_topup_sheet.dart`.

- [ ] **Step 1: Gate the entry points**

In `pos_page.dart`, where the selected event (`_event`) is known, compute `final bool cashless = _event?.cashless == true;`. Render two extra buttons ONLY when `cashless` (reseller type is already implied — this is PosPage):
```dart
if (cashless) ...[
  ElevatedButton.icon(icon: const Icon(Icons.nfc), label: const Text('Sell band as ticket'),
    onPressed: _event == null ? null : () => showModalBottomSheet(context: context, isScrollControlled: true,
      builder: (_) => SellBandSheet(event: _event!))),
  ElevatedButton.icon(icon: const Icon(Icons.account_balance_wallet), label: const Text('Top up a band'),
    onPressed: _event == null ? null : () => showModalBottomSheet(context: context, isScrollControlled: true,
      builder: (_) => CashTopupSheet(event: _event!))),
],
```

- [ ] **Step 2: `SellBandSheet`** — pick ticket type (reuse the ticket-type list PosPage already loads), enter optional cash (Rands), tap tag, submit.

```dart
// lib/pages/cashless/sell_band_sheet.dart  (key logic)
Future<void> _submit() async {
  setState(() => _busy = true);
  try {
    final tag = await TagReader.readUid();
    if (!tag.ok) throw Exception(tag.error);
    final res = await ResellerApi.sellBand(
      eventId: widget.event.id, ticketTypeId: _selectedTicketTypeId!, bandUid: tag.uid!,
      cashAmountCents: (_cashRands * 100).round(),
      clientTxnId: 'sb-${widget.event.id}-${DateTime.now().microsecondsSinceEpoch}',
    );
    // Optionally print via the existing TicketPrinter using res['data']['ticket'].
    if (mounted) Navigator.pop(context, res);
  } catch (e) {
    setState(() => _error = e.toString());   // fail loudly
  } finally { if (mounted) setState(() => _busy = false); }
}
```
Show `_error` in a red banner; show a success animation on pop (reuse `widgets/success_animation.dart`).

- [ ] **Step 3: `CashTopupSheet`** — tap tag → enter amount (Rands) → submit.

```dart
Future<void> _submit() async {
  setState(() => _busy = true);
  try {
    final tag = await TagReader.readUid();
    if (!tag.ok) throw Exception(tag.error);
    final res = await ResellerApi.cashTopup(
      bandUid: tag.uid!, eventId: widget.event.id, amountCents: (_rands * 100).round(),
      clientTxnId: 'ct-${widget.event.id}-${DateTime.now().microsecondsSinceEpoch}',
    );
    final cents = (res['data']?['wallet']?['balance'] ?? 0) as int;
    if (mounted) { _showBalance(cents); Navigator.pop(context, res); }
  } catch (e) { setState(() => _error = e.toString()); }
  finally { if (mounted) setState(() => _busy = false); }
}
```

- [ ] **Step 4: `dart analyze lib/pages/pos_page.dart lib/pages/cashless/` — clean.**

- [ ] **Step 5: Commit**

```bash
git add lib/pages/pos_page.dart lib/pages/cashless/sell_band_sheet.dart lib/pages/cashless/cash_topup_sheet.dart
git commit -m "feat(cashless): PosPage sell-band + cash top-up (cashless events)"
```

---

## Task A4: ScanPage (gate) cashless controls

**Files:** Modify `lib/pages/scan_page.dart`; Create `lib/pages/cashless/band_ops_sheet.dart`.

- [ ] **Step 1: Gate the entry points**

In `scan_page.dart`, resolve the selected event's `cashless` from the events list already loaded for `_selectedEventId`. When `cashless`, add: a "Tap band to check in" button, a "Bind band to ticket" action, and a "Check balance" action.

- [ ] **Step 2: Tap-to-check-in**

```dart
Future<void> _tapCheckIn() async {
  final tag = await TagReader.readUid();
  if (!tag.ok) { _showError(tag.error!); return; }
  try {
    await GateApi.checkInByBand(tag.uid!, _selectedEventId!);
    _showSuccess('Checked in');
  } catch (e) { _showError(e.toString()); }   // fail loudly (unbound / not cashless / already in)
}
```

- [ ] **Step 3: Bind-to-existing** — reuse the existing QR scan to get the `ticketId`, then tap the band, then call the built bind endpoint. Add to `GateApi`:
```dart
static Future<Map<String, dynamic>> bindBand(String ticketId, String bandUid, String eventId) async {
  final res = await http.post(Uri.parse('$kApiBase/tickets/scans/bind-band'),
    headers: _h, body: jsonEncode({'ticketId': ticketId, 'bandUid': bandUid, 'expectedEventId': eventId}));
  return _decodeOrThrow(res);
}
```
Flow in `band_ops_sheet.dart`: scan QR (existing `mobile_scanner`) → `TagReader.readUid()` → `GateApi.bindBand(ticketId, uid, eventId)` → success/fail banner.

- [ ] **Step 4: Check balance**

```dart
Future<void> _balance() async {
  final tag = await TagReader.readUid();
  if (!tag.ok) { _showError(tag.error!); return; }
  try {
    final res = await GateApi.walletByBand(tag.uid!, _selectedEventId!);
    final d = res['data']; _showBalanceDialog(d['balance'] as int, d['status'] as String, d['history']);
  } catch (e) { _showError(e.toString()); }
}
```

- [ ] **Step 5: `dart analyze lib/pages/scan_page.dart lib/pages/cashless/band_ops_sheet.dart` — clean.**

- [ ] **Step 6: Commit**

```bash
git add lib/pages/scan_page.dart lib/pages/cashless/band_ops_sheet.dart lib/api.dart
git commit -m "feat(cashless): ScanPage tap-check-in + bind + balance (cashless events)"
```

---

## Task A5: On-device verification (USER-GATED)

**This task requires the user's explicit go-ahead to build/run the APK.** Do not perform it otherwise.

- [ ] **Step 1: Confirm the NFC identifier accessor** — with a device, resolve `TagReader._identifierBytes` against the installed `nfc_manager` API so a real tap yields a 14+ hex UID. This is the one device-specific unknown.
- [ ] **Step 2: Build + install** (user-run): `flutter build apk --debug` (or run on a booted device). Mark a non-cashless event → confirm the app looks exactly as today. Mark an event `cashless`.
- [ ] **Step 3: Reseller (PosPage) flow** — Sell band as ticket (tap the physical tag) → verify a ticket + wallet + binding are created and (if cash entered) balance is set; Top up a band → verify balance increases.
- [ ] **Step 4: Gate (ScanPage) flow** — Bind band to an existing (QR) ticket; Tap band to check in → verify the ticket flips to checked-in; Check balance → verify the amount matches.
- [ ] **Step 5: Negative paths** — a 4-byte/short tag is rejected; an unbound tag at the gate fails loudly; a non-cashless event shows none of the cashless controls.
- [ ] **Step 6: Report results back**, fix any wiring, re-verify.

---

## Self-review notes (for the planner)

- **Spec §6 coverage:** `nfc_manager` + manifest + read-only `TagReader` → A1; `Event.cashless` + client calls → A2; PosPage sell-band + top-up → A3; ScanPage bind + tap-check-in + balance → A4; gating by type + cashless → A3/A4; on-device verification → A5.
- **The two device-specific unknowns** (flagged, both land in A5): the `nfc_manager` identifier accessor, and confirming the **gate** events endpoint returns `cashless` (backend T1 covers the reseller list; verify the gate list too).
- **No automated app tests run here** — per the standing rule, verification is on-device and user-gated (A5). `dart analyze` is used along the way for static safety only.
