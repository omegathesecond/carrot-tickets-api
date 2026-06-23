# Operator User ID + PIN Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace reseller-operator email/password login with a system-issued 6-digit user ID (login code) + 6-digit PIN, where only `MANAGE_OPERATORS` holders can set/reset PINs.

**Architecture:** Backend in `carrot-tickets-api` (Express + Mongoose, Jest). Operators authenticate by `loginCode` + `pin` (bcrypt-hashed) with per-operator brute-force lockout. PIN issuance/reset lives behind super-admin routes (`/api/admin`) and reseller-portal routes (`/api/reseller`, gated by `MANAGE_OPERATORS`). Frontend in `carrot-tickets-dashboard` (React + Vite): updated reseller login, a super-admin Operators tab, and a new in-portal operator-management screen.

**Tech Stack:** TypeScript, Express, Mongoose, bcrypt, Joi, Jest + supertest (api); React, Vite, TanStack Query, react-router-dom, sonner (dashboard).

## Global Constraints

- Login code: 6-digit numeric string, range `100000`–`999999`, globally unique, random, immutable after creation.
- PIN: 6-digit numeric string, bcrypt-hashed (`select: false`), never returned except once at issue/reset.
- Lockout: 5 consecutive wrong PINs → `lockedUntil = now + 15 minutes`, then counter resets.
- PIN authority: `MANAGE_OPERATORS` only (super admin, `reseller_admin`, `reseller_hub_manager`). No operator self-service PIN endpoint.
- Scope: reseller-portal endpoints derive `resellerId`/`hubId`/`role` from the JWT (`req.reseller`), never from the client. `reseller_hub_manager` is limited to its own `hubId`; `reseller_admin` to its `resellerId`.
- Role assignment: an actor may only assign roles strictly below its own rank (`reseller_operator` < `reseller_hub_manager` < `reseller_admin`).
- Full replacement: remove `password`, `mustChangePassword`, `firstLogin`, `comparePassword` from the operator model and all operator auth paths.
- API base repo path: `~/Documents/omevision/contracts/carrot-tickets/api`. Dashboard repo path: `~/Documents/omevision/contracts/carrot-tickets/dashboard`.
- Run api tests with `npx jest <path>` from the `api/` dir. Build dashboard with `npx tsc -p tsconfig.app.json --noEmit` from the `dashboard/` dir.

---

## Task 1: Credential generation util

**Files:**
- Create: `api/src/utils/operatorCredentials.util.ts`
- Test: `api/src/utils/__tests__/operatorCredentials.util.test.ts`

**Interfaces:**
- Produces:
  - `generatePin(): string` — random 6-digit string, may have leading zeros.
  - `generateUniqueLoginCode(): Promise<string>` — random `100000`–`999999` string, verified unused against `ResellerOperator`, retries on collision, throws `Error('Could not generate a unique login code')` after 20 attempts.

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/utils/__tests__/operatorCredentials.util.test.ts
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerOperator } from '@models/resellerOperator.model';
import { generatePin, generateUniqueLoginCode } from '@utils/operatorCredentials.util';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());

it('generatePin returns a 6-digit numeric string', () => {
  for (let i = 0; i < 50; i++) {
    expect(generatePin()).toMatch(/^\d{6}$/);
  }
});

it('generateUniqueLoginCode returns a 6-digit code in range', async () => {
  const code = await generateUniqueLoginCode();
  expect(code).toMatch(/^\d{6}$/);
  expect(Number(code)).toBeGreaterThanOrEqual(100000);
  expect(Number(code)).toBeLessThanOrEqual(999999);
});

it('generateUniqueLoginCode retries when a code already exists', async () => {
  // Seed an operator that owns code "100000" (Math.random -> 0).
  await ResellerOperator.collection.insertOne({ loginCode: '100000', fullName: 'x', role: 'reseller_operator', isActive: true } as any);
  const spy = jest.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5);
  const code = await generateUniqueLoginCode();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(code).toBe('550000'); // 100000 + floor(0.5 * 900000)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/utils/__tests__/operatorCredentials.util.test.ts`
Expected: FAIL — cannot find module `@utils/operatorCredentials.util`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// api/src/utils/operatorCredentials.util.ts
import { ResellerOperator } from '@models/resellerOperator.model';

/** Random 6-digit PIN string (leading zeros allowed). */
export function generatePin(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

/** Random globally-unique 6-digit login code (100000–999999). */
export async function generateUniqueLoginCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const exists = await ResellerOperator.exists({ loginCode: code });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique login code');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/utils/__tests__/operatorCredentials.util.test.ts`
Expected: PASS (3 tests). Note: this task’s code references the model fields from Task 2; if `loginCode` is not yet indexed the test still passes (it uses `.exists`/raw insert).

- [ ] **Step 5: Commit**

```bash
cd api && git add src/utils/operatorCredentials.util.ts src/utils/__tests__/operatorCredentials.util.test.ts
git commit -m "feat(operators): add login-code + PIN generation util"
```

---

## Task 2: Operator model + interface rewrite

**Files:**
- Modify: `api/src/interfaces/reseller.interface.ts` (the `IResellerOperator` interface)
- Modify: `api/src/models/resellerOperator.model.ts`
- Modify: `api/src/models/__tests__/reseller.models.test.ts`
- Modify: `api/src/__tests__/helpers/fixtures.ts` (add `seedReseller`/`seedOperator`)

**Interfaces:**
- Consumes: `generatePin`, `generateUniqueLoginCode` (Task 1).
- Produces:
  - `IResellerOperator` with `loginCode: string`, `pin: string`, `failedPinAttempts: number`, `lockedUntil: Date | null`, `comparePin(p: string): Promise<boolean>`; no `password`/`mustChangePassword`/`firstLogin`/`comparePassword`.
  - Fixture `seedOperator(opts?: { role?: string; pin?: string; resellerId?; hubId? }): Promise<{ operator: any; resellerId: string; hubId: string; loginCode: string; pin: string }>`.
  - Fixture `seedReseller(): Promise<{ resellerId: string; hubId: string }>`.

- [ ] **Step 1: Update the model test to the new shape (failing test)**

Replace the body of `api/src/models/__tests__/reseller.models.test.ts` with:

```typescript
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('creates reseller -> hub -> operator with hashed PIN and login code', async () => {
  const r = await Reseller.create({ businessName: 'Pick n Pay', commissionPercent: null });
  expect(r.status).toBe('active');

  const hub = await ResellerHub.create({ resellerId: r._id, name: 'Mbabane Branch' });
  const op = await ResellerOperator.create({
    hubId: hub._id, resellerId: r._id, fullName: 'Till One',
    loginCode: '123456', pin: '654321', role: 'reseller_operator',
  });

  const fetched = await ResellerOperator.findById(op._id).select('+pin');
  expect(fetched!.pin).not.toBe('654321');                 // hashed
  expect(await fetched!.comparePin('654321')).toBe(true);
  expect(await fetched!.comparePin('000000')).toBe(false);
});

it('hides pin from toJSON and enforces unique login code', async () => {
  const r = await Reseller.create({ businessName: 'Spar', commissionPercent: null });
  const hub = await ResellerHub.create({ resellerId: r._id, name: 'CBD' });
  const op = await ResellerOperator.create({
    hubId: hub._id, resellerId: r._id, fullName: 'Till Two',
    loginCode: '222333', pin: '111111', role: 'reseller_operator',
  });
  expect((op.toJSON() as any).pin).toBeUndefined();

  await expect(ResellerOperator.create({
    hubId: hub._id, resellerId: r._id, fullName: 'Dup',
    loginCode: '222333', pin: '999999', role: 'reseller_operator',
  })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/models/__tests__/reseller.models.test.ts`
Expected: FAIL — `comparePin` is not a function / `loginCode` not unique.

- [ ] **Step 3: Update the interface**

In `api/src/interfaces/reseller.interface.ts`, replace the `IResellerOperator` interface with:

```typescript
export interface IResellerOperator {
  hubId: any;
  resellerId: any;
  fullName: string;
  email?: string;
  phoneNumber?: string;
  loginCode: string;
  pin: string;
  role: string;
  isActive: boolean;
  failedPinAttempts: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date;
  comparePin(p: string): Promise<boolean>;
}
```

- [ ] **Step 4: Rewrite the model**

Replace `api/src/models/resellerOperator.model.ts` with:

```typescript
import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { IResellerOperator } from '@interfaces/reseller.interface';

const operatorSchema = new Schema<IResellerOperator>({
  hubId: { type: Schema.Types.ObjectId, ref: 'ResellerHub', required: true },
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', required: true },
  fullName: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  pin: {
    type: String,
    required: [true, 'PIN is required'],
    select: false,
  },
  role: {
    type: String,
    required: true,
    enum: ['reseller_admin', 'reseller_hub_manager', 'reseller_operator'],
    index: true,
  },
  isActive: { type: Boolean, default: true, index: true },
  failedPinAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  lastLoginAt: { type: Date },
}, {
  timestamps: true,
  toJSON: {
    transform: function (_doc, ret) {
      const { pin, __v, ...rest } = ret;
      return rest;
    },
  },
  toObject: {
    transform: function (_doc, ret) {
      const { pin, __v, ...rest } = ret;
      return rest;
    },
  },
});

operatorSchema.pre('save', async function (next) {
  try {
    if (this.isModified('pin')) {
      const salt = await bcrypt.genSalt(12);
      this.pin = await bcrypt.hash(this.pin, salt);
    }
    next();
  } catch (error) {
    next(error as Error);
  }
});

operatorSchema.methods.comparePin = function (this: IResellerOperator, candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, (this as any).pin);
};

operatorSchema.index({ resellerId: 1, isActive: 1 });
operatorSchema.index({ hubId: 1, isActive: 1 });

export const ResellerOperator = mongoose.model<IResellerOperator>('ResellerOperator', operatorSchema);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && npx jest src/models/__tests__/reseller.models.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Add shared fixtures**

Append to `api/src/__tests__/helpers/fixtures.ts`:

```typescript
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';

let __loginCodeSeq = 100000;

export async function seedReseller(): Promise<{ resellerId: string; hubId: string }> {
  const r = await Reseller.create({ businessName: 'Fixture Reseller', commissionPercent: null });
  const hub = await ResellerHub.create({ resellerId: r._id, name: 'Fixture Hub' });
  return { resellerId: r._id.toString(), hubId: hub._id.toString() };
}

export async function seedOperator(opts: {
  role?: string;
  pin?: string;
  resellerId?: string;
  hubId?: string;
  loginCode?: string;
} = {}): Promise<{ operator: any; resellerId: string; hubId: string; loginCode: string; pin: string }> {
  let resellerId = opts.resellerId;
  let hubId = opts.hubId;
  if (!resellerId || !hubId) {
    const seeded = await seedReseller();
    resellerId = resellerId ?? seeded.resellerId;
    hubId = hubId ?? seeded.hubId;
  }
  const loginCode = opts.loginCode ?? String(__loginCodeSeq++);
  const pin = opts.pin ?? '654321';
  const operator = await ResellerOperator.create({
    hubId, resellerId, fullName: 'Fixture Op',
    loginCode, pin, role: opts.role ?? 'reseller_operator',
  });
  return { operator, resellerId, hubId, loginCode, pin };
}
```

- [ ] **Step 7: Commit**

```bash
cd api && git add src/interfaces/reseller.interface.ts src/models/resellerOperator.model.ts src/models/__tests__/reseller.models.test.ts src/__tests__/helpers/fixtures.ts
git commit -m "feat(operators): model auth via login code + hashed PIN"
```

---

## Task 3: Auth service — login by code + PIN with lockout

**Files:**
- Modify: `api/src/services/resellerAuth.service.ts`
- Modify: `api/src/services/__tests__/resellerAuth.service.test.ts`

**Interfaces:**
- Consumes: `seedOperator` (Task 2), `ResellerOperator` model.
- Produces: `ResellerAuthService.login(loginCode: string, pin: string)` returning `{ accessToken, operator: { id, fullName, role, resellerId, hubId } }`. Throws `Error('Invalid credentials')` or `Error('Account locked. Try again later.')`. `verifyToken` unchanged.

- [ ] **Step 1: Replace the service test (failing test)**

Replace `api/src/services/__tests__/resellerAuth.service.test.ts` with:

```typescript
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerOperator } from '@models/resellerOperator.model';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { seedOperator } from '../../__tests__/helpers/fixtures';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('logs in an operator by login code + PIN and issues a reseller token', async () => {
  const { resellerId, loginCode, pin } = await seedOperator({ pin: '123456' });
  const { accessToken, operator } = await ResellerAuthService.login(loginCode, pin);
  expect(operator.role).toBe('reseller_operator');
  const decoded = ResellerAuthService.verifyToken(accessToken);
  expect(decoded.scope).toBe('reseller');
  expect(decoded.resellerId).toBe(resellerId);
  expect(decoded.permissions).toContain('reseller:sell_tickets');
});

it('rejects an unknown login code', async () => {
  await expect(ResellerAuthService.login('000001', '123456')).rejects.toThrow('Invalid credentials');
});

it('rejects a wrong PIN', async () => {
  const { loginCode } = await seedOperator({ pin: '123456' });
  await expect(ResellerAuthService.login(loginCode, '999999')).rejects.toThrow('Invalid credentials');
});

it('locks the account after 5 failed attempts', async () => {
  const { loginCode } = await seedOperator({ pin: '123456' });
  for (let i = 0; i < 5; i++) {
    await expect(ResellerAuthService.login(loginCode, '000000')).rejects.toThrow('Invalid credentials');
  }
  // 6th attempt — even with the correct PIN — is rejected while locked.
  await expect(ResellerAuthService.login(loginCode, '123456')).rejects.toThrow('Account locked');
  const op = await ResellerOperator.findOne({ loginCode });
  expect(op!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
});

it('resets the failed counter on a successful login', async () => {
  const { loginCode } = await seedOperator({ pin: '123456' });
  await expect(ResellerAuthService.login(loginCode, '000000')).rejects.toThrow();
  await ResellerAuthService.login(loginCode, '123456');
  const op = await ResellerOperator.findOne({ loginCode });
  expect(op!.failedPinAttempts).toBe(0);
  expect(op!.lockedUntil).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/__tests__/resellerAuth.service.test.ts`
Expected: FAIL — `login` still expects `identifier`/`password`.

- [ ] **Step 3: Rewrite the service**

Replace `api/src/services/resellerAuth.service.ts` with:

```typescript
import jwt, { SignOptions } from 'jsonwebtoken';
import { ResellerOperator } from '@models/resellerOperator.model';
import { ResellerRole, RESELLER_ROLE_PERMISSIONS, ResellerToken } from '@interfaces/resellerPermission.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export class ResellerAuthService {
  static async login(loginCode: string, pin: string) {
    const operator = await ResellerOperator.findOne({ loginCode, isActive: true }).select('+pin');
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

    operator.failedPinAttempts = 0;
    operator.lockedUntil = null;
    operator.lastLoginAt = new Date();
    await operator.save();

    const role = operator.role as ResellerRole;
    const payload: ResellerToken = {
      scope: 'reseller',
      resellerId: operator.resellerId.toString(),
      hubId: operator.hubId ? operator.hubId.toString() : null,
      operatorId: (operator._id as any).toString(),
      role,
      permissions: RESELLER_ROLE_PERMISSIONS[role],
    };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    return {
      accessToken,
      operator: {
        id: payload.operatorId,
        fullName: operator.fullName,
        role,
        resellerId: payload.resellerId,
        hubId: payload.hubId!,
      },
    };
  }

  static verifyToken(token: string): ResellerToken {
    const decoded = jwt.verify(token, JWT_SECRET) as ResellerToken;
    if (decoded.scope !== 'reseller') throw new Error('Invalid token scope');
    return decoded;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/services/__tests__/resellerAuth.service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd api && git add src/services/resellerAuth.service.ts src/services/__tests__/resellerAuth.service.test.ts
git commit -m "feat(operators): login by code+PIN with brute-force lockout"
```

---

## Task 4: Reseller login controller + route validator

**Files:**
- Modify: `api/src/controllers/reseller.controller.ts` (the `login` method)
- Modify: `api/src/routes/__tests__/reseller.route.test.ts`

**Interfaces:**
- Consumes: `ResellerAuthService.login(loginCode, pin)` (Task 3), `seedOperator` (Task 2).
- Produces: `POST /api/reseller/auth/login` accepting `{ loginCode, pin }`; 401 on invalid, 429 on locked.

- [ ] **Step 1: Update the login portion of the route test (failing test)**

In `api/src/routes/__tests__/reseller.route.test.ts`, replace every operator-creation block and login call. Where the file currently does:

```typescript
await ResellerOperator.create({ hubId: hub._id, resellerId: r._id, fullName: 'Op',
  phoneNumber: '+26878222222', password: 'secret123', role: 'reseller_operator' });
// ...
.send({ identifier: '+26878222222', password: 'secret123' });
```

replace with the `seedOperator` fixture + `{ loginCode, pin }` login. The top login test becomes:

```typescript
import { seedOperator } from '../../__tests__/helpers/fixtures';

it('logs in via POST /api/reseller/auth/login with code + PIN', async () => {
  const { loginCode, pin } = await seedOperator({ pin: '123456' });
  const res = await request(app)
    .post('/api/reseller/auth/login')
    .send({ loginCode, pin });
  expect(res.status).toBe(200);
  expect(res.body.data.accessToken).toBeDefined();
});

it('rejects a wrong PIN with 401', async () => {
  const { loginCode } = await seedOperator({ pin: '123456' });
  const res = await request(app)
    .post('/api/reseller/auth/login')
    .send({ loginCode, pin: '999999' });
  expect(res.status).toBe(401);
});
```

For the other tests in this file that previously created an operator just to obtain a token, replace their inline `ResellerOperator.create({...password...})` + `.send({ identifier, password })` with:

```typescript
const { operator, resellerId, hubId, loginCode, pin } = await seedOperator({ role: 'reseller_operator' });
const login = await request(app).post('/api/reseller/auth/login').send({ loginCode, pin });
const token = login.body.data.accessToken;
```

and use `operator`, `resellerId`, `hubId` where the test previously referenced the created operator/hub/reseller ids.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/routes/__tests__/reseller.route.test.ts`
Expected: FAIL — login returns 400 (validator still requires `identifier`/`password`).

- [ ] **Step 3: Update the controller login method**

In `api/src/controllers/reseller.controller.ts`, replace the `login` method with:

```typescript
  /**
   * Authentication: Login with login code + PIN
   */
  static async login(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = Joi.object({
        loginCode: Joi.string().pattern(/^\d{6}$/).required(),
        pin: Joi.string().pattern(/^\d{6}$/).required(),
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const result = await ResellerAuthService.login(value.loginCode, value.pin);
      return ApiResponseUtil.success(res, result, 'Login successful');
    } catch (err: any) {
      if (err?.message === 'Invalid credentials') {
        return ApiResponseUtil.unauthorized(res, 'Invalid credentials');
      }
      if (typeof err?.message === 'string' && err.message.includes('locked')) {
        return ApiResponseUtil.error(res, err.message, 429);
      }
      console.error('Reseller login error:', err);
      return ApiResponseUtil.error(res, 'Login failed', 500);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/routes/__tests__/reseller.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && git add src/controllers/reseller.controller.ts src/routes/__tests__/reseller.route.test.ts
git commit -m "feat(operators): reseller login endpoint accepts code+PIN"
```

---

## Task 5: Super-admin operator issuance + PIN reset

**Files:**
- Modify: `api/src/controllers/resellerAdmin.controller.ts` (`createOperator`; add `resetOperatorPin`)
- Modify: `api/src/routes/resellerAdmin.route.ts`
- Modify: `api/src/routes/__tests__/resellerAdmin.route.test.ts`

**Interfaces:**
- Consumes: `generateUniqueLoginCode`, `generatePin` (Task 1).
- Produces:
  - `POST /api/admin/hubs/:hubId/operators` → `201 { operator, loginCode, pin }`.
  - `POST /api/admin/operators/:id/reset-pin` body optional `{ pin }` → `200 { operatorId, pin }`.

- [ ] **Step 1: Write failing route tests**

Add to `api/src/routes/__tests__/resellerAdmin.route.test.ts` (follow the file’s existing super-admin token helper; if it builds a tickets super-admin token inline, reuse that pattern):

```typescript
import { seedReseller } from '../../__tests__/helpers/fixtures';
import { ResellerOperator } from '@models/resellerOperator.model';

it('issues an operator with a login code + PIN', async () => {
  const { hubId } = await seedReseller();
  const res = await request(app)
    .post(`/api/admin/hubs/${hubId}/operators`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ fullName: 'New Till', role: 'reseller_operator' });
  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^\d{6}$/);
  expect(res.body.data.pin).toMatch(/^\d{6}$/);
  expect(res.body.data.operator.pin).toBeUndefined();
});

it('resets an operator PIN', async () => {
  const { hubId } = await seedReseller();
  const created = await request(app)
    .post(`/api/admin/hubs/${hubId}/operators`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ fullName: 'Reset Me', role: 'reseller_operator' });
  const operatorId = created.body.data.operator._id;

  const res = await request(app)
    .post(`/api/admin/operators/${operatorId}/reset-pin`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ pin: '424242' });
  expect(res.status).toBe(200);
  expect(res.body.data.pin).toBe('424242');

  const op = await ResellerOperator.findById(operatorId).select('+pin');
  expect(await op!.comparePin('424242')).toBe(true);
});
```

> If `resellerAdmin.route.test.ts` does not already expose a `superAdminToken`, build one with the same helper the file's other authenticated tests use (e.g. `makeSuperAdminToken()` in `src/__tests__/helpers/auth.ts`). Check that helper before writing — reuse, don't duplicate.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/routes/__tests__/resellerAdmin.route.test.ts`
Expected: FAIL — reset-pin route 404; create returns operator without `loginCode`/`pin`.

- [ ] **Step 3: Update the controller**

In `api/src/controllers/resellerAdmin.controller.ts`, add the import at the top:

```typescript
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
```

Replace `createOperator` with:

```typescript
  static async createOperator(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await ResellerHub.findById(req.params['hubId']);
      if (!hub) {
        ApiResponseUtil.notFound(res, 'Hub not found');
        return;
      }
      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      const operator = await ResellerOperator.create({
        fullName: req.body.fullName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        role: req.body.role,
        hubId: hub._id,
        resellerId: hub.resellerId,
        loginCode,
        pin,
      });
      ApiResponseUtil.created(res, { operator, loginCode, pin });
    } catch (err: any) {
      next(err);
    }
  }

  static async resetOperatorPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await ResellerOperator.findById(req.params['id']).select('+pin');
      if (!operator) {
        ApiResponseUtil.notFound(res, 'Operator not found');
        return;
      }
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      operator.pin = pin;
      operator.failedPinAttempts = 0;
      operator.lockedUntil = null;
      await operator.save();
      ApiResponseUtil.success(res, { operatorId: (operator._id as any).toString(), pin });
    } catch (err: any) {
      next(err);
    }
  }
```

- [ ] **Step 4: Wire the route**

In `api/src/routes/resellerAdmin.route.ts`, under the Operators section add:

```typescript
router.post('/operators/:id/reset-pin', ResellerAdminController.resetOperatorPin);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && npx jest src/routes/__tests__/resellerAdmin.route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd api && git add src/controllers/resellerAdmin.controller.ts src/routes/resellerAdmin.route.ts src/routes/__tests__/resellerAdmin.route.test.ts
git commit -m "feat(operators): super-admin issues login code/PIN and resets PIN"
```

---

## Task 6: Reseller-portal operator management

**Files:**
- Create: `api/src/controllers/resellerOperatorAdmin.controller.ts`
- Modify: `api/src/routes/reseller.route.ts`
- Create: `api/src/routes/__tests__/resellerOperators.route.test.ts`

**Interfaces:**
- Consumes: `generateUniqueLoginCode`, `generatePin` (Task 1); `authenticateReseller`, `requireResellerPermission` (existing); `ResellerPermission.MANAGE_OPERATORS`.
- Produces, all under `/api/reseller`, gated by `MANAGE_OPERATORS`:
  - `GET /operators`
  - `POST /operators` → `201 { operator, loginCode, pin }`
  - `POST /operators/:id/reset-pin` → `200 { operatorId, pin }`
  - `PATCH /operators/:id` (`isActive`, `fullName`, `role`)

- [ ] **Step 1: Write failing scope tests**

```typescript
// api/src/routes/__tests__/resellerOperators.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedOperator } from '../../__tests__/helpers/fixtures';
import { ResellerOperator } from '@models/resellerOperator.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function tokenFor(role: string) {
  const seeded = await seedOperator({ role, pin: '123456' });
  const login = await request(app).post('/api/reseller/auth/login').send({ loginCode: seeded.loginCode, pin: '123456' });
  return { token: login.body.data.accessToken as string, ...seeded };
}

it('a hub manager lists only operators in their hub', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  await seedOperator({ resellerId: mgr.resellerId, hubId: mgr.hubId, role: 'reseller_operator' }); // same hub
  await seedOperator(); // different reseller/hub
  const res = await request(app).get('/api/reseller/operators').set('Authorization', `Bearer ${mgr.token}`);
  expect(res.status).toBe(200);
  for (const op of res.body.data) expect(op.hubId).toBe(mgr.hubId);
});

it('a plain operator cannot list operators (403)', async () => {
  const op = await tokenFor('reseller_operator');
  const res = await request(app).get('/api/reseller/operators').set('Authorization', `Bearer ${op.token}`);
  expect(res.status).toBe(403);
});

it('a hub manager issues an operator in their own hub', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const res = await request(app).post('/api/reseller/operators')
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({ fullName: 'Hired', role: 'reseller_operator' });
  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^\d{6}$/);
  expect(res.body.data.operator.hubId).toBe(mgr.hubId);
});

it('a hub manager cannot mint a reseller_admin (403)', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const res = await request(app).post('/api/reseller/operators')
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({ fullName: 'Boss', role: 'reseller_admin' });
  expect(res.status).toBe(403);
});

it('a hub manager cannot reset a PIN for an operator in another hub (404)', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const other = await seedOperator(); // different hub
  const res = await request(app).post(`/api/reseller/operators/${other.operator._id}/reset-pin`)
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({});
  expect(res.status).toBe(404);
});

it('a reseller admin resets a PIN within their reseller', async () => {
  const admin = await tokenFor('reseller_admin');
  const target = await seedOperator({ resellerId: admin.resellerId, hubId: admin.hubId });
  const res = await request(app).post(`/api/reseller/operators/${target.operator._id}/reset-pin`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pin: '787878' });
  expect(res.status).toBe(200);
  const op = await ResellerOperator.findById(target.operator._id).select('+pin');
  expect(await op!.comparePin('787878')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/routes/__tests__/resellerOperators.route.test.ts`
Expected: FAIL — routes 404.

- [ ] **Step 3: Write the controller**

```typescript
// api/src/controllers/resellerOperatorAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { ResellerOperator } from '@models/resellerOperator.model';
import { ResellerHub } from '@models/resellerHub.model';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';

const ROLE_RANK: Record<string, number> = {
  reseller_operator: 0,
  reseller_hub_manager: 1,
  reseller_admin: 2,
};

/** Build the Mongo scope filter from the actor's token. */
function scopeFilter(actor: any): Record<string, unknown> {
  if (actor.role === 'reseller_hub_manager') return { hubId: actor.hubId };
  return { resellerId: actor.resellerId };
}

export class ResellerOperatorAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const operators = await ResellerOperator.find(scopeFilter(actor)).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, operators);
    } catch (err: any) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const requestedRole = req.body.role ?? 'reseller_operator';

      // An actor may only assign roles strictly below their own rank.
      if ((ROLE_RANK[requestedRole] ?? 99) >= (ROLE_RANK[actor.role] ?? 0)) {
        ApiResponseUtil.forbidden(res, 'Cannot assign a role at or above your own');
        return;
      }

      // Resolve the target hub within the actor's scope.
      let hubId = actor.role === 'reseller_hub_manager' ? actor.hubId : req.body.hubId;
      if (!hubId) {
        ApiResponseUtil.badRequest(res, 'hubId is required');
        return;
      }
      const hub = await ResellerHub.findById(hubId);
      if (!hub || hub.resellerId.toString() !== actor.resellerId) {
        ApiResponseUtil.forbidden(res, 'Hub is not in your reseller');
        return;
      }

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      const operator = await ResellerOperator.create({
        fullName: req.body.fullName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        role: requestedRole,
        hubId: hub._id,
        resellerId: hub.resellerId,
        loginCode,
        pin,
      });
      ApiResponseUtil.created(res, { operator, loginCode, pin });
    } catch (err: any) {
      next(err);
    }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const operator = await ResellerOperator.findOne({
        _id: req.params['id'],
        ...scopeFilter(actor),
      }).select('+pin');
      if (!operator) {
        ApiResponseUtil.notFound(res, 'Operator not found');
        return;
      }
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      operator.pin = pin;
      operator.failedPinAttempts = 0;
      operator.lockedUntil = null;
      await operator.save();
      ApiResponseUtil.success(res, { operatorId: (operator._id as any).toString(), pin });
    } catch (err: any) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const operator = await ResellerOperator.findOne({
        _id: req.params['id'],
        ...scopeFilter(actor),
      });
      if (!operator) {
        ApiResponseUtil.notFound(res, 'Operator not found');
        return;
      }
      if ('fullName' in req.body) operator.fullName = req.body.fullName;
      if ('isActive' in req.body) operator.isActive = !!req.body.isActive;
      if ('role' in req.body) {
        if ((ROLE_RANK[req.body.role] ?? 99) >= (ROLE_RANK[actor.role] ?? 0)) {
          ApiResponseUtil.forbidden(res, 'Cannot assign a role at or above your own');
          return;
        }
        operator.role = req.body.role;
      }
      await operator.save();
      ApiResponseUtil.success(res, operator);
    } catch (err: any) {
      next(err);
    }
  }
}
```

- [ ] **Step 4: Wire the routes**

In `api/src/routes/reseller.route.ts`, add the import and routes (after the existing `authenticateReseller` `router.use`, alongside the other authed routes):

```typescript
import { ResellerOperatorAdminController } from '@controllers/resellerOperatorAdmin.controller';

// Operator management (MANAGE_OPERATORS)
router.get('/operators',
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS),
  ResellerOperatorAdminController.list);
router.post('/operators',
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS),
  ResellerOperatorAdminController.create);
router.post('/operators/:id/reset-pin',
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS),
  ResellerOperatorAdminController.resetPin);
router.patch('/operators/:id',
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS),
  ResellerOperatorAdminController.update);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && npx jest src/routes/__tests__/resellerOperators.route.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full reseller suite for regressions**

Run: `cd api && npx jest src/services/__tests__/resellerSale.service.test.ts src/services/__tests__/momoSale.reseller.test.ts src/routes/__tests__/reseller.route.test.ts`
Expected: PASS. If any test built an operator with `password`, update it to `seedOperator`.

- [ ] **Step 7: Commit**

```bash
cd api && git add src/controllers/resellerOperatorAdmin.controller.ts src/routes/reseller.route.ts src/routes/__tests__/resellerOperators.route.test.ts
git commit -m "feat(operators): in-portal operator management for MANAGE_OPERATORS"
```

---

## Task 7: Dashboard — reseller login by User ID + PIN

**Files:**
- Modify: `dashboard/src/lib/resellerApi.ts`
- Modify: `dashboard/src/contexts/ResellerAuthContext.tsx`
- Modify: `dashboard/src/pages/reseller/ResellerLoginPage.tsx`

**Interfaces:**
- Produces:
  - `resellerApi.login({ loginCode, pin }): Promise<{ accessToken; operator }>` — persists token AND operator to localStorage.
  - `resellerApi.getOperator(): ResellerOperator | null`.
  - `ResellerOperator` type without `mustChangePassword`.
  - Context `login(loginCode, pin)` and `operator` hydrated from storage on mount.

- [ ] **Step 1: Update `resellerApi.ts`**

In `dashboard/src/lib/resellerApi.ts`: add an operator-storage key, drop `mustChangePassword`, change the login signature, and persist the operator.

```typescript
const OPERATOR_KEY = 'carrot_reseller_operator';
```

Change the `ResellerOperator` interface to remove `mustChangePassword`:

```typescript
export interface ResellerOperator {
  id: string;
  fullName: string;
  role: string;
  resellerId: string;
  hubId: string;
}
```

Replace the `login` method and add `getOperator`, and clear the operator in `logout`:

```typescript
  async login(payload: { loginCode: string; pin: string }): Promise<{ accessToken: string; operator: ResellerOperator }> {
    const result = await request<{ accessToken: string; operator: ResellerOperator }>(
      '/reseller/auth/login',
      { method: 'POST', body: JSON.stringify(payload) },
      false
    );
    localStorage.setItem(TOKEN_KEY, result.accessToken);
    localStorage.setItem(OPERATOR_KEY, JSON.stringify(result.operator));
    return result;
  },

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(OPERATOR_KEY);
  },

  getOperator(): ResellerOperator | null {
    const raw = localStorage.getItem(OPERATOR_KEY);
    return raw ? (JSON.parse(raw) as ResellerOperator) : null;
  },
```

Add operator-management client methods (consumed in Task 9):

```typescript
export interface OperatorAdminRow {
  _id: string;
  fullName: string;
  loginCode: string;
  role: string;
  hubId: string;
  isActive: boolean;
}
export type IssuedCredentials = { operator: OperatorAdminRow; loginCode: string; pin: string };

export const resellerOperatorsApi = {
  list: () => request<OperatorAdminRow[]>('/reseller/operators'),
  create: (data: { fullName: string; role: string; hubId?: string; pin?: string }) =>
    request<IssuedCredentials>('/reseller/operators', { method: 'POST', body: JSON.stringify(data) }),
  resetPin: (id: string, pin?: string) =>
    request<{ operatorId: string; pin: string }>(`/reseller/operators/${id}/reset-pin`, {
      method: 'POST', body: JSON.stringify(pin ? { pin } : {}),
    }),
  setActive: (id: string, isActive: boolean) =>
    request<OperatorAdminRow>(`/reseller/operators/${id}`, {
      method: 'PATCH', body: JSON.stringify({ isActive }),
    }),
};
```

- [ ] **Step 2: Update `ResellerAuthContext.tsx`**

Replace the interface signature and `login`, and hydrate `operator` on mount:

```typescript
interface ResellerAuthContextType {
  operator: ResellerOperator | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (loginCode: string, pin: string) => Promise<void>;
  logout: () => void;
}
```

```typescript
  useEffect(() => {
    const token = resellerApi.getToken();
    if (token) {
      setIsAuthenticated(true);
      setOperator(resellerApi.getOperator());
    }
    setIsLoading(false);
  }, []);

  const login = async (loginCode: string, pin: string) => {
    const result = await resellerApi.login({ loginCode, pin });
    setOperator(result.operator);
    setIsAuthenticated(true);
  };
```

- [ ] **Step 3: Update `ResellerLoginPage.tsx`**

Swap the two fields and the submit call. Replace the `identifier`/`password` state and inputs with `loginCode`/`pin`:

```typescript
  const [loginCode, setLoginCode] = useState('');
  const [pin, setPin] = useState('');
```

```typescript
    try {
      await resellerApi.login({ loginCode, pin });
      navigate('/reseller', { replace: true });
    } catch (error: any) {
      toast.error(error.message || 'Login failed');
    } finally {
      setIsLoading(false);
    }
```

Replace the two form fields:

```tsx
            <div className="space-y-2">
              <Label htmlFor="loginCode">User ID</Label>
              <Input
                id="loginCode"
                inputMode="numeric"
                autoComplete="off"
                placeholder="6-digit user ID"
                value={loginCode}
                onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pin">PIN</Label>
              <Input
                id="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder="6-digit PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
              />
            </div>
```

- [ ] **Step 4: Type-check**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit`
Expected: no output (clean). Fix any reference to the removed `mustChangePassword` or old `login(identifier, password)` signature.

- [ ] **Step 5: Commit**

```bash
cd dashboard && git add src/lib/resellerApi.ts src/contexts/ResellerAuthContext.tsx src/pages/reseller/ResellerLoginPage.tsx
git commit -m "feat(operators): reseller portal logs in with User ID + PIN"
```

---

## Task 8: Dashboard — super-admin Operators tab (loginCode + reset PIN)

**Files:**
- Modify: `dashboard/src/lib/api.ts` (the `resellerAdmin` client: change `createOperator` response, add `resetOperatorPin`)
- Modify: `dashboard/src/pages/ResellerDetailPage.tsx` (`OperatorsTab`)

**Interfaces:**
- Consumes: super-admin endpoints from Task 5.
- Produces: `apiClient.resellerAdmin.createOperator(...)` → `{ operator, loginCode, pin }`; `apiClient.resellerAdmin.resetOperatorPin(id, pin?)` → `{ operatorId, pin }`.

- [ ] **Step 1: Update the admin API client**

In `dashboard/src/lib/api.ts` `resellerAdmin`: change `createOperator` to drop `password` and return issued credentials, and add `resetOperatorPin`:

```typescript
    createOperator: async (
      hubId: string,
      data: { fullName: string; phoneNumber?: string; email?: string; role: string; pin?: string }
    ): Promise<{ operator: { _id: string; fullName: string; loginCode: string; role: string }; loginCode: string; pin: string }> =>
      this.request(`/admin/hubs/${hubId}/operators`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    resetOperatorPin: async (operatorId: string, pin?: string): Promise<{ operatorId: string; pin: string }> =>
      this.request(`/admin/operators/${operatorId}/reset-pin`, {
        method: 'POST',
        body: JSON.stringify(pin ? { pin } : {}),
      }),
```

> Also extend the operator type used by `listOperators` to include `loginCode: string` (and drop `mustChangePassword`) wherever it is declared in `api.ts`/types.

- [ ] **Step 2: Update `OperatorsTab` create flow**

In `dashboard/src/pages/ResellerDetailPage.tsx`, in `OperatorsTab`:
- Remove the `password` field from `form` state and the password `<Input>`.
- On success, show the issued `loginCode` + `pin` instead of the temp password. Replace the `createOperator` mutation’s `mutationFn`/`onSuccess`:

```typescript
  const createOperator = useMutation({
    mutationFn: () =>
      apiClient.resellerAdmin.createOperator(selectedHubId, {
        fullName: form.fullName,
        phoneNumber: form.phoneNumber || undefined,
        email: form.email || undefined,
        role: form.role,
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['operators', selectedHubId] });
      toast.success(`Operator created. User ID: ${res.loginCode} · PIN: ${res.pin}`, { duration: 15000 });
      setIsAddOpen(false);
      setForm({ fullName: '', phoneNumber: '', email: '', role: 'reseller_operator' });
    },
    onError: (error: any) => toast.error(error.message || 'Failed to create operator'),
  });
```

Adjust the `form` state initializer and the submit guard to no longer reference `password`:

```typescript
  const [form, setForm] = useState({
    fullName: '',
    phoneNumber: '',
    email: '',
    role: 'reseller_operator',
  });
```

```typescript
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.fullName.trim()) return;
    createOperator.mutate();
  };
```

- [ ] **Step 3: Show loginCode + a Reset PIN action in the operators table**

Replace the operators table’s `Password` column header/cell with a `User ID` column and a `Reset PIN` action. In the `<TableHeader>`:

```tsx
              <TableHead>Name</TableHead>
              <TableHead>User ID</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
```

In the row body, add a reset mutation near the top of `OperatorsTab`:

```typescript
  const resetPin = useMutation({
    mutationFn: (operatorId: string) => apiClient.resellerAdmin.resetOperatorPin(operatorId),
    onSuccess: (res) => toast.success(`New PIN: ${res.pin}`, { duration: 15000 }),
    onError: (error: any) => toast.error(error.message || 'Failed to reset PIN'),
  });
```

and render each row as:

```tsx
              <TableRow key={op._id}>
                <TableCell className="font-medium">{op.fullName}</TableCell>
                <TableCell className="font-mono">{op.loginCode}</TableCell>
                <TableCell className="text-slate-600">{op.phoneNumber || op.email || '—'}</TableCell>
                <TableCell className="text-slate-600">{op.role}</TableCell>
                <TableCell>
                  <Badge variant={op.isActive ? 'default' : 'secondary'}>
                    {op.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="outline" size="sm" disabled={resetPin.isPending}
                    onClick={() => resetPin.mutate(op._id)}>
                    Reset PIN
                  </Button>
                </TableCell>
              </TableRow>
```

- [ ] **Step 4: Type-check**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit`
Expected: clean. Fix any remaining `password`/`mustChangePassword` references in this file.

- [ ] **Step 5: Commit**

```bash
cd dashboard && git add src/lib/api.ts src/pages/ResellerDetailPage.tsx
git commit -m "feat(operators): super-admin tab shows User ID and resets PIN"
```

---

## Task 9: Dashboard — in-portal operator management screen

**Files:**
- Create: `dashboard/src/pages/reseller/ResellerOperatorsPage.tsx`
- Modify: `dashboard/src/App.tsx` (add `/reseller/operators` route)
- Modify: `dashboard/src/pages/reseller/ResellerPosPage.tsx` (conditional nav link)

**Interfaces:**
- Consumes: `resellerOperatorsApi` (Task 7), `useResellerAuth().operator` (Task 7).

- [ ] **Step 1: Create the operators page**

```tsx
// dashboard/src/pages/reseller/ResellerOperatorsPage.tsx
import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { useResellerAuth } from '@/contexts/ResellerAuthContext';
import { resellerOperatorsApi } from '@/lib/resellerApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

const MANAGER_ROLES = ['reseller_admin', 'reseller_hub_manager'];

export function ResellerOperatorsPage() {
  const { operator } = useResellerAuth();
  const queryClient = useQueryClient();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [form, setForm] = useState({ fullName: '', role: 'reseller_operator' });

  const { data: operators = [], isLoading } = useQuery({
    queryKey: ['portal-operators'],
    queryFn: () => resellerOperatorsApi.list(),
  });

  const createOperator = useMutation({
    mutationFn: () => resellerOperatorsApi.create({ fullName: form.fullName, role: form.role }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['portal-operators'] });
      toast.success(`Created. User ID: ${res.loginCode} · PIN: ${res.pin}`, { duration: 15000 });
      setIsAddOpen(false);
      setForm({ fullName: '', role: 'reseller_operator' });
    },
    onError: (e: any) => toast.error(e.message || 'Failed to create operator'),
  });

  const resetPin = useMutation({
    mutationFn: (id: string) => resellerOperatorsApi.resetPin(id),
    onSuccess: (res) => toast.success(`New PIN: ${res.pin}`, { duration: 15000 }),
    onError: (e: any) => toast.error(e.message || 'Failed to reset PIN'),
  });

  // Only managers/admins reach this screen.
  if (operator && !MANAGER_ROLES.includes(operator.role)) {
    return <Navigate to="/reseller" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 space-y-6">
      <Link to="/reseller" className="inline-flex items-center text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to POS
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Operators</h1>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-orange-600 to-amber-600 text-white hover:opacity-90">
              Add Operator
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add Operator</DialogTitle></DialogHeader>
            <form
              onSubmit={(e) => { e.preventDefault(); if (form.fullName.trim()) createOperator.mutate(); }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="op-name">Full Name *</Label>
                <Input id="op-name" value={form.fullName} required
                  onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} />
              </div>
              {operator?.role === 'reseller_admin' && (
                <div className="space-y-2">
                  <Label htmlFor="op-role">Role</Label>
                  <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                    <SelectTrigger id="op-role"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reseller_operator">Operator</SelectItem>
                      <SelectItem value="reseller_hub_manager">Hub Manager</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex justify-end space-x-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createOperator.isPending || !form.fullName.trim()}
                  className="bg-gradient-to-r from-orange-600 to-amber-600 text-white hover:opacity-90">
                  {createOperator.isPending ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <p className="text-slate-500 text-sm py-4">Loading…</p>
          ) : operators.length === 0 ? (
            <p className="text-slate-500 text-sm py-4">No operators yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {operators.map((op) => (
                  <TableRow key={op._id}>
                    <TableCell className="font-medium">{op.fullName}</TableCell>
                    <TableCell className="font-mono">{op.loginCode}</TableCell>
                    <TableCell className="text-slate-600">{op.role}</TableCell>
                    <TableCell>
                      <Badge variant={op.isActive ? 'default' : 'secondary'}>
                        {op.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" disabled={resetPin.isPending}
                        onClick={() => resetPin.mutate(op._id)}>
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
    </div>
  );
}
```

- [ ] **Step 2: Add the route**

In `dashboard/src/App.tsx`, import the page and add a route inside the same `ResellerAuthProvider` tree as `/reseller`. Since `/reseller` currently renders a single element, add a sibling route that also wraps in the provider + guard:

```tsx
import { ResellerOperatorsPage } from '@/pages/reseller/ResellerOperatorsPage';
```

```tsx
                <Route
                  path="/reseller/operators"
                  element={
                    <ResellerAuthProvider>
                      <ResellerProtectedRoute>
                        <ResellerOperatorsPage />
                      </ResellerProtectedRoute>
                    </ResellerAuthProvider>
                  }
                />
```

> Place this route BEFORE the existing `/reseller` route is fine (react-router v6 matches exact paths), but keep `/reseller/login` and `/reseller` as-is.

- [ ] **Step 3: Add a conditional nav link in the POS header**

In `dashboard/src/pages/reseller/ResellerPosPage.tsx`, inside the `<header>` (near the logout button at line ~252), add a link visible only to managers/admins:

```tsx
import { Link } from 'react-router-dom';
```

```tsx
          {operator && ['reseller_admin', 'reseller_hub_manager'].includes(operator.role) && (
            <Link to="/reseller/operators" className="text-sm text-orange-600 hover:underline mr-4">
              Operators
            </Link>
          )}
```

- [ ] **Step 4: Type-check**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd dashboard && git add src/pages/reseller/ResellerOperatorsPage.tsx src/App.tsx src/pages/reseller/ResellerPosPage.tsx
git commit -m "feat(operators): in-portal operator management screen"
```

---

## Task 10: Full suites + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Run the entire api test suite**

Run: `cd api && npx jest`
Expected: all green. Any operator built with `password:` is a leftover — convert it to `seedOperator`.

- [ ] **Step 2: Build the dashboard**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit && npx vite build`
Expected: clean build.

- [ ] **Step 3: Manual smoke (local)**

Start the api and dashboard, then:
1. As super admin, open a reseller → Operators tab → create an operator → note the issued **User ID** + **PIN**.
2. Go to `/reseller/login`, log in with that User ID + PIN → lands on the POS.
3. As a `reseller_admin`/`reseller_hub_manager`, open the POS header **Operators** link → create an operator and reset a PIN.
4. Enter a wrong PIN 5× → confirm the 6th attempt is rejected as locked.

- [ ] **Step 4: Commit (if any fixups were needed)**

```bash
cd api && git add -A && git commit -m "test(operators): convert remaining fixtures to login code + PIN" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** model (Task 2), login+lockout (Tasks 3–4), creation issuing code/PIN (Tasks 5–6), MANAGE_OPERATORS-only reset with scope (Task 6), no self-service PIN (no such route is ever added), frontend login (Task 7), super-admin UI (Task 8), portal management UI (Task 9), test updates + migration-by-reseed (covered: no production operators, fixtures rebuilt). All spec sections map to a task.
- **Migration:** the spec chose reseed over a script. No migration code ships; existing dev operators are dropped/reseeded via fixtures. If a real operator existed, super-admin `createOperator` re-issues credentials.
- **Out of scope (per spec):** PIN-reset audit log, global IP rate limiting, PIN complexity rules. Not implemented here.
