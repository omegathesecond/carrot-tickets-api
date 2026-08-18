# Per-Person Cashless Operators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every cashless money movement attributable to a named human, and widen the login-code alphabet to absorb the resulting jump in operator count.

**Architecture:** Separate *place* from *person* in two populations. `Merchant` keeps the stall's identity and settlement account but loses its credentials to a new per-person `MerchantOperator`; `Cashier` becomes owned by exactly one event. Login codes move from 6-digit numeric to 6-character Crockford base32 across all four operator populations, sharing one generator.

**Tech Stack:** TypeScript, Express, Mongoose 8, Jest + mongodb-memory-server (API); React + TanStack Query + shadcn/ui (dashboard); Flutter (POS).

**Spec:** `docs/superpowers/specs/2026-08-18-per-person-cashless-operators-design.md`

## Global Constraints

- **Three repos.** API = `carrot-tickets/api-eventcashier-wt` (branch `feat/event-scoped-cashiers`, off `origin/dev`). Dashboard = `carrot-tickets/dashboard-eventstock-wt` (branch `feat/event-scoped-stock`). POS = `carrot-tickets/pos-app-cashier-wt` (branch `feat/cashless-pos-cashier`). Each task names its repo.
- **Run the API suite with `--runInBand`.** The full suite is order-sensitive and fails in parallel.
- **Alphabet is exactly** `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — 32 chars, no `I`, `L`, `O`, `U`.
- **Code length stays 6.**
- **Settlement stays at the stall.** `LedgerAccountType.MERCHANT` keeps referencing `merchantId`. Never post a ledger entry against an operator.
- **No client-supplied identity.** `merchantId`, `eventId`, and the operator's name come from the verified JWT only. A request body field that duplicates any of them is ignored, never trusted.
- **No production migration.** `origin/main` has no cashless files. Dev fixtures are dropped, not migrated.
- **Never use a silent fallback.** A missing operator on a token is a 401, not an anonymous charge.

---

## Track 1 — Base32 login codes

### Task 1: Base32 alphabet, generator, and normalizer

**Repo:** API

**Files:**
- Modify: `src/utils/operatorCredentials.util.ts`
- Test: `src/utils/__tests__/operatorCredentials.util.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LOGIN_CODE_ALPHABET: string` — the 32-char Crockford alphabet.
  - `normalizeLoginCode(raw: string): string` — trim, uppercase, fold `I`/`L`→`1`, `O`→`0`.
  - `generateUniqueLoginCode(): Promise<string>` — unchanged signature, now returns base32.
  - `generatePin(): string` — unchanged, still 6 numeric digits.

- [ ] **Step 1: Write the failing tests**

Replace the two format tests in `src/utils/__tests__/operatorCredentials.util.test.ts` (`generateUniqueLoginCode returns a 6-digit code in range` and the `randomInt`-mocking retry test) with the block below. Keep the existing `generatePin` test and the gate-operator collision test as they are — `generatePin` is unchanged, and the collision test does not depend on the format.

```typescript
import { generatePin, generateUniqueLoginCode, normalizeLoginCode, LOGIN_CODE_ALPHABET } from '@utils/operatorCredentials.util';

it('LOGIN_CODE_ALPHABET is Crockford base32 with the ambiguous glyphs removed', () => {
  expect(LOGIN_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  expect(LOGIN_CODE_ALPHABET).toHaveLength(32);
  for (const glyph of ['I', 'L', 'O', 'U']) {
    expect(LOGIN_CODE_ALPHABET).not.toContain(glyph);
  }
});

it('generateUniqueLoginCode returns 6 characters drawn only from the alphabet', async () => {
  for (let i = 0; i < 25; i++) {
    const code = await generateUniqueLoginCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  }
});

it('normalizeLoginCode uppercases and folds the ambiguous glyphs', () => {
  expect(normalizeLoginCode('abc123')).toBe('ABC123');
  expect(normalizeLoginCode('  4kz9p2  ')).toBe('4KZ9P2');
  expect(normalizeLoginCode('IL0O1')).toBe('11001');
  expect(normalizeLoginCode('il')).toBe('11');
});

it('normalizeLoginCode leaves an all-numeric legacy code untouched', () => {
  expect(normalizeLoginCode('482910')).toBe('482910');
});

it('generateUniqueLoginCode retries when a code is already taken', async () => {
  const first = await generateUniqueLoginCode();
  await ResellerOperator.collection.insertOne(
    { loginCode: first, fullName: 'x', role: 'reseller_operator', isActive: true } as any,
  );
  const codes = new Set<string>();
  for (let i = 0; i < 25; i++) codes.add(await generateUniqueLoginCode());
  expect(codes.has(first)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/utils/__tests__/operatorCredentials.util.test.ts --runInBand
```

Expected: FAIL — `normalizeLoginCode is not a function` and `LOGIN_CODE_ALPHABET` undefined.

- [ ] **Step 3: Implement**

Replace the body of `src/utils/operatorCredentials.util.ts` below the imports:

```typescript
/**
 * Crockford base32 — 32 glyphs with I, L, O and U removed. Chosen over
 * base36 because this code is printed on a slip and typed into a handheld in
 * a loud venue: dropping the ambiguous pairs (and folding them on input, see
 * normalizeLoginCode) is worth more than the extra 4 glyphs of entropy.
 */
export const LOGIN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const LOGIN_CODE_LENGTH = 6;

/** Random 6-digit PIN string (leading zeros allowed). */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Fold a typed code onto the canonical alphabet. Uppercase FIRST so a
 * lowercase "l" reaches the I/L rule. Legacy all-numeric codes are a strict
 * subset of the alphabet and pass through unchanged.
 */
export function normalizeLoginCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < LOGIN_CODE_LENGTH; i++) {
    out += LOGIN_CODE_ALPHABET[randomInt(0, LOGIN_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Random login code, unique across every PIN-login population. Codes are
 * NEVER reclaimed — history must stay attributable — so uniqueness is
 * permanent. At 32^6 (~1.07 billion) the retry loop is a formality.
 */
export async function generateUniqueLoginCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    const [r, g, c, m] = await Promise.all([
      ResellerOperator.exists({ loginCode: code }),
      GateOperator.exists({ loginCode: code }),
      Cashier.exists({ loginCode: code }),
      Merchant.exists({ loginCode: code }),
    ]);
    if (!r && !g && !c && !m) return code;
  }
  throw new Error('Could not generate a unique login code');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/utils/__tests__/operatorCredentials.util.test.ts --runInBand
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/operatorCredentials.util.ts src/utils/__tests__/operatorCredentials.util.test.ts
git commit -m "feat(auth): issue Crockford base32 login codes

6-digit numeric gave 900k permanently-unique codes across four
populations. Per-person stall operators multiply the operator count
per event, so widen to 32^6 (~1.07bn). Crockford specifically: the
code is read off a slip and typed into a handheld, so the ambiguous
glyphs are removed and folded on input."
```

---

### Task 2: Normalize codes at every login

**Repo:** API

**Files:**
- Modify: `src/services/merchantAuth.service.ts:25`
- Modify: `src/services/cashierAuth.service.ts:21`
- Modify: `src/services/gateOperatorAuth.service.ts:19`
- Modify: `src/services/resellerAuth.service.ts:13`
- Test: `src/services/__tests__/loginCodeNormalization.test.ts`

**Interfaces:**
- Consumes: `normalizeLoginCode(raw: string): string` from Task 1.
- Produces: nothing new — behaviour change only.

Normalization happens in the auth services, not the models, so there is exactly one place per population where a typed code becomes a lookup key.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/loginCodeNormalization.test.ts`:

```typescript
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function seedOperator(loginCode: string) {
  const op = new GateOperator({ fullName: 'Thabo', loginCode, scope: 'platform', isActive: true, pin: '123456' });
  await op.save(); // pre-save hook hashes the pin
  return op;
}

it('accepts a lowercase code', async () => {
  await seedOperator('4KZ9P2');
  const result = await GateOperatorAuthService.login('4kz9p2', '123456');
  expect(result.accessToken).toBeTruthy();
});

it('folds a misread I onto 1 and O onto 0', async () => {
  await seedOperator('1A0B2C');
  const result = await GateOperatorAuthService.login('IAOB2C', '123456');
  expect(result.accessToken).toBeTruthy();
});

it('still rejects a genuinely wrong code', async () => {
  await seedOperator('9Z9Z9Z');
  await expect(GateOperatorAuthService.login('4KZ9P2', '123456')).rejects.toThrow('Invalid credentials');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- src/services/__tests__/loginCodeNormalization.test.ts --runInBand
```

Expected: FAIL on the lowercase and folding cases with `Invalid credentials`.

- [ ] **Step 3: Implement in all four services**

In each of the four auth services, import the normalizer and apply it to the incoming code before the lookup. For `gateOperatorAuth.service.ts`:

```typescript
import { normalizeLoginCode } from '@utils/operatorCredentials.util';
```

then change the lookup line from:

```typescript
const operator = await GateOperator.findOne({ loginCode, isActive: true }).select('+pin');
```

to:

```typescript
const operator = await GateOperator.findOne({ loginCode: normalizeLoginCode(loginCode), isActive: true }).select('+pin');
```

Apply the identical change to the other three, preserving each one's own filter:
- `cashierAuth.service.ts:21` — `{ loginCode: normalizeLoginCode(loginCode), isActive: true }`
- `resellerAuth.service.ts:13` — `{ loginCode: normalizeLoginCode(loginCode), isActive: true }`
- `merchantAuth.service.ts:25` — `{ loginCode: normalizeLoginCode(loginCode), status: 'active' }`

Each service already guards `typeof loginCode !== 'string'` before this line, so the normalizer never sees a non-string.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/services/__tests__/loginCodeNormalization.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/
git commit -m "feat(auth): fold typed login codes onto the canonical alphabet

One normalization point per population, in the auth service rather
than the model, so there is exactly one place where a typed code
becomes a lookup key."
```

---

### Task 3: POS and portal login inputs accept letters

**Repo:** POS (`pos-app-cashier-wt`), plus the dashboard reseller login

**Files:**
- Modify: `lib/pages/login_page.dart:106-108` (login code field), leave `:121-123` (PIN) numeric
- Modify (dashboard repo): the reseller/operator login input, found via `grep -rn "inputMode\|pattern=" src/pages/reseller src/pages/LoginPage.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

This MUST ship in the same push as Task 1. A base32 code issued to an operator whose login screen still rejects letters is a live lockout.

- [ ] **Step 1: Change the POS login-code field**

In `lib/pages/login_page.dart`, the login-code `TextFormField` currently has:

```dart
keyboardType: TextInputType.number,
inputFormatters: [
  FilteringTextInputFormatter.digitsOnly,
```

Replace those with:

```dart
keyboardType: TextInputType.text,
textCapitalization: TextCapitalization.characters,
inputFormatters: [
  FilteringTextInputFormatter.allow(RegExp(r'[0-9A-Za-z]')),
  UpperCaseTextFormatter(),
  LengthLimitingTextInputFormatter(6),
```

Leave the PIN field's `TextInputType.number` and `digitsOnly` exactly as they are — PINs are still numeric.

- [ ] **Step 2: Add the uppercase formatter**

At the bottom of `lib/pages/login_page.dart`, outside the existing classes:

```dart
/// Uppercases as the operator types so the field always shows the code the
/// way it is printed on the slip. The server folds I/L/O anyway, but showing
/// the canonical form avoids "I typed it right and it says invalid".
class UpperCaseTextFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    return TextEditingValue(
      text: newValue.text.toUpperCase(),
      selection: newValue.selection,
    );
  }
}
```

- [ ] **Step 3: Add the widget test**

The repo already has `test/widget_test.dart` and `test/basket_test.dart`, so
there is no harness to set up. Create `test/login_code_field_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pos_app/pages/login_page.dart';

void main() {
  testWidgets('login code field accepts letters and uppercases them', (tester) async {
    final controller = TextEditingController();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TextField(
          controller: controller,
          keyboardType: TextInputType.text,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9A-Za-z]')),
            UpperCaseTextFormatter(),
            LengthLimitingTextInputFormatter(6),
          ],
        ),
      ),
    ));

    await tester.enterText(find.byType(TextField), '4kz9p2');
    expect(controller.text, '4KZ9P2');
  });

  testWidgets('login code field rejects punctuation', (tester) async {
    final controller = TextEditingController();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TextField(
          controller: controller,
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9A-Za-z]'))],
        ),
      ),
    ));

    await tester.enterText(find.byType(TextField), '4K-Z9 P2');
    expect(controller.text, '4KZ9P2');
  });
}
```

Add `import 'package:flutter/services.dart';` for the formatters, and match the
package name in the import to whatever `pubspec.yaml` declares.

- [ ] **Step 4: Verify it compiles and passes**

```bash
flutter analyze lib/pages/login_page.dart && flutter test test/login_code_field_test.dart
```

Expected: no analyzer errors, both tests pass. (Do not run or build the app — build only when explicitly asked.)

- [ ] **Step 5: Apply the same change to the dashboard reseller login**

Locate every login-code input:

```bash
grep -rn "inputMode\|maxLength={6}\|pattern=" src/pages/LoginPage.tsx src/pages/reseller/
```

For each one that takes a **login code** (not a PIN), remove `inputMode="numeric"` and `pattern="[0-9]*"`, then add uppercase handling:

```tsx
  className="h-12 uppercase"
  onChange={(e) => setLoginCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))}
```

Leave every PIN input's `inputMode="numeric"` exactly as it is.

- [ ] **Step 6: Commit (in each repo)**

```bash
git add lib/pages/login_page.dart test/login_code_field_test.dart
git commit -m "feat(pos): accept alphanumeric login codes

Ships with the base32 generator — a letter-bearing code typed into a
digitsOnly field is a lockout. PIN stays numeric."
```

---

## Track 2 — Per-person stall operators

### Task 4: MerchantOperator model

**Repo:** API

**Files:**
- Create: `src/models/merchantOperator.model.ts`
- Create: `src/interfaces/merchantOperator.interface.ts`
- Test: `src/models/__tests__/merchantOperator.model.test.ts`

**Interfaces:**
- Consumes: `applyOperatorCredentials(schema)` from `@models/operatorCredentials.schema`.
- Produces:
  - `IMerchantOperator` — `fullName: string`, `phoneNumber?: string`, `merchantId: Types.ObjectId`, `eventId: Types.ObjectId`, `loginCode: string`, `pin: string`, `isActive: boolean`, `failedPinAttempts: number`, `lockedUntil: Date | null`, `lastLoginAt?: Date`, `comparePin(candidate: string): Promise<boolean>`.
  - `MerchantOperator` — the Mongoose model.

- [ ] **Step 1: Write the failing test**

Create `src/models/__tests__/merchantOperator.model.test.ts`:

```typescript
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { MerchantOperator } from '@models/merchantOperator.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const base = () => ({
  fullName: 'Thabo Dlamini',
  merchantId: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId(),
  loginCode: `4KZ9P${Math.floor(Math.random() * 9)}`,
  pin: '123456',
});

it('requires a merchantId', async () => {
  const { merchantId, ...withoutMerchant } = base();
  await expect(new MerchantOperator(withoutMerchant).save()).rejects.toThrow(/merchantId/);
});

it('hashes the pin and never serializes it', async () => {
  const op = await new MerchantOperator(base()).save();
  expect(op.pin).not.toBe('123456');
  expect(await op.comparePin('123456')).toBe(true);
  expect(JSON.parse(JSON.stringify(op)).pin).toBeUndefined();
});

it('refuses to move an operator to another stall', async () => {
  const op = await new MerchantOperator(base()).save();
  const original = op.merchantId.toString();
  op.merchantId = new mongoose.Types.ObjectId();
  await op.save();
  const reloaded = await MerchantOperator.findById(op._id);
  expect(reloaded!.merchantId.toString()).toBe(original);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- src/models/__tests__/merchantOperator.model.test.ts --runInBand
```

Expected: FAIL — cannot resolve `@models/merchantOperator.model`.

- [ ] **Step 3: Write the interface**

Create `src/interfaces/merchantOperator.interface.ts`:

```typescript
// api/src/interfaces/merchantOperator.interface.ts
import { Document, Types } from 'mongoose';

/**
 * One PERSON working a stall. The stall itself is a Merchant: it holds the
 * name, the commission rate and the settlement account, but no credentials —
 * a place does not log in. Everyone on the till gets their own operator so a
 * charge names a human, and so one person can be revoked without rotating
 * the whole stall's PIN.
 */
export interface IMerchantOperator extends Document {
  fullName: string;
  phoneNumber?: string;
  /** The stall this person works. Immutable — move = new operator. */
  merchantId: Types.ObjectId;
  /** Denormalized from the stall so token minting needs no join. */
  eventId: Types.ObjectId;
  loginCode: string;
  pin: string;
  isActive: boolean;
  failedPinAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt?: Date;
  comparePin(candidate: string): Promise<boolean>;
}
```

- [ ] **Step 4: Write the model**

Create `src/models/merchantOperator.model.ts`:

```typescript
// api/src/models/merchantOperator.model.ts
import mongoose, { Schema } from 'mongoose';
import { IMerchantOperator } from '@interfaces/merchantOperator.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

/**
 * A person on the till at one stall (cashless spec — per-person operators).
 * Same PIN-login shape as Cashier/GateOperator via applyOperatorCredentials.
 * Attribution only: money is still owed to the STALL, so no ledger account
 * ever references this document.
 */
const merchantOperatorSchema = new Schema<IMerchantOperator>({
  fullName: { type: String, required: true, trim: true },
  phoneNumber: { type: String, trim: true },
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true, immutable: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(merchantOperatorSchema);

merchantOperatorSchema.index({ merchantId: 1, isActive: 1 });

export const MerchantOperator = mongoose.model<IMerchantOperator>('MerchantOperator', merchantOperatorSchema);
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test -- src/models/__tests__/merchantOperator.model.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/models/merchantOperator.model.ts src/interfaces/merchantOperator.interface.ts src/models/__tests__/merchantOperator.model.test.ts
git commit -m "feat(cashless): add MerchantOperator — a person on the till

A Merchant is a stall, and a stall should not hold credentials. This
is the person: own loginCode+PIN, immutable merchantId, attribution
only — no ledger account ever references it."
```

---

### Task 5: Move stall credentials to the operator

**Repo:** API

**Files:**
- Modify: `src/models/merchant.model.ts` — drop `applyOperatorCredentials` and `loginCode`
- Modify: `src/interfaces/merchant.interface.ts` — drop credential fields, extend `MerchantToken`
- Modify: `src/services/merchantAuth.service.ts` — look up `MerchantOperator`
- Modify: `src/utils/operatorCredentials.util.ts` — swap `Merchant` for `MerchantOperator` in the uniqueness check
- Test: `src/services/__tests__/merchantAuth.service.test.ts`

**Interfaces:**
- Consumes: `MerchantOperator` (Task 4), `normalizeLoginCode` (Task 1).
- Produces: `MerchantToken` gains `merchantOperatorId: string` and `operatorName: string`. `IMerchant` loses `loginCode`, `pin`, `failedPinAttempts`, `lockedUntil`, `lastLoginAt`, `comparePin`.

The population count does not change: `Merchant` leaves the uniqueness check as `MerchantOperator` enters it.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/merchantAuth.service.test.ts`:

```typescript
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantAuthService } from '@services/merchantAuth.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function seedStallWithOperator() {
  const eventId = new mongoose.Types.ObjectId();
  const stall = await Merchant.create({ name: 'Main Bar', eventId, commissionPercent: 10, status: 'active' });
  const op = new MerchantOperator({
    fullName: 'Thabo Dlamini', merchantId: stall._id, eventId, loginCode: '4KZ9P2', pin: '123456',
  });
  await op.save();
  return { stall, op, eventId };
}

it('mints a token naming both the stall and the person', async () => {
  const { stall, op } = await seedStallWithOperator();
  const result = await MerchantAuthService.login('4KZ9P2', '123456');
  const token = MerchantAuthService.verifyToken(result.accessToken);
  expect(token.merchantId).toBe((stall._id as any).toString());
  expect(token.merchantOperatorId).toBe((op._id as any).toString());
  expect(token.operatorName).toBe('Thabo Dlamini');
  expect(token.name).toBe('Main Bar');
});

it('refuses a deactivated operator without touching the stall', async () => {
  const { op } = await seedStallWithOperator();
  op.isActive = false;
  await op.save();
  await expect(MerchantAuthService.login('4KZ9P2', '123456')).rejects.toThrow('Invalid credentials');
});

it('creating a stall issues no login code at all', async () => {
  const stall = await Merchant.create({ name: 'Side Bar', eventId: new mongoose.Types.ObjectId(), status: 'active' });
  expect((stall as any).loginCode).toBeUndefined();
  expect((stall as any).pin).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- src/services/__tests__/merchantAuth.service.test.ts --runInBand
```

Expected: FAIL — `merchantOperatorId` undefined on the token, and `Merchant.create` rejects because `loginCode` and `pin` are still required.

- [ ] **Step 3: Strip credentials from the stall**

In `src/models/merchant.model.ts`, remove the `applyOperatorCredentials(merchantSchema)` call, its import, and the `loginCode` field. The schema keeps `name`, `eventId`, `commissionPercent`, `status`, its `toJSON`/`toObject` transforms and the `{ eventId: 1, status: 1 }` index. Update the block comment to say the stall holds identity and settlement while `MerchantOperator` holds credentials.

In `src/interfaces/merchant.interface.ts`, delete `loginCode`, `pin`, `failedPinAttempts`, `lockedUntil`, `lastLoginAt` and `comparePin` from `IMerchant`, then extend the token:

```typescript
/** JWT payload minted by MerchantAuthService.login and verified by authenticateMerchant. */
export interface MerchantToken {
  scope: 'merchant';
  /** The STALL — what money is owed to, and what charges are indexed by. */
  merchantId: string;
  /** The PERSON on the till — what each charge is attributed to. */
  merchantOperatorId: string;
  operatorName: string;
  eventId: string;
  /** The stall's display name. */
  name: string;
  eventName?: string;
  permissions: MerchantPermission[];
}
```

- [ ] **Step 4: Point the auth service at the operator**

In `src/services/merchantAuth.service.ts`, replace the `Merchant` import with `MerchantOperator`, keep the `Merchant` import for the stall lookup, and rewrite `login`:

```typescript
static async login(loginCode: string, pin: string) {
  if (typeof loginCode !== 'string' || typeof pin !== 'string') {
    throw new Error('Invalid credentials');
  }
  const operator = await MerchantOperator
    .findOne({ loginCode: normalizeLoginCode(loginCode), isActive: true })
    .select('+pin');
  if (!operator) throw new Error('Invalid credentials');

  if (operator.lockedUntil && operator.lockedUntil.getTime() > Date.now()) {
    throw new Error('Account locked. Try again later.');
  }

  const ok = await operator.comparePin(pin);
  if (!ok) {
    operator.failedPinAttempts = (operator.failedPinAttempts ?? 0) + 1;
    if (operator.failedPinAttempts >= MAX_PIN_ATTEMPTS) {
      operator.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      operator.failedPinAttempts = 0;
    }
    await operator.save();
    throw new Error('Invalid credentials');
  }

  // The stall must still be active — deactivating a stall must not leave its
  // people able to charge against it.
  const merchant = await Merchant.findOne({ _id: operator.merchantId, status: 'active' });
  if (!merchant) throw new Error('Invalid credentials');

  operator.failedPinAttempts = 0;
  operator.lockedUntil = null;
  operator.lastLoginAt = new Date();
  await operator.save();

  const event = await Event.findById(merchant.eventId).select('name').lean();

  const payload: MerchantToken = {
    scope: 'merchant',
    merchantId: (merchant._id as any).toString(),
    merchantOperatorId: (operator._id as any).toString(),
    operatorName: operator.fullName,
    eventId: merchant.eventId.toString(),
    name: merchant.name,
    ...(event?.name ? { eventName: event.name } : {}),
    permissions: [MerchantPermission.CHARGE],
  };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

  return {
    accessToken,
    operator: {
      merchantId: payload.merchantId,
      merchantOperatorId: payload.merchantOperatorId,
      operatorName: operator.fullName,
      name: merchant.name,
      eventId: payload.eventId,
      eventName: event?.name,
    },
  };
}
```

Add the import: `import { normalizeLoginCode } from '@utils/operatorCredentials.util';`

- [ ] **Step 5: Swap the population in the uniqueness check**

In `src/utils/operatorCredentials.util.ts`, replace the `Merchant` import with `MerchantOperator` and change that one line of the `Promise.all`:

```typescript
MerchantOperator.exists({ loginCode: code }),
```

- [ ] **Step 6: Reject tokens with no operator**

In `src/middleware/merchantAuth.middleware.ts`, after the token verifies, add:

```typescript
if (!decoded.merchantOperatorId) {
  ApiResponseUtil.unauthorized(res, 'Token predates per-person operators — sign in again');
  return;
}
```

Match the file's existing import of `ApiResponseUtil` and its established rejection style.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test -- src/services/__tests__/merchantAuth.service.test.ts src/utils/__tests__/operatorCredentials.util.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/models/merchant.model.ts src/interfaces/merchant.interface.ts src/services/merchantAuth.service.ts src/utils/operatorCredentials.util.ts src/middleware/merchantAuth.middleware.ts src/services/__tests__/merchantAuth.service.test.ts
git commit -m "feat(cashless): stalls stop holding credentials

Merchant keeps the stall's identity and settlement account;
MerchantOperator holds the login. The token now names both, so the
device still never chooses its own stall. Population count is
unchanged — Merchant leaves the uniqueness check as MerchantOperator
enters it. Tokens without an operator are rejected rather than
falling back to an anonymous charge."
```

---

### Task 6: Attribute every charge to the person

**Repo:** API

**Files:**
- Modify: `src/models/merchantCharge.model.ts`
- Modify: `src/services/merchant.service.ts:74-80,195-197,172`
- Modify: `src/controllers/merchant.controller.ts:38-60,162`
- Test: `src/services/__tests__/merchantCharge.attribution.test.ts`

**Interfaces:**
- Consumes: `MerchantToken` with `merchantOperatorId` + `operatorName` (Task 5).
- Produces: `IMerchantCharge` gains `merchantOperatorId: Types.ObjectId` (required); `staffName` becomes a required server-derived snapshot. `MerchantService.charge` params gain `merchantOperatorId: string` and `operatorName: string`, and lose the optional `staffName` input.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/merchantCharge.attribution.test.ts`:

```typescript
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { MerchantCharge } from '@models/merchantCharge.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const base = () => ({
  merchantId: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId(),
  walletId: new mongoose.Types.ObjectId(),
  bandUid: '04A2B3C4',
  amount: 5000, fee: 500, netAmount: 4500,
  clientTxnId: `chg-${Math.random()}`,
  status: 'completed' as const,
  staffName: 'Thabo Dlamini',
});

it('requires the operator who rang it up', async () => {
  await expect(new MerchantCharge(base()).save()).rejects.toThrow(/merchantOperatorId/);
});

it('stores the operator and the name snapshot together', async () => {
  const merchantOperatorId = new mongoose.Types.ObjectId();
  const charge = await new MerchantCharge({ ...base(), merchantOperatorId }).save();
  expect(charge.merchantOperatorId.toString()).toBe(merchantOperatorId.toString());
  expect(charge.staffName).toBe('Thabo Dlamini');
});
```

Then add the two invariants that matter most — that the body cannot forge a
name, and that settlement did not follow attribution onto the person. These go
in the **existing** `src/services/__tests__/merchantCharge.service.test.ts`,
which already runs on the transaction-capable `connectLedgerTestDb` harness and
already has local `seedFundedWallet()` and `seedMerchant()` helpers.

First fix `seedMerchant` in that file — it currently creates a Merchant with
`loginCode: String(__loginCodeSeq++), pin: '111111'`, which Task 5 removed from
the schema. Drop those two properties and add a sibling helper:

```typescript
async function seedOperatorFor(merchantId: string, eventId: string, fullName = 'Thabo Dlamini') {
  const op = new MerchantOperator({
    fullName, merchantId, eventId, loginCode: `4KZ9P${__loginCodeSeq++ % 10}`, pin: '111111',
  });
  await op.save();
  return String(op._id);
}
```

Then append:

```typescript
it('ignores a staffName supplied by the client', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 300, clientTxnId: 'chg-forge-1',
    // A stale POS may still send this; it must not reach the record.
    staffName: 'Somebody Else',
  } as any);

  const charge = await MerchantCharge.findOne({ clientTxnId: 'chg-forge-1' });
  expect(charge!.staffName).toBe('Thabo Dlamini');
  expect(charge!.merchantOperatorId.toString()).toBe(merchantOperatorId);
});

it('credits the STALL in the ledger, never the operator', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 10);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 300, clientTxnId: 'chg-ledger-1',
  });

  const entries = await LedgerEntry.find({ 'account.type': LedgerAccountType.MERCHANT });
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(String(entry.account.ref)).toBe(merchantId);
    expect(String(entry.account.ref)).not.toBe(merchantOperatorId);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- src/services/__tests__/merchantCharge.attribution.test.ts --runInBand
```

Expected: FAIL — the first test saves successfully because `merchantOperatorId` does not exist yet.

- [ ] **Step 3: Add the field to the model**

In `src/models/merchantCharge.model.ts`, add to the `IMerchantCharge` interface, directly under `merchantId`:

```typescript
  /** The PERSON who rang this up. Derived from the JWT, never from the body. */
  merchantOperatorId: Types.ObjectId;
```

Change `staffName?: string;` to:

```typescript
  /** Snapshot of the operator's name at sale time, so history survives a rename. */
  staffName: string;
```

In the schema, add under `merchantId`:

```typescript
  merchantOperatorId: { type: Schema.Types.ObjectId, required: true, index: true },
```

and change the `staffName` field to `{ type: String, required: true, trim: true }`.

- [ ] **Step 4: Thread it through the service**

In `src/services/merchant.service.ts`, in the `charge` params type (around line 74-80), replace `staffName?: string;` with:

```typescript
    merchantOperatorId: string;
    operatorName: string;
```

Update the destructure on line 80 to pull `merchantOperatorId` and `operatorName` instead of `staffName`.

In the `MerchantCharge.create` call (around line 195-197), replace `...(staffName ? { staffName } : {})` with:

```typescript
            merchantOperatorId, staffName: operatorName,
```

On line 172, the stock movement currently posts `byType: 'Merchant', by: merchantId`. Change to:

```typescript
              byType: 'Merchant', by: merchantOperatorId,
```

The `byType` enum value stays `'Merchant'` — `stockMovement.model.ts:42` allows only `'Organizer' | 'Merchant' | 'Platform'`, and the stall is still the right *category*; only the actor id becomes the person.

- [ ] **Step 5: Stop trusting the request body**

In `src/controllers/merchant.controller.ts`, change the destructure on line 39 to:

```typescript
      const { merchantId, eventId, merchantOperatorId, operatorName } = merchant;
```

Replace line 60's `...(value.staffName ? { staffName: value.staffName } : {})` with:

```typescript
        merchantOperatorId, operatorName,
```

Remove `staffName` from the request Joi/validation schema for this route so a client that still sends it gets a validation error rather than having it silently ignored — the POS is being changed in the same release.

On line 162, the stock-count call passes `byType: 'Merchant', by: merchantId`. Change `by` to `merchantOperatorId` and add it to that handler's destructure on line 157.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- src/services/__tests__/merchantCharge.attribution.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Run the full merchant suite for regressions**

```bash
npm test -- src/services/__tests__/ src/controllers/__tests__/ --runInBand
```

Expected: PASS. Existing merchant charge fixtures will need `merchantOperatorId` added — update them rather than relaxing the model.

- [ ] **Step 8: Commit**

```bash
git add src/models/merchantCharge.model.ts src/services/merchant.service.ts src/controllers/merchant.controller.ts src/services/__tests__/merchantCharge.attribution.test.ts
git commit -m "feat(cashless): attribute charges to the person, not the stall

staffName was an optional free-text string the POS sent from memory,
so 'how much did Thabo take?' was unanswerable. It is now a required
server-derived snapshot alongside a real merchantOperatorId, and the
client can no longer supply either. Ledger postings still credit the
stall — attribution moved, settlement did not."
```

---

### Task 7: Rename the wallet actor type

**Repo:** API

**Files:**
- Modify: `src/models/walletTopup.model.ts:20`
- Modify: `src/models/walletWithdrawal.model.ts:31`
- Modify: any caller passing `recordedByType: 'Merchant'` (find with grep)
- Test: `src/models/__tests__/walletActorType.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `recordedByType` enum value `'Merchant'` becomes `'MerchantOperator'` on both models.

- [ ] **Step 1: Find every caller**

```bash
grep -rn "recordedByType" src/ | grep -v "__tests__"
```

Note each call site — they all need updating in step 3.

- [ ] **Step 2: Write the failing test**

Create `src/models/__tests__/walletActorType.test.ts`:

```typescript
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { WalletTopup } from '@models/walletTopup.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const base = () => ({
  walletId: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId(),
  amount: 5000,
  method: 'cash' as const,
  status: 'completed' as const,
  recordedBy: new mongoose.Types.ObjectId().toString(),
  clientTxnId: `top-${Math.random()}`,
});

it('accepts MerchantOperator as an actor type', async () => {
  const row = await WalletTopup.create({ ...base(), recordedByType: 'MerchantOperator' });
  expect(row.recordedByType).toBe('MerchantOperator');
});

it('rejects the retired Merchant actor type', async () => {
  await expect(WalletTopup.create({ ...base(), recordedByType: 'Merchant' as any })).rejects.toThrow();
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm test -- src/models/__tests__/walletActorType.test.ts --runInBand
```

Expected: FAIL — `'MerchantOperator'` is not in the enum.

- [ ] **Step 4: Update both enums and every caller**

In `src/models/walletTopup.model.ts:20` and `src/models/walletWithdrawal.model.ts:31`, change the enum array from `['ResellerOperator', 'Cashier', 'Merchant', 'Platform']` to `['ResellerOperator', 'Cashier', 'MerchantOperator', 'Platform']` (preserving each file's own ordering and its `default`). Update the matching TypeScript union in each interface.

Then update every call site found in Step 1 that passes `'Merchant'` to pass `'MerchantOperator'`, and change the id it passes alongside from the stall to the operator.

- [ ] **Step 5: Run it to verify it passes**

```bash
npm test -- src/models/__tests__/walletActorType.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/models/walletTopup.model.ts src/models/walletWithdrawal.model.ts src/models/__tests__/walletActorType.test.ts src/services/
git commit -m "refactor(cashless): wallet actor type is MerchantOperator

A stall can no longer record anything — only a person can."
```

---

### Task 8: Stall operator admin endpoints

**Repo:** API

**Files:**
- Create: `src/controllers/merchantOperatorAdmin.controller.ts`
- Modify: `src/routes/tickets.route.ts:562` (add routes after the merchants block)
- Modify: `src/controllers/merchantAdmin.controller.ts:59,116` — stall create no longer mints a code; delete `resetPin`
- Test: `src/routes/__tests__/merchantOperatorAdmin.route.test.ts`

**Interfaces:**
- Consumes: `MerchantOperator` (Task 4), `generateUniqueLoginCode`, `generatePin` (Task 1).
- Produces: REST surface —
  - `GET /api/tickets/merchants/:merchantId/operators` → `{ operators: IMerchantOperator[] }`
  - `POST /api/tickets/merchants/:merchantId/operators` → `{ operator, loginCode, pin }` (credentials returned ONCE)
  - `PATCH /api/tickets/merchant-operators/:id` → `{ operator }` (accepts `fullName`, `isActive`)
  - `POST /api/tickets/merchant-operators/:id/reset-pin` → `{ operatorId, pin }`

- [ ] **Step 1: Write the failing test**

Create `src/routes/__tests__/merchantOperatorAdmin.route.test.ts`. Follow the existing setup in `src/routes/__tests__/resellerAdmin.route.test.ts` for building an authed super-admin agent:

```typescript
it('creating an operator returns the credentials exactly once', async () => {
  const res = await agent.post(`/api/tickets/merchants/${merchantId}/operators`).send({ fullName: 'Thabo Dlamini' });
  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  expect(res.body.data.pin).toMatch(/^\d{6}$/);
  expect(res.body.data.operator.pin).toBeUndefined();

  const list = await agent.get(`/api/tickets/merchants/${merchantId}/operators`);
  expect(list.body.data.operators[0].pin).toBeUndefined();
  expect(list.body.data.operators[0].loginCode).toBeTruthy();
});

it('inherits eventId from the stall rather than the body', async () => {
  const res = await agent
    .post(`/api/tickets/merchants/${merchantId}/operators`)
    .send({ fullName: 'Sipho', eventId: new mongoose.Types.ObjectId().toString() });
  expect(res.body.data.operator.eventId).toBe(stallEventId);
});

it('404s for a stall that does not exist', async () => {
  const res = await agent
    .post(`/api/tickets/merchants/${new mongoose.Types.ObjectId()}/operators`)
    .send({ fullName: 'Nobody' });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- src/routes/__tests__/merchantOperatorAdmin.route.test.ts --runInBand
```

Expected: FAIL with 404 on every route.

- [ ] **Step 3: Write the controller**

Create `src/controllers/merchantOperatorAdmin.controller.ts`, mirroring the structure of `src/controllers/cashierAdmin.controller.ts`:

```typescript
// api/src/controllers/merchantOperatorAdmin.controller.ts
import { Request, Response, NextFunction } from 'express';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Admin CRUD for the people on a stall's till. eventId is always inherited
 * from the stall — a body that supplies one is ignored, so an operator can
 * never be pointed at an event their stall does not belong to.
 */
export class MerchantOperatorAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operators = await MerchantOperator
        .find({ merchantId: req.params['merchantId'] })
        .sort({ createdAt: -1 });
      ApiResponseUtil.success(res, { operators });
    } catch (err) { next(err); }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['merchantId']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Stall not found'); return; }

      if (!req.body.fullName || typeof req.body.fullName !== 'string') {
        ApiResponseUtil.badRequest(res, 'fullName is required'); return;
      }

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();

      const operator = await MerchantOperator.create({
        fullName: req.body.fullName,
        phoneNumber: req.body.phoneNumber,
        merchantId: merchant._id,
        eventId: merchant.eventId,
        loginCode,
        pin,
      });
      // loginCode + pin are returned ONCE here (the pin is never serialized again).
      ApiResponseUtil.created(res, { operator, loginCode, pin });
    } catch (err) { next(err); }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await MerchantOperator.findById(req.params['id']);
      if (!operator) { ApiResponseUtil.notFound(res, 'Operator not found'); return; }
      if ('fullName' in req.body) operator.fullName = req.body.fullName;
      if ('isActive' in req.body) operator.isActive = !!req.body.isActive;
      await operator.save();
      ApiResponseUtil.success(res, { operator });
    } catch (err) { next(err); }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await MerchantOperator.findById(req.params['id']).select('+pin');
      if (!operator) { ApiResponseUtil.notFound(res, 'Operator not found'); return; }
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      operator.pin = pin;
      operator.failedPinAttempts = 0;
      operator.lockedUntil = null;
      await operator.save();
      ApiResponseUtil.success(res, { operatorId: (operator._id as any).toString(), pin });
    } catch (err) { next(err); }
  }
}
```

- [ ] **Step 4: Mount the routes**

In `src/routes/tickets.route.ts`, directly after line 562 (the merchants block), add:

```typescript
/**
 * The people on a stall's till. Same MANAGE_ACCESS gate as the stall itself.
 */
router.get('/merchants/:merchantId/operators', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantOperatorAdminController.list);
router.post('/merchants/:merchantId/operators', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantOperatorAdminController.create);
router.patch('/merchant-operators/:id', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantOperatorAdminController.update);
router.post('/merchant-operators/:id/reset-pin', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantOperatorAdminController.resetPin);
```

Add the import alongside the others at the top of the file.

- [ ] **Step 5: Stop minting stall credentials**

In `src/controllers/merchantAdmin.controller.ts`, remove `loginCode`/`pin` generation from `create` (line 59) so it no longer returns them, and delete the `resetPin` method (line 116) entirely. Remove the now-dead `router.post('/merchants/:id/reset-pin', ...)` line from `tickets.route.ts:562`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- src/routes/__tests__/merchantOperatorAdmin.route.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/merchantOperatorAdmin.controller.ts src/controllers/merchantAdmin.controller.ts src/routes/tickets.route.ts src/routes/__tests__/merchantOperatorAdmin.route.test.ts
git commit -m "feat(cashless): admin CRUD for the people on a stall

eventId is inherited from the stall, never read off the body, so an
operator cannot be pointed at an event their stall does not run.
Stall create no longer mints credentials."
```

---

### Task 9: Dashboard — people on a stall

**Repo:** Dashboard (`dashboard-eventstock-wt`)

**Files:**
- Modify: `src/lib/api.ts` — add the `merchantOperators` client
- Modify: the Stalls sub-tab component rendered by `src/components/EventCashlessTab.tsx:272`
- Create: `src/components/StallOperatorsPanel.tsx`

**Interfaces:**
- Consumes: the four routes from Task 8.
- Produces: `<StallOperatorsPanel merchantId={string} stallName={string} />`.

- [ ] **Step 1: Add the API client methods**

In `src/lib/api.ts`, alongside the existing `cashiers` client, add:

```typescript
  merchantOperators: {
    list: (merchantId: string) =>
      fetchApi<{ operators: MerchantOperator[] }>(`/api/tickets/merchants/${merchantId}/operators`),
    create: (merchantId: string, body: { fullName: string; phoneNumber?: string }) =>
      fetchApi<{ operator: MerchantOperator; loginCode: string; pin: string }>(
        `/api/tickets/merchants/${merchantId}/operators`, { method: 'POST', body: JSON.stringify(body) },
      ),
    update: (id: string, body: { fullName?: string; isActive?: boolean }) =>
      fetchApi<{ operator: MerchantOperator }>(`/api/tickets/merchant-operators/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    resetPin: (id: string) =>
      fetchApi<{ operatorId: string; pin: string }>(`/api/tickets/merchant-operators/${id}/reset-pin`, { method: 'POST' }),
  },
```

Add the matching type to `src/types/index.ts`:

```typescript
export interface MerchantOperator {
  _id: string;
  fullName: string;
  phoneNumber?: string;
  merchantId: string;
  eventId: string;
  loginCode: string;
  isActive: boolean;
  lastLoginAt?: string;
}
```

- [ ] **Step 2: Build the panel**

Create `src/components/StallOperatorsPanel.tsx`. `OperatorCredentialsDialog`
takes `{ open, onClose, title, loginCode?, pin, businessName?, hubName? }` —
reuse it rather than writing a second credentials surface, since it already
handles copy-to-clipboard and the show-once warning.

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OperatorCredentialsDialog } from '@/components/OperatorCredentialsDialog';

type Credentials = { title: string; loginCode?: string; pin: string };

export function StallOperatorsPanel({ merchantId, stallName }: { merchantId: string; stallName: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ fullName: '', phoneNumber: '' });
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['merchantOperators', merchantId],
    queryFn: () => apiClient.merchantOperators.list(merchantId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['merchantOperators', merchantId] });

  const create = useMutation({
    mutationFn: () => apiClient.merchantOperators.create(merchantId, {
      fullName: form.fullName.trim(),
      ...(form.phoneNumber.trim() ? { phoneNumber: form.phoneNumber.trim() } : {}),
    }),
    onSuccess: (res) => {
      setAdding(false);
      setForm({ fullName: '', phoneNumber: '' });
      setCredentials({ title: `${res.operator.fullName} — till login`, loginCode: res.loginCode, pin: res.pin });
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetPin = useMutation({
    mutationFn: (id: string) => apiClient.merchantOperators.resetPin(id),
    onSuccess: (res) => setCredentials({ title: 'New PIN', pin: res.pin }),
    onError: (e: Error) => toast.error(e.message),
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiClient.merchantOperators.update(id, { isActive }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const operators = data?.operators ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">People on this till</h3>
          <p className="text-sm text-muted-foreground">
            Everyone gets their own code, so each sale names who rang it up.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>Add person</Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && operators.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nobody can sell at this stall yet — add the first person.
        </p>
      )}

      <ul className="divide-y rounded-md border">
        {operators.map((op) => (
          <li key={op._id} className="flex items-center justify-between gap-4 p-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{op.fullName}</p>
              <p className="text-sm text-muted-foreground">
                {op.loginCode}
                {!op.isActive && ' · deactivated'}
                {op.lastLoginAt && ` · last in ${new Date(op.lastLoginAt).toLocaleString()}`}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" onClick={() => resetPin.mutate(op._id)}>
                Reset PIN
              </Button>
              <Button
                size="sm"
                variant={op.isActive ? 'outline' : 'default'}
                onClick={() => setActive.mutate({ id: op._id, isActive: !op.isActive })}
              >
                {op.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={adding} onOpenChange={(v) => !v && setAdding(false)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add someone to {stallName}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="op-name">Full name</Label>
              <Input
                id="op-name" className="h-12" value={form.fullName}
                onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="op-phone">Phone (optional)</Label>
              <Input
                id="op-phone" className="h-12" value={form.phoneNumber}
                onChange={(e) => setForm((f) => ({ ...f, phoneNumber: e.target.value }))}
              />
            </div>
            <Button
              className="w-full" disabled={!form.fullName.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Adding…' : 'Add person'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <OperatorCredentialsDialog
        open={!!credentials}
        onClose={() => setCredentials(null)}
        title={credentials?.title ?? ''}
        loginCode={credentials?.loginCode}
        pin={credentials?.pin ?? ''}
        businessName={stallName}
      />
    </div>
  );
}
```

- [ ] **Step 3: Mount it under the stall**

In the Stalls sub-tab (rendered at `EventCashlessTab.tsx:272`), add a per-stall expand or detail view that renders `<StallOperatorsPanel merchantId={stall._id} stallName={stall.name} />`. Remove any surviving "reset PIN" / login-code UI attached to the stall itself — stalls no longer have credentials.

- [ ] **Step 4: Verify the build**

```bash
npm run build
```

Expected: clean. `tsc --noEmit` is not sufficient here — it misses `noUnusedLocals`, which fails the Pages build.

- [ ] **Step 5: Commit**

```bash
git add src/components/StallOperatorsPanel.tsx src/lib/api.ts src/types/index.ts src/components/EventCashlessTab.tsx
git commit -m "feat(cashless): manage the people on each stall

Stalls lose their own credentials UI; each stall now lists its people,
issuing a login code and PIN once per person."
```

---

### Task 10: POS drops the free-text staff name

**Repo:** POS (`pos-app-cashier-wt`)

**Files:**
- Modify: `lib/pages/charge_page.dart:45,172`
- Modify: `lib/api.dart:857-882`

**Interfaces:**
- Consumes: the token from Task 5, which now carries `operatorName`.
- Produces: nothing.

- [ ] **Step 1: Remove the parameter from the API client**

In `lib/api.dart`, delete the `String? staffName` parameter from `MerchantApi.charge` (line 868) and the `if (staffName != null && staffName.isNotEmpty) 'staffName': staffName,` line from the request body (line 882). Update the doc comment on line 857 to say the server derives the operator from the token.

- [ ] **Step 2: Remove it from the charge page**

In `lib/pages/charge_page.dart`, delete the `_staffName` field (line 45), its two call-site arguments (line 172 and the sibling non-basket branch), and whatever input widget sets it. Show the operator's name from the login session in the till header instead, so the person on the device can see who they are logged in as.

- [ ] **Step 3: Verify it compiles**

```bash
flutter analyze lib/
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/api.dart lib/pages/charge_page.dart
git commit -m "feat(pos): stop sending a typed staff name

The till is bound to a person now — the server takes the name off the
authenticated operator. Shift change is a logout/login."
```

---

## Track 3 — Event-scoped cashiers

### Task 11: Cashier gains an owning event

**Repo:** API

**Files:**
- Modify: `src/models/cashier.model.ts`
- Modify: `src/interfaces/cashier.interface.ts`
- Test: `src/models/__tests__/cashier.eventScope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ICashier` gains `eventId?: Types.ObjectId` and loses `eventIds`. `CashierToken` gains `eventId?: string`.

- [ ] **Step 1: Write the failing test**

Create `src/models/__tests__/cashier.eventScope.test.ts`:

```typescript
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Cashier } from '@models/cashier.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const organizer = () => ({
  fullName: 'Nomsa', loginCode: `4KZ9${Math.floor(Math.random() * 90) + 10}`, pin: '123456',
  scope: 'organizer' as const, vendorId: new mongoose.Types.ObjectId(),
});

it('requires an event for an organizer cashier', async () => {
  await expect(new Cashier(organizer()).save()).rejects.toThrow(/eventId/);
});

it('allows a platform cashier with no event', async () => {
  const c = await new Cashier({
    fullName: 'Carrot Staff', loginCode: '9Z9Z91', pin: '123456', scope: 'platform',
  }).save();
  expect(c.eventId).toBeUndefined();
});

it('refuses to move a cashier to another event', async () => {
  const eventId = new mongoose.Types.ObjectId();
  const c = await new Cashier({ ...organizer(), eventId }).save();
  c.eventId = new mongoose.Types.ObjectId();
  await c.save();
  const reloaded = await Cashier.findById(c._id);
  expect(reloaded!.eventId!.toString()).toBe(eventId.toString());
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- src/models/__tests__/cashier.eventScope.test.ts --runInBand
```

Expected: FAIL — the organizer cashier saves without an event.

- [ ] **Step 3: Implement**

In `src/models/cashier.model.ts`, remove the `applyOperatorEventScope(cashierSchema)` call and its import, then add to the schema body:

```typescript
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    index: true,
    immutable: true,
    // Organizer cashiers are hired for ONE event and end with it. Platform
    // cashiers are Carrot's own staff and are legitimately global.
    required: function (this: { scope?: string }) { return this.scope === 'organizer'; },
  },
```

Add the index below the existing one:

```typescript
cashierSchema.index({ eventId: 1, isActive: 1 });
```

In `src/interfaces/cashier.interface.ts`, replace the `eventIds` field with:

```typescript
  /** The single event this cashier works. Unset only for platform scope. */
  eventId?: Types.ObjectId;
```

and add `eventId?: string;` to `CashierToken`, documented as absent for platform-scoped cashiers. Mint it in `cashierAuth.service.ts` alongside `vendorId`.

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test -- src/models/__tests__/cashier.eventScope.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/cashier.model.ts src/interfaces/cashier.interface.ts src/models/__tests__/cashier.eventScope.test.ts
git commit -m "feat(cashless): a cashier belongs to one event

Replaces the eventIds set for this population. Platform-scoped
cashiers are Carrot's own staff and stay global — they are now the
only global cashier."
```

---

### Task 12: Cashier admin takes a single event

**Repo:** API

**Files:**
- Modify: `src/controllers/cashierAdmin.controller.ts:52-60,86-90`
- Modify: `src/services/operatorEventScope.service.ts` — leave `validateEventAssignment` intact for gate/reseller
- Test: `src/routes/__tests__/cashierAdmin.route.test.ts`

**Interfaces:**
- Consumes: `validateEventAssignment(raw: unknown, vendorId: string | undefined): Promise<EventAssignmentResult>` — called with a one-element array.
- Produces: `POST /api/tickets/cashiers` accepts `eventId: string` (required for organizer scope). `PATCH /api/tickets/cashiers/:id` no longer accepts `eventIds`.

There is no separate `setEvents` route to delete — the dashboard's `setEvents` maps onto `PATCH /cashiers/:id` with `eventIds` in the body. Removing that branch from `update` retires it.

- [ ] **Step 1: Write the failing test**

Add to `src/routes/__tests__/cashierAdmin.route.test.ts` (create it following `resellerAdmin.route.test.ts` if absent):

```typescript
it('requires an eventId for an organizer cashier', async () => {
  const res = await agent.post('/api/tickets/cashiers').send({ fullName: 'Nomsa' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/eventId/i);
});

it('rejects an event belonging to another organizer', async () => {
  const res = await agent.post('/api/tickets/cashiers').send({ fullName: 'Nomsa', eventId: otherVendorEventId });
  expect(res.status).toBe(400);
});

it('ignores eventIds on update', async () => {
  const created = await agent.post('/api/tickets/cashiers').send({ fullName: 'Nomsa', eventId: myEventId });
  const id = created.body.data.cashier._id;
  await agent.patch(`/api/tickets/cashiers/${id}`).send({ eventIds: [otherVendorEventId] });
  const reloaded = await Cashier.findById(id);
  expect(reloaded!.eventId!.toString()).toBe(myEventId);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- src/routes/__tests__/cashierAdmin.route.test.ts --runInBand
```

Expected: FAIL — create succeeds without an event.

- [ ] **Step 3: Implement create**

In `src/controllers/cashierAdmin.controller.ts`, replace the `validateEventAssignment` block (around line 52) with:

```typescript
      // Organizer cashiers are hired for ONE event; platform cashiers are
      // global and take none.
      let eventId: string | undefined;
      if (scope === 'organizer') {
        if (!req.body.eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return; }
        // Validated against the cashier's OWN vendor, not the caller's — a
        // super-admin creating staff for an organizer is still held to that
        // organizer's catalogue.
        const assignment = await validateEventAssignment([req.body.eventId], vendorId);
        if (!assignment.ok) { ApiResponseUtil.badRequest(res, assignment.message); return; }
        eventId = String(assignment.eventIds[0]);
      }
```

Change the `Cashier.create` call to pass `eventId` in place of `eventIds: assignment.eventIds`.

- [ ] **Step 4: Implement update**

Delete the entire `if ('eventIds' in req.body) { ... }` block from `update` (around line 86-90). `eventId` is immutable at the schema level, so a body carrying one is silently ignored — which is what the third test asserts.

- [ ] **Step 5: Filter the list by event**

The Cashiers panel renders inside one event, so `list` must scope to it.
In `src/controllers/cashierAdmin.controller.ts`, change `list` (line 22-26) to:

```typescript
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // The dashboard panel lives inside one event; the super-admin platform
      // page passes no eventId and still sees the unscoped list.
      const eventId = req.query['eventId'] ? String(req.query['eventId']) : undefined;
      const filter = { ...scopeFilter(req), ...(eventId ? { eventId } : {}) };
      const cashiers = await Cashier.find(filter).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, cashiers);
    } catch (err) { next(err); }
  }
```

Add the covering test to the same file as Step 1:

```typescript
it('filters the list to one event', async () => {
  await agent.post('/api/tickets/cashiers').send({ fullName: 'Nomsa', eventId: myEventId });
  await agent.post('/api/tickets/cashiers').send({ fullName: 'Sipho', eventId: mySecondEventId });

  const res = await agent.get(`/api/tickets/cashiers?eventId=${myEventId}`);
  expect(res.body.data).toHaveLength(1);
  expect(res.body.data[0].fullName).toBe('Nomsa');
});
```

- [ ] **Step 6: Run it to verify it passes**

```bash
npm test -- src/routes/__tests__/cashierAdmin.route.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Run the full API suite**

```bash
npm test -- --runInBand
```

Expected: PASS. Fixtures creating organizer cashiers need an `eventId`; update them rather than relaxing the model.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/cashierAdmin.controller.ts src/routes/__tests__/cashierAdmin.route.test.ts
git commit -m "feat(cashless): cashier admin takes one event

Create requires eventId for organizer scope and validates it against
the cashier's own vendor. Update drops its eventIds branch — the
field is immutable, so reassignment means a new cashier."
```

---

### Task 13: Dashboard — cashiers move inside the event

**Repo:** Dashboard (`dashboard-eventstock-wt`)

**Files:**
- Modify: `src/components/layout/Sidebar.tsx:125-130`
- Modify: `src/components/EventCashlessTab.tsx:262-277`
- Modify: `src/pages/CashiersPage.tsx`
- Modify: `src/lib/api.ts` — drop `cashiers.setEvents`

**Interfaces:**
- Consumes: `POST /api/tickets/cashiers` with `eventId` (Task 12).
- Produces: `<CashiersPanel eventId={string} />`.

- [ ] **Step 1: Narrow the sidebar entry**

In `src/components/layout/Sidebar.tsx`, change the `Cashiers` item's `show` from `canManageAccess(user)` to super-admin only:

```typescript
    {
      name: 'Cashiers',
      href: '/cashiers',
      icon: Banknote,
      // Organizer cashiers live inside their event; this entry is now only
      // Carrot's own platform-scoped staff.
      show: !!user?.isSuperAdmin,
    },
```

- [ ] **Step 2: Add the sub-tab**

In `src/components/EventCashlessTab.tsx`, add a fifth trigger after `catalogue` (line 265) and its content block after line 277:

```tsx
        {showCashiers && <TabsTrigger value="cashiers">Cashiers</TabsTrigger>}
```

```tsx
        {showCashiers && (
          <TabsContent value="cashiers">
            <CashiersPanel eventId={eventId} />
          </TabsContent>
        )}
```

Gate `showCashiers` on the same permission the sidebar entry used before this change (`canManageAccess`), matching how `showStalls` and `showCatalogue` are derived in that file.

- [ ] **Step 3: Split the page into a panel**

Move the list + add-dialog body of `src/pages/CashiersPage.tsx` into a new
`src/components/CashiersPanel.tsx` taking `{ eventId }`. Four concrete edits
against the current file:

1. Delete the `EventPicker` import (line 18) and the `<EventPicker …>` block
   (lines 150-152) — the event now comes from the prop.
2. Change the form type and its default (lines 24-25):

```typescript
type AddForm = { fullName: string; phoneNumber: string };
const DEFAULT_FORM: AddForm = { fullName: '', phoneNumber: '' };
```

3. Change the create body (line 46) from the spread of `eventIds` to the
   single event, and pass no `scope`/`vendorId` — an organizer creating from
   inside their own event needs neither:

```typescript
        eventId,
```

4. Delete the `setEvents` mutation (line 79), the assignment column that
   renders `"{n} assigned"` / `"All events"` (line 223), and the
   `editingEvents` dialog block (lines 256-258).

Then reduce `src/pages/CashiersPage.tsx` to the super-admin platform branch
only: `scope` fixed to `'platform'`, no event, no vendor, no `EventPicker`.
It renders at `/cashiers`, which after Step 1 only super-admins can reach.

- [ ] **Step 4: Drop the retired client method**

In `src/lib/api.ts`, delete `cashiers.setEvents`.

- [ ] **Step 5: Verify the build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/Sidebar.tsx src/components/EventCashlessTab.tsx src/components/CashiersPanel.tsx src/pages/CashiersPage.tsx src/lib/api.ts
git commit -m "feat(cashless): organizer cashiers live inside their event

Cashiers joins Money/Stock/Stalls/Catalogue as a sub-tab. The sidebar
entry narrows to super-admins for platform-scoped staff, which is now
the only global cashier."
```

---

## Final verification

- [ ] **API suite green**

```bash
npm test -- --runInBand
```

- [ ] **Dashboard builds**

```bash
npm run build
```

- [ ] **POS analyzes clean**

```bash
flutter analyze lib/
```

- [ ] **Manual smoke on dev**

1. Create a stall, add two people to it, note both login codes.
2. Log the POS in as person A, charge a band, log out, log in as person B, charge again.
3. Confirm the event's Cashless > Money report shows the two charges attributed to different names.
4. Deactivate person A; confirm A cannot log in and B still can.
5. Create a cashier from Event > Cashless > Cashiers; confirm the organizer sidebar has no Cashiers entry.
