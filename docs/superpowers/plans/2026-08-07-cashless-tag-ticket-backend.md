# Cashless Slice 1 — Backend (Tag Registration + Tag = Ticket) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the backend for cashless tag registration — reseller-side sell-band + cash top-up, tickets/gate-side wallet-by-band read + gate check-in by band — on top of the already-built ledger/wallet/binding, all gated by a new `event.cashless` flag.

**Architecture:** Two auth systems are honored (spec §5.0): sell-band and cash top-up are **reseller-authenticated** (`/api/reseller/*`, `ResellerPermission`); wallet-by-band read and gate-by-band check-in are **tickets/gate-authenticated** (`/api/tickets/*`, `TicketsPermission.SCAN_TICKETS`). New money movements reuse the built `LedgerService.post` (balanced, debit-positive) and an atomic aggregation-pipeline wallet credit. Everything is inert unless the event is `cashless`.

**Tech Stack:** Node/TypeScript, Express, Mongoose, Joi, Jest + supertest, `mongodb-memory-server` (standalone `connectTestDb`; 1-node replica set `connectLedgerTestDb` for transactions).

**Spec:** `docs/superpowers/specs/2026-08-07-cashless-tag-ticket-registration-design.md`. Parent: `.../2026-07-16-carrot-cashless-system-design.md`.

## Global Constraints

- **Currency:** ZAR, **integer minor units (cents)** everywhere. No floats for money.
- **Fail loudly:** every money endpoint surfaces failure as a non-2xx with a real reason. **No canned-success fallback.** Genuine server faults → 5xx (money-path alerting); client/validation/business rejections → 4xx.
- **`event.cashless` gates everything:** every band/wallet endpoint rejects (400) when the event is not `cashless`. Some events are cashless, most are not.
- **Band UID:** lowercased hex, no separators, **≥ 14 hex chars (7-byte NTAG)**. Shorter UIDs are rejected. Store exactly as normalized.
- **Ledger sign convention:** debit-positive — `delta > 0` debit, `delta < 0` credit. `float` is debit-normal (asset); `wallet`/`merchant`/`fees` credit-normal.
- **Transactions:** anything that calls `LedgerService.post` or `WalletService.topUpCash` must run against `connectLedgerTestDb` (replica set) in tests — `post()` throws unless its session `inTransaction()`.
- **JWT for tests:** `JWT_SECRET` from `@config/jwt.config`. Reseller token shape: `{ scope:'reseller', resellerId, hubId, operatorId, role, permissions: ResellerPermission[] }`. Tickets token shape: `{ app:'tickets', userType, vendorId, permissions: TicketsPermission[], isSuperAdmin? }`.
- **Reuse:** `ApiResponseUtil` for all responses; Joi schemas in `src/validators/`; `requireResellerPermission` / `requireTicketsPermission` middleware; the built `WalletService` / `ScanService` / `LedgerService`.
- **Base:** all work happens on the slice-1 branch created in Task 0 (off the rebased `feat/cashless-system`). Paths below are relative to the `api/` repo root.

---

## File Structure

**Create:**
- `src/models/walletTopup.model.ts` — the cash top-up record (idempotency + audit).
- `src/utils/bandUid.util.ts` — `normalizeBandUid` / `assertValidBandUid` (shared by sell-band + bind).
- `src/validators/reseller.validator.ts` — Joi schemas for the two new reseller endpoints (only if one doesn't already exist; else extend).
- test files alongside each new/changed unit under the matching `__tests__/` dir.

**Modify:**
- `src/interfaces/event.interface.ts` + `src/models/event.model.ts` — add `cashless`.
- `src/interfaces/resellerPermission.interface.ts` — add `CASH_TOPUP` + role map.
- `src/services/wallet.service.ts` — add `topUpCash`.
- `src/controllers/reseller.controller.ts` + `src/routes/reseller.route.ts` — `cashTopup`, `sellBand`.
- `src/controllers/tickets.controller.ts` + `src/routes/tickets.route.ts` — `walletByBand`, extend `checkInTicket`.
- `src/validators/tickets.validator.ts` — tighten `bindBandSchema`/`reissueBandSchema`; add `bandUid` to `checkInTicketSchema`.

---

## Task 0: Integration — rebase the built cashless backend onto `main`

**Files:** none new; git + repo state only.

- [ ] **Step 1: Snapshot state**

```bash
cd api
git fetch origin
git log --oneline -1 origin/main
git log --oneline -1 feat/cashless-system
git worktree list
```
Expected: `feat/cashless-system` exists; a worktree at `api/.claude/worktrees/cashless`.

- [ ] **Step 2: Create the slice-1 working branch off the built base**

```bash
git worktree add api/.claude/worktrees/cashless-slice1 feat/cashless-system
cd api/.claude/worktrees/cashless-slice1
git checkout -b feat/cashless-tag-ticket
```

- [ ] **Step 3: Rebase onto current main**

```bash
git rebase origin/main
```
Expected conflict: **only** `src/models/vendor.model.ts` (SP1 removed duplicate index declarations; main added operator-type/logo work). Resolve by keeping main's operator-type/logo fields AND SP1's de-duplicated indexes (no duplicate `index:true` + `schema.index` on the same field). Then `git add src/models/vendor.model.ts && git rebase --continue`.

- [ ] **Step 4: Install + verify the suite is green on the rebased base**

```bash
npm ci
npx jest --maxWorkers=4
```
Expected: PASS (799+ tests). The full-worker run (`npx jest`) is flaky from mongod startup contention — `--maxWorkers=4` is the reliable gate. If red, stop and triage before writing any slice-1 code.

- [ ] **Step 5: Commit the spec + both plans into the repo (they were untracked at project root)**

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp ../../../../docs/superpowers/specs/2026-08-07-cashless-tag-ticket-registration-design.md docs/superpowers/specs/
cp ../../../../docs/superpowers/plans/2026-08-07-cashless-tag-ticket-backend.md docs/superpowers/plans/
cp ../../../../docs/superpowers/plans/2026-08-07-cashless-tag-ticket-pos-app.md docs/superpowers/plans/
git add docs/superpowers/specs docs/superpowers/plans src/models/vendor.model.ts
git commit -m "chore(cashless): rebase onto main + track slice-1 spec/plans"
```
Expected: clean commit; `git status` clean.

---

## Task 1: `event.cashless` flag

**Files:**
- Modify: `src/interfaces/event.interface.ts` (add to `IEvent`)
- Modify: `src/models/event.model.ts` (near `isMultiDay`, ~:88)
- Modify: `src/controllers/reseller.controller.ts` (`getEvents` — ensure `cashless` is in the response)
- Test: `src/models/__tests__/event.cashless.model.test.ts`

**Interfaces:**
- Produces: `IEvent.cashless: boolean` (default `false`); event API responses include `cashless`.

- [ ] **Step 1: Write the failing test**

```ts
// src/models/__tests__/event.cashless.model.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('defaults cashless to false and is settable to true', async () => {
  const { eventId } = await seedPublishedEvent({});
  const before = await Event.findById(eventId).lean();
  expect(before!.cashless).toBe(false);

  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const after = await Event.findById(eventId).lean();
  expect(after!.cashless).toBe(true);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Run: npx jest event.cashless.model -v` → `cashless` is `undefined`).

- [ ] **Step 3: Add the field**

In `src/interfaces/event.interface.ts`, add to `IEvent`:
```ts
cashless: boolean;
```
In `src/models/event.model.ts`, in the top-level event schema next to `isMultiDay`:
```ts
cashless: { type: Boolean, default: false },
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Surface `cashless` in the reseller events response**

Open `ResellerController.getEvents` in `src/controllers/reseller.controller.ts`. If it returns full event docs, `cashless` is already present — confirm by reading the projection. If it maps to a hand-built DTO, add `cashless: event.cashless` to each mapped item. (The POS-app plan relies on this field being in the list response.)

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/event.interface.ts src/models/event.model.ts src/controllers/reseller.controller.ts src/models/__tests__/event.cashless.model.test.ts
git commit -m "feat(cashless): add Event.cashless flag, surface in reseller events"
```

---

## Task 2: `ResellerPermission.CASH_TOPUP`

**Files:**
- Modify: `src/interfaces/resellerPermission.interface.ts` (enum + `RESELLER_ROLE_PERMISSIONS`)
- Test: `src/interfaces/__tests__/resellerPermission.cashtopup.test.ts`

**Interfaces:**
- Produces: `ResellerPermission.CASH_TOPUP = 'reseller:cash_topup'`; granted to `OPERATOR`, `HUB_MANAGER`, `ADMIN`.

- [ ] **Step 1: Write the failing test**

```ts
// src/interfaces/__tests__/resellerPermission.cashtopup.test.ts
import { ResellerPermission, ResellerRole, RESELLER_ROLE_PERMISSIONS } from '@interfaces/resellerPermission.interface';

it('CASH_TOPUP exists and OPERATOR role has it', () => {
  expect(ResellerPermission.CASH_TOPUP).toBe('reseller:cash_topup');
  expect(RESELLER_ROLE_PERMISSIONS[ResellerRole.OPERATOR]).toContain(ResellerPermission.CASH_TOPUP);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`CASH_TOPUP` undefined).

- [ ] **Step 3: Add the enum member + grant it**

In `src/interfaces/resellerPermission.interface.ts`, add to the enum:
```ts
  CASH_TOPUP = 'reseller:cash_topup',
```
Add `ResellerPermission.CASH_TOPUP` to the `HUB_MANAGER` and `OPERATOR` arrays in `RESELLER_ROLE_PERMISSIONS` (`ADMIN` already gets it via `Object.values`).

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/resellerPermission.interface.ts src/interfaces/__tests__/resellerPermission.cashtopup.test.ts
git commit -m "feat(cashless): add reseller:cash_topup permission"
```

---

## Task 3: Band UID normalize + validate util; tighten bind schemas

**Files:**
- Create: `src/utils/bandUid.util.ts`
- Test: `src/utils/__tests__/bandUid.util.test.ts`
- Modify: `src/validators/tickets.validator.ts` (`bindBandSchema`, `reissueBandSchema`)

**Interfaces:**
- Produces: `normalizeBandUid(raw: string): string` (lowercased hex, stripped of `:`/spaces); `assertValidBandUid(raw: string): string` (returns normalized or throws `Error('invalid band uid: must be at least 7 bytes (14 hex chars)')`).

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/__tests__/bandUid.util.test.ts
import { normalizeBandUid, assertValidBandUid } from '@utils/bandUid.util';

it('normalizes case and separators', () => {
  expect(normalizeBandUid('04:A2:2B:1C:3D:4E:5F')).toBe('04a22b1c3d4e5f');
  expect(normalizeBandUid('04A22B1C3D4E5F')).toBe('04a22b1c3d4e5f');
});
it('accepts a 7-byte (14 hex) uid', () => {
  expect(assertValidBandUid('04a22b1c3d4e5f')).toBe('04a22b1c3d4e5f');
});
it('rejects a 4-byte (8 hex) uid and non-hex', () => {
  expect(() => assertValidBandUid('04a22b1c')).toThrow(/at least 7 bytes/);
  expect(() => assertValidBandUid('zzzz')).toThrow(/hex/i);
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found).

- [ ] **Step 3: Implement**

```ts
// src/utils/bandUid.util.ts
export function normalizeBandUid(raw: string): string {
  return String(raw ?? '').replace(/[\s:]/g, '').toLowerCase();
}
export function assertValidBandUid(raw: string): string {
  const uid = normalizeBandUid(raw);
  if (!/^[0-9a-f]+$/.test(uid)) throw new Error('invalid band uid: must be hex');
  if (uid.length < 14) throw new Error('invalid band uid: must be at least 7 bytes (14 hex chars)');
  return uid;
}
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Tighten the built bind schemas to require 14-hex**

In `src/validators/tickets.validator.ts`, change `bindBandSchema.bandUid` and `reissueBandSchema.newBandUid` from `.min(4)` to a 14-hex pattern:
```ts
bandUid: Joi.string().trim().lowercase().pattern(/^[0-9a-f]{14,}$/).required(),
```
(The built endpoint isn't in prod, so tightening it now is safe — no backward-compat concern.)

- [ ] **Step 6: Run the bind-band suite — expect PASS** (`npx jest scanBindBand -v`; update any built test fixture using a short UID like `'BAND0001'` to a 14-hex value such as `'04a22b1c3d4e5f'`).

- [ ] **Step 7: Commit**

```bash
git add src/utils/bandUid.util.ts src/utils/__tests__/bandUid.util.test.ts src/validators/tickets.validator.ts src/services/__tests__/scanBindBand.service.test.ts
git commit -m "feat(cashless): 7-byte band-uid normalize+validate; tighten bind schemas"
```

---

## Task 4: `WalletTopup` model (cash-only)

**Files:**
- Create: `src/models/walletTopup.model.ts`
- Test: `src/models/__tests__/walletTopup.model.test.ts`

**Interfaces:**
- Produces: `WalletTopup` model + `IWalletTopup` `{ walletId, eventId, amount, method:'cash', status:'completed', recordedBy, clientTxnId (unique), createdAt }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/models/__tests__/walletTopup.model.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletTopup } from '@models/walletTopup.model';
import mongoose from 'mongoose';

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

const base = () => ({
  walletId: new mongoose.Types.ObjectId(), eventId: new mongoose.Types.ObjectId(),
  amount: 500, method: 'cash', status: 'completed', recordedBy: 'op1', clientTxnId: 'ctx-1',
});

it('persists a cash topup and enforces unique clientTxnId', async () => {
  await WalletTopup.create(base());
  await expect(WalletTopup.create(base())).rejects.toThrow(/duplicate key|E11000/);
});
it('rejects a non-positive or non-integer amount', async () => {
  await expect(WalletTopup.create({ ...base(), clientTxnId: 'ctx-2', amount: 0 })).rejects.toThrow();
  await expect(WalletTopup.create({ ...base(), clientTxnId: 'ctx-3', amount: 1.5 })).rejects.toThrow();
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found).

- [ ] **Step 3: Implement (mirror `bandBinding.model.ts` style: `timestamps:{createdAt:true,updatedAt:false}`)**

```ts
// src/models/walletTopup.model.ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IWalletTopup extends Document {
  walletId: Types.ObjectId; eventId: Types.ObjectId; amount: number;
  method: 'cash'; status: 'completed'; recordedBy: string; clientTxnId: string; createdAt: Date;
}
const walletTopupSchema = new Schema<IWalletTopup>({
  walletId: { type: Schema.Types.ObjectId, required: true, index: true },
  eventId: { type: Schema.Types.ObjectId, required: true, index: true },
  amount: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'amount must be integer cents' } },
  method: { type: String, enum: ['cash'], required: true },
  status: { type: String, enum: ['completed'], required: true, default: 'completed' },
  recordedBy: { type: String, required: true },
  clientTxnId: { type: String, required: true, unique: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

export const WalletTopup = model<IWalletTopup>('WalletTopup', walletTopupSchema);
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/models/walletTopup.model.ts src/models/__tests__/walletTopup.model.test.ts
git commit -m "feat(cashless): WalletTopup model (cash-only, idempotent)"
```

---

## Task 5: `WalletService.topUpCash`

**Files:**
- Modify: `src/services/wallet.service.ts`
- Test: `src/services/__tests__/walletTopUpCash.service.test.ts`

**Interfaces:**
- Consumes: `LedgerService.post`, `LedgerAccountType.{FLOAT,WALLET}`, `FloatTag.CASH_DESK`, `WalletTopup`.
- Produces: `WalletService.topUpCash(params: { walletId: string; eventId: string; amount: number; recordedBy: string; clientTxnId: string }): Promise<{ wallet: IWallet; topup: IWalletTopup }>` — throws on non-active wallet / invalid amount; idempotent on `clientTxnId`.

- [ ] **Step 1: Write the failing test (replica set — ledger transaction)**

```ts
// src/services/__tests__/walletTopUpCash.service.test.ts
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService } from '@services/wallet.service';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';
import { Wallet } from '@models/wallet.model';
import { WalletTopup } from '@models/walletTopup.model';
import mongoose from 'mongoose';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedActiveWallet() {
  const eventId = new mongoose.Types.ObjectId();
  const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), status: 'active' });
  return { eventId: String(eventId), walletId: String(w._id) };
}

it('credits balance + cashFundedBalance and posts a balanced ledger txn', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  const { wallet, topup } = await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'ctx-1' });

  expect(wallet.balance).toBe(500);
  expect(wallet.cashFundedBalance).toBe(500);
  expect(topup.amount).toBe(500);

  const floatBal = await LedgerService.floatBalance(eventId);   // asset, +500
  const owed = await LedgerService.accountBalance({ type: LedgerAccountType.WALLET, ref: walletId });
  expect(floatBal).toBe(500);
  expect(-owed).toBe(500); // owed to wallet = 500
});

it('is idempotent on clientTxnId (no double credit)', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'dup' });
  await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'dup' });
  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(500);
  expect(await WalletTopup.countDocuments({ clientTxnId: 'dup' })).toBe(1);
});

it('throws on a non-active wallet', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  await Wallet.updateOne({ _id: walletId }, { $set: { status: 'frozen' } });
  await expect(WalletService.topUpCash({ walletId, eventId, amount: 100, recordedBy: 'op1', clientTxnId: 'x' }))
    .rejects.toThrow(/not active|not found/);
});
```
> Confirm the read-helper names in `ledger.service.ts` (`floatBalance`, `accountBalance`) — they exist per SP1 Task 4; adjust the calls if the signatures differ.

- [ ] **Step 2: Run it — expect FAIL** (`topUpCash` undefined).

- [ ] **Step 3: Implement `topUpCash`**

```ts
// in src/services/wallet.service.ts (imports at top)
import mongoose from 'mongoose';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';
import { WalletTopup, IWalletTopup } from '@models/walletTopup.model';

static async topUpCash(params: {
  walletId: string; eventId: string; amount: number; recordedBy: string; clientTxnId: string;
}): Promise<{ wallet: IWallet; topup: IWalletTopup }> {
  const { walletId, eventId, amount, recordedBy, clientTxnId } = params;
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer (cents)');

  // Idempotency: if this clientTxnId already ran, return the existing outcome.
  const existing = await WalletTopup.findOne({ clientTxnId });
  if (existing) {
    const w = await Wallet.findById(existing.walletId);
    if (!w) throw new Error('wallet not found');
    return { wallet: w, topup: existing };
  }

  const session = await mongoose.startSession();
  try {
    let out!: { wallet: IWallet; topup: IWalletTopup };
    await session.withTransaction(async () => {
      // Atomic credit; pipeline update keeps balance & cashFundedBalance consistent
      // (the model's cashFundedBalance<=balance pre('validate') hook does NOT fire on updates).
      const wallet = await Wallet.findOneAndUpdate(
        { _id: walletId, status: 'active' },
        [{ $set: {
            balance: { $add: ['$balance', amount] },
            cashFundedBalance: { $add: ['$cashFundedBalance', amount] },
        } }],
        { new: true, session },
      );
      if (!wallet) throw new Error('wallet not found or not active');

      await LedgerService.post({
        eventId,
        postings: [
          { account: { type: LedgerAccountType.FLOAT }, delta: amount, tag: FloatTag.CASH_DESK },
          { account: { type: LedgerAccountType.WALLET, ref: walletId }, delta: -amount },
        ],
        refType: 'wallet_topup',
        refId: clientTxnId,
        session,
      });

      const [topup] = await WalletTopup.create([{
        walletId, eventId, amount, method: 'cash', status: 'completed', recordedBy, clientTxnId,
      }], { session });

      out = { wallet, topup };
    });
    return out;
  } catch (e: any) {
    // Concurrent duplicate: unique clientTxnId lost the race — return the winner.
    if (e?.code === 11000) {
      const topup = await WalletTopup.findOne({ clientTxnId });
      const wallet = topup ? await Wallet.findById(topup.walletId) : null;
      if (topup && wallet) return { wallet, topup };
    }
    throw e;
  } finally {
    await session.endSession();
  }
}
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/services/wallet.service.ts src/services/__tests__/walletTopUpCash.service.test.ts
git commit -m "feat(cashless): WalletService.topUpCash (atomic credit + balanced ledger, idempotent)"
```

---

## Task 6: Reseller `POST /wallets/cash-topup`

**Files:**
- Create: `src/validators/reseller.validator.ts` (or extend the existing reseller validator if present)
- Modify: `src/controllers/reseller.controller.ts` (`cashTopup`)
- Modify: `src/routes/reseller.route.ts`
- Test: `src/routes/__tests__/resellerCashTopup.route.test.ts`

**Interfaces:**
- Consumes: `WalletService.topUpCash`, `assertValidBandUid`, `Wallet`, `Event`, `ResellerPermission.CASH_TOPUP`.
- Produces: `POST /api/reseller/wallets/cash-topup` body `{ ticketId? , bandUid?, eventId, amount, clientTxnId }`.

- [ ] **Step 1: Write the failing route test (replica set)**

```ts
// src/routes/__tests__/resellerCashTopup.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { ResellerPermission, ResellerRole } from '@interfaces/resellerPermission.interface';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { WalletService } from '@services/wallet.service';

beforeAll(connectLedgerTestDb, 60000); afterEach(clearTestDb); afterAll(disconnectTestDb);

const token = (perms = [ResellerPermission.CASH_TOPUP], over = {}) => jwt.sign({
  scope: 'reseller', resellerId: 'r1', hubId: null, operatorId: 'op1',
  role: ResellerRole.OPERATOR, permissions: perms, ...over,
}, JWT_SECRET);

async function seedBoundBand(cashless = true) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless } });
  const t = await Ticket.create({ eventId, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');
  return { eventId: String(eventId), bandUid: '04a22b1c3d4e5f' };
}

it('tops up a wallet by band uid', async () => {
  const { eventId, bandUid } = await seedBoundBand();
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ bandUid, eventId, amount: 500, clientTxnId: 'c1' });
  expect(res.status).toBe(200);
  expect(res.body.data.wallet.balance).toBe(500);
});

it('rejects a non-cashless event with 400', async () => {
  const { eventId, bandUid } = await seedBoundBand(false);
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ bandUid, eventId, amount: 500, clientTxnId: 'c2' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cashless/i);
});

it('rejects a token missing CASH_TOPUP with 403', async () => {
  const { eventId, bandUid } = await seedBoundBand();
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token([ResellerPermission.SELL_TICKETS])}`)
    .send({ bandUid, eventId, amount: 500, clientTxnId: 'c3' });
  expect(res.status).toBe(403);
});

it('is idempotent on clientTxnId', async () => {
  const { eventId, bandUid } = await seedBoundBand();
  const body = { bandUid, eventId, amount: 500, clientTxnId: 'dup' };
  await request(app).post('/api/reseller/wallets/cash-topup').set('Authorization', `Bearer ${token()}`).send(body);
  const res = await request(app).post('/api/reseller/wallets/cash-topup').set('Authorization', `Bearer ${token()}`).send(body);
  expect(res.status).toBe(200);
  expect(res.body.data.wallet.balance).toBe(500);
});
```

- [ ] **Step 2: Run it — expect FAIL** (404, route missing).

- [ ] **Step 3: Add the validator**

```ts
// src/validators/reseller.validator.ts  (create; or add these to the existing reseller validator)
import Joi from 'joi';
const uid = Joi.string().trim().lowercase().pattern(/^[0-9a-f]{14,}$/);
export const cashTopupSchema = Joi.object({
  ticketId: Joi.string().trim(),
  bandUid: uid,
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).required(),
  amount: Joi.number().integer().min(1).required(),
  clientTxnId: Joi.string().trim().required(),
}).xor('ticketId', 'bandUid');
export const sellBandSchema = Joi.object({
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).required(),
  ticketTypeId: Joi.string().required(),
  bandUid: uid.required(),
  cashAmount: Joi.number().integer().min(0).default(0),
  customerName: Joi.string().trim().allow('', null),
  customerPhone: Joi.string().trim().allow('', null),
  clientTxnId: Joi.string().trim().required(),
});
```

- [ ] **Step 4: Add the controller handler**

```ts
// src/controllers/reseller.controller.ts
import { cashTopupSchema } from '@validators/reseller.validator';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { WalletService } from '@services/wallet.service';

static async cashTopup(req: Request, res: Response): Promise<any> {
  try {
    const { error, value } = cashTopupSchema.validate(req.body);
    if (error) return ApiResponseUtil.error(res, error.message, 400);

    const event = await Event.findById(value.eventId).lean();
    if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
    if (!event.cashless) return ApiResponseUtil.error(res, 'Event is not cashless', 400);

    const wallet = value.bandUid
      ? await Wallet.findOne({ eventId: value.eventId, bandUid: value.bandUid })
      : await Wallet.findOne({ ticketId: value.ticketId, eventId: value.eventId });
    if (!wallet) return ApiResponseUtil.error(res, 'No wallet for that band/ticket', 404);

    const result = await WalletService.topUpCash({
      walletId: String(wallet._id), eventId: value.eventId,
      amount: value.amount, recordedBy: (req as any).reseller.operatorId, clientTxnId: value.clientTxnId,
    });
    return ApiResponseUtil.success(res, result);
  } catch (e: any) {
    const msg = e?.message || 'Top-up failed';
    const status = /not active|not found|cashless|amount/i.test(msg) ? 400 : 500;
    return ApiResponseUtil.error(res, msg, status);
  }
}
```

- [ ] **Step 5: Register the route**

In `src/routes/reseller.route.ts` (under the Sales/Payments section; `authenticateReseller` is already applied at `router.use`):
```ts
router.post('/wallets/cash-topup',
  requireResellerPermission(ResellerPermission.CASH_TOPUP),
  ResellerController.cashTopup);
```

- [ ] **Step 6: Run the test — expect PASS.**

- [ ] **Step 7: Commit**

```bash
git add src/validators/reseller.validator.ts src/controllers/reseller.controller.ts src/routes/reseller.route.ts src/routes/__tests__/resellerCashTopup.route.test.ts
git commit -m "feat(cashless): reseller cash-topup endpoint (event.cashless + permission gated)"
```

---

## Task 7: Reseller `POST /sales/sell-band`

**Files:**
- Modify: `src/services/resellerSale.service.ts` (add `createBandSale` orchestration) OR add to `src/services/ticket.service.ts` — keep it beside `createSale`.
- Modify: `src/controllers/reseller.controller.ts` (`sellBand`)
- Modify: `src/routes/reseller.route.ts`
- Test: `src/routes/__tests__/resellerSellBand.route.test.ts`

**Interfaces:**
- Consumes: `ResellerSaleService.createSale`, `WalletService.ensureWalletForTicket`, `WalletService.bindBand`, `WalletService.topUpCash`, `assertValidBandUid`, `Event`.
- Produces: `POST /api/reseller/sales/sell-band` → `{ sale, wallet, binding, ticket }`. Idempotent on `clientTxnId` (delegated to `createSale`'s sale row).

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/resellerSellBand.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent, seedReseller } from '@/__tests__/helpers/fixtures';
import { ResellerPermission, ResellerRole } from '@interfaces/resellerPermission.interface';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';

beforeAll(connectLedgerTestDb, 60000); afterEach(clearTestDb); afterAll(disconnectTestDb);

it('sells a band as a ticket: mints ticket + wallet + binding (+cash)', async () => {
  const { eventId, ticketTypeId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const { resellerId, hubId, operatorId } = await seedReseller();
  const token = jwt.sign({ scope:'reseller', resellerId, hubId, operatorId, role: ResellerRole.OPERATOR,
    permissions: [ResellerPermission.SELL_TICKETS, ResellerPermission.CASH_TOPUP] }, JWT_SECRET);

  const res = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 1000, clientTxnId: 'sb-1' });

  expect(res.status).toBe(201);
  expect(res.body.data.wallet.bandUid).toBe('04a22b1c3d4e5f');
  expect(res.body.data.wallet.balance).toBe(1000);
  const w = await Wallet.findOne({ bandUid: '04a22b1c3d4e5f' }).lean();
  expect(String(w!.ticketId)).toBeDefined();
});

it('rejects an already-bound uid loudly and leaves a bindable ticket', async () => {
  const { eventId, ticketTypeId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const { resellerId, hubId, operatorId } = await seedReseller();
  const token = jwt.sign({ scope:'reseller', resellerId, hubId, operatorId, role: ResellerRole.OPERATOR,
    permissions: [ResellerPermission.SELL_TICKETS] }, JWT_SECRET);
  const body = (ctx: string) => ({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 0, clientTxnId: ctx });

  await request(app).post('/api/reseller/sales/sell-band').set('Authorization', `Bearer ${token}`).send(body('sb-a'));
  const res = await request(app).post('/api/reseller/sales/sell-band').set('Authorization', `Bearer ${token}`).send(body('sb-b'));
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/already bound/i);
});
```
> Confirm `seedReseller()` returns `{ resellerId, hubId, operatorId }` (per fixtures.ts); if the field names differ, adjust. `createSale` needs a real reseller/operator — seed accordingly.

- [ ] **Step 2: Run it — expect FAIL** (404).

- [ ] **Step 3: Add the orchestration service method**

```ts
// src/services/resellerSale.service.ts
import { WalletService } from '@services/wallet.service';
import { assertValidBandUid } from '@utils/bandUid.util';

static async createBandSale(params: {
  operatorId: string; resellerId: string; hubId: string | null;
  eventId: string; ticketTypeId: string; bandUid: string; cashAmount: number;
  customerName?: string; customerPhone?: string; clientTxnId: string;
}) {
  const uid = assertValidBandUid(params.bandUid);

  // 1. Sell one cash ticket via the proven path (idempotent on clientTxnId inside createSale).
  const sale = await ResellerSaleService.createSale({
    operatorId: params.operatorId, resellerId: params.resellerId, hubId: params.hubId,
    eventId: params.eventId, ticketTypeId: params.ticketTypeId, quantity: 1,
    paymentMethod: 'cash', customerName: params.customerName, customerPhone: params.customerPhone,
    clientTxnId: params.clientTxnId,          // see note below
  } as any);
  if (sale.status !== 'completed' || !sale.tickets?.length) {
    throw new Error(sale.message || 'ticket sale did not complete');
  }
  const ticket: any = sale.tickets[0];

  // 2. Wallet + band (mirror ScanService.bindBandToTicket).
  const wallet = await WalletService.ensureWalletForTicket({
    ticketId: String(ticket._id), eventId: params.eventId,
    ...(ticket.purchasedBy ? { buyerId: String(ticket.purchasedBy) } : {}),
  });
  const bound = await WalletService.bindBand(String(wallet._id), uid, params.operatorId);

  // 3. Optional initial cash load.
  let finalWallet = bound;
  if (params.cashAmount > 0) {
    const { wallet: w } = await WalletService.topUpCash({
      walletId: String(bound._id), eventId: params.eventId, amount: params.cashAmount,
      recordedBy: params.operatorId, clientTxnId: `${params.clientTxnId}:topup`,
    });
    finalWallet = w;
  }
  return { sale, ticket, wallet: finalWallet, binding: { bandUid: uid, walletId: String(bound._id) } };
}
```
> **Idempotency note:** confirm `CreateSaleParams`/`createSale` persists `clientTxnId` on the sale (search `resellerSale.service.ts` / `ticketSale.model.ts` for `clientTxnId`). If it does NOT yet, add a `clientTxnId` (unique, sparse) to the sale write and short-circuit-return the existing sale when a duplicate arrives — this is what makes sell-band retry-safe (spec §5.1). Add a focused test for the duplicate-clientTxnId case.

- [ ] **Step 4: Add the controller handler**

```ts
// src/controllers/reseller.controller.ts
import { sellBandSchema } from '@validators/reseller.validator';

static async sellBand(req: Request, res: Response): Promise<any> {
  try {
    const { error, value } = sellBandSchema.validate(req.body);
    if (error) return ApiResponseUtil.error(res, error.message, 400);
    if (value.cashAmount > 0 && !(req as any).reseller.permissions?.includes('reseller:cash_topup')) {
      return ApiResponseUtil.forbidden(res, 'Permission required: reseller:cash_topup');
    }
    const event = await Event.findById(value.eventId).lean();
    if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
    if (!event.cashless) return ApiResponseUtil.error(res, 'Event is not cashless', 400);

    const r = (req as any).reseller;
    const result = await ResellerSaleService.createBandSale({
      operatorId: r.operatorId, resellerId: r.resellerId, hubId: r.hubId,
      eventId: value.eventId, ticketTypeId: value.ticketTypeId, bandUid: value.bandUid,
      cashAmount: value.cashAmount, customerName: value.customerName, customerPhone: value.customerPhone,
      clientTxnId: value.clientTxnId,
    });
    return ApiResponseUtil.created(res, result, 'Band sold');
  } catch (e: any) {
    const msg = e?.message || 'Sell-band failed';
    const status = /already bound|cashless|not active|invalid band|did not complete|not found/i.test(msg) ? 400 : 500;
    return ApiResponseUtil.error(res, msg, status);
  }
}
```

- [ ] **Step 5: Register the route**

```ts
// src/routes/reseller.route.ts (Sales section)
router.post('/sales/sell-band',
  requireResellerPermission(ResellerPermission.SELL_TICKETS),
  ResellerController.sellBand);
```

- [ ] **Step 6: Run the test — expect PASS.**

- [ ] **Step 7: Commit**

```bash
git add src/services/resellerSale.service.ts src/controllers/reseller.controller.ts src/routes/reseller.route.ts src/validators/reseller.validator.ts src/routes/__tests__/resellerSellBand.route.test.ts
git commit -m "feat(cashless): reseller sell-band endpoint (issue+bind+optional cash, idempotent)"
```

---

## Task 8: Tickets `GET /wallets/by-band/:uid`

**Files:**
- Modify: `src/services/wallet.service.ts` (add `getWalletViewByBand`)
- Modify: `src/controllers/tickets.controller.ts` (`walletByBand`)
- Modify: `src/routes/tickets.route.ts`
- Test: `src/routes/__tests__/ticketsWalletByBand.route.test.ts`

**Interfaces:**
- Produces: `GET /api/tickets/wallets/by-band/:uid?eventId=` → `{ ticket:{...}, balance, cashFundedBalance, status, history: [...] }`; 404 if unbound.

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/ticketsWalletByBand.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { WalletService } from '@services/wallet.service';

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);
const gate = (perms = [TicketsPermission.SCAN_TICKETS], vendorId = 'v1') =>
  jwt.sign({ app:'tickets', userType:'gate-operator', vendorId, permissions: perms }, JWT_SECRET);

it('returns the wallet view for a bound band', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  const t = await Ticket.create({ eventId, vendorId, ticketType:'General', price:100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');

  const res = await request(app).get(`/api/tickets/wallets/by-band/04a22b1c3d4e5f?eventId=${eventId}`)
    .set('Authorization', `Bearer ${gate([TicketsPermission.SCAN_TICKETS], String(vendorId))}`);
  expect(res.status).toBe(200);
  expect(res.body.data.status).toBe('active');
  expect(res.body.data.balance).toBe(0);
});

it('404s an unbound uid', async () => {
  const { eventId } = await seedPublishedEvent({});
  const res = await request(app).get(`/api/tickets/wallets/by-band/aaaaaaaaaaaaaa?eventId=${eventId}`)
    .set('Authorization', `Bearer ${gate()}`);
  expect(res.status).toBe(404);
});

it('403 without SCAN_TICKETS', async () => {
  const { eventId } = await seedPublishedEvent({});
  const res = await request(app).get(`/api/tickets/wallets/by-band/aaaaaaaaaaaaaa?eventId=${eventId}`)
    .set('Authorization', `Bearer ${gate([TicketsPermission.VIEW_EVENTS])}`);
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run it — expect FAIL** (404 route).

- [ ] **Step 3: Add the read helper**

```ts
// src/services/wallet.service.ts
import { WalletTopup } from '@models/walletTopup.model';

static async getWalletViewByBand(bandUid: string, eventId: string) {
  const wallet = await Wallet.findOne({ eventId, bandUid });
  if (!wallet) return null;
  const history = await WalletTopup.find({ walletId: wallet._id }).sort({ createdAt: -1 }).limit(10).lean();
  return {
    ticket: { id: String(wallet.ticketId) },
    balance: wallet.balance, cashFundedBalance: wallet.cashFundedBalance, status: wallet.status,
    history: history.map(h => ({ type: 'topup', method: h.method, amount: h.amount, at: h.createdAt })),
  };
}
```

- [ ] **Step 4: Add the controller + route**

```ts
// src/controllers/tickets.controller.ts
static async walletByBand(req: Request, res: Response): Promise<any> {
  try {
    const uid = normalizeBandUid(req.params.uid);           // import from @utils/bandUid.util
    const eventId = String(req.query.eventId || '');
    if (!/^[0-9a-fA-F]{24}$/.test(eventId)) return ApiResponseUtil.error(res, 'eventId is required', 400);
    const view = await WalletService.getWalletViewByBand(uid, eventId);
    if (!view) return ApiResponseUtil.error(res, 'No wallet bound to that band in this event', 404);
    return ApiResponseUtil.success(res, view);
  } catch (e: any) {
    return ApiResponseUtil.error(res, e.message || 'Lookup failed', 500);
  }
}
```
```ts
// src/routes/tickets.route.ts (near the /scans block)
router.get('/wallets/by-band/:uid',
  requireTicketsPermission(TicketsPermission.SCAN_TICKETS),
  TicketsController.walletByBand);
```

- [ ] **Step 5: Run the test — expect PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/services/wallet.service.ts src/controllers/tickets.controller.ts src/routes/tickets.route.ts src/routes/__tests__/ticketsWalletByBand.route.test.ts
git commit -m "feat(cashless): tickets wallet-by-band read endpoint"
```

---

## Task 9: Extend gate check-in to accept a band UID

**Files:**
- Modify: `src/validators/tickets.validator.ts` (`checkInTicketSchema`: add optional `bandUid`, make `ticketId` optional-with-xor)
- Modify: `src/controllers/tickets.controller.ts` (`checkInTicket`: resolve `bandUid` → ticket, enforce `event.cashless`)
- Test: `src/routes/__tests__/ticketsCheckInByBand.route.test.ts`

**Interfaces:**
- Consumes: existing `ScanService.checkInTicket`, `Wallet`, `Event`.
- Produces: `POST /api/tickets/scans/check-in` accepts `{ bandUid, expectedEventId }` in addition to `{ ticketId, expectedEventId }`.

- [ ] **Step 1: Write the failing route test**

```ts
// src/routes/__tests__/ticketsCheckInByBand.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Event } from '@models/event.model';
import { WalletService } from '@services/wallet.service';

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);
const gate = (vendorId: string) => jwt.sign(
  { app:'tickets', userType:'gate-operator', vendorId, permissions:[TicketsPermission.SCAN_TICKETS] }, JWT_SECRET);

async function seedBound(cashless = true) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless } });
  const t = await Ticket.create({ eventId, vendorId, ticketType:'General', price:100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');
  return { eventId: String(eventId), vendorId: String(vendorId), ticketId: t.ticketId };
}

it('checks in by band uid on a cashless event', async () => {
  const { eventId, vendorId } = await seedBound(true);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${gate(vendorId)}`)
    .send({ bandUid: '04a22b1c3d4e5f', expectedEventId: eventId });
  expect(res.status).toBe(200);
});

it('rejects band check-in when the event is not cashless', async () => {
  const { eventId, vendorId } = await seedBound(false);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${gate(vendorId)}`)
    .send({ bandUid: '04a22b1c3d4e5f', expectedEventId: eventId });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cashless/i);
});

it('404s an unbound uid', async () => {
  const { eventId, vendorId } = await seedBound(true);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${gate(vendorId)}`)
    .send({ bandUid: 'bbbbbbbbbbbbbb', expectedEventId: eventId });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/no wallet|not bound|no band/i);
});
```

- [ ] **Step 2: Run it — expect FAIL** (band path not handled — likely a validation error on missing `ticketId`).

- [ ] **Step 3: Loosen the validator**

In `src/validators/tickets.validator.ts`, change `checkInTicketSchema` so exactly one of `ticketId` / `bandUid` is present:
```ts
export const checkInTicketSchema = Joi.object({
  ticketId: Joi.string().trim(),
  bandUid: Joi.string().trim().lowercase().pattern(/^[0-9a-f]{14,}$/),
  expectedEventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
  notes: Joi.string().max(500),
}).xor('ticketId', 'bandUid');
```

- [ ] **Step 4: Resolve `bandUid` → ticket in the controller**

In `TicketsController.checkInTicket`, after validation and before calling `ScanService.checkInTicket`, add:
```ts
let ticketId = value.ticketId;
if (value.bandUid) {
  const eventId = value.expectedEventId;
  if (!eventId) return ApiResponseUtil.error(res, 'expectedEventId is required for band check-in', 400);
  const event = await Event.findById(eventId).lean();
  if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
  if (!event.cashless) return ApiResponseUtil.error(res, 'Event is not cashless', 400);
  const wallet = await Wallet.findOne({ eventId, bandUid: normalizeBandUid(value.bandUid) });
  if (!wallet) return ApiResponseUtil.error(res, 'No wallet bound to that band in this event', 400);
  ticketId = String(wallet.ticketId);
}
// ...then pass ticketId into ScanService.checkInTicket({ ticketId, ... }) unchanged.
```
> `ScanService.checkInTicket` takes the ticket's short code OR `_id` via `findTicketByCode`; confirm it resolves an `_id` string. If `findTicketByCode` only matches the short code, look the ticket up by `_id` here and pass `ticket.ticketId` instead. Add the import of `Event`, `Wallet`, `normalizeBandUid`.

- [ ] **Step 5: Run the test — expect PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/validators/tickets.validator.ts src/controllers/tickets.controller.ts src/routes/__tests__/ticketsCheckInByBand.route.test.ts
git commit -m "feat(cashless): gate check-in accepts a band uid (cashless events)"
```

---

## Task 10: Whole-branch verification + review

**Files:** none.

- [ ] **Step 1: Full suite green at the reliable worker count**

```bash
npx jest --maxWorkers=4
```
Expected: PASS, including every new suite (`event.cashless`, `walletTopup`, `bandUid`, `walletTopUpCash`, `resellerCashTopup`, `resellerSellBand`, `ticketsWalletByBand`, `ticketsCheckInByBand`).

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Reconciliation sanity** — confirm `ReconciliationService.checkWalletBalances` and `checkInvariant` report no drift for an event after a sequence of sell-band + top-ups (add one integration test that runs 3 sell-bands + 3 top-ups then asserts both checks are clean).

- [ ] **Step 4: Request review** — use `superpowers:requesting-code-review` over the branch diff before merge; run `security-pentest-reviewer` over the two new money endpoints (sell-band, cash-topup).

- [ ] **Step 5: Commit any review fixes, then the branch is ready to merge to `main`.**

---

## Self-review notes (for the planner)

- **Spec coverage:** §4 event.cashless → T1; §4 WalletTopup → T4; §4 ResellerPermission.CASH_TOPUP → T2; §5 #1 sell-band → T7; §5 #2 cash-topup → T6; §5 #3 wallet-by-band → T8; §5 #4 gate-by-band → T9; §2.1 7-byte UID → T3; §5.1 idempotent orchestration → T7; §8 tests → each task; §9 Step 0 → T0. Bind-to-existing (§5 row —) is reused unchanged (built).
- **Not in this plan (POS-app plan):** `nfc_manager`, `TagReader`, PosPage/ScanPage UI, `api.dart` client calls, surfacing `cashless` in the **gate** events endpoint the app uses.
- **Open confirmations flagged inline (do at implementation):** exact `ledger.service` read-helper names; whether `createSale`/`ticketSale` already persists `clientTxnId` (T7); whether `findTicketByCode` resolves an `_id` string (T9); `seedReseller()`/`fixtures.ts` return shape.
