# Waiter Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A waiter opens a table by number, adds items from several stalls onto it through the night, and settles the whole tab against one tag at the end.

**Architecture:** A new `Waiter` actor mirroring `Cashier` (per-event, own loginCode+PIN). A `Table` document holds snapshotted item lines, each naming the stall it came from. Settlement posts ONE balanced ledger entry — a single WALLET debit plus a MERCHANT credit and a FEES credit per stall at that stall's own commission — and writes an ordinary `MerchantCharge` per stall so existing stall reporting needs no knowledge of tables.

**Tech Stack:** Node 20, TypeScript, Express, Mongoose 8, MongoDB (replica set for ledger transactions), Jest + supertest, `mongodb-memory-server`.

**Spec:** `docs/superpowers/specs/2026-09-05-waiter-tables-design.md` — read it before Task 1. The plan argues from it.

## Global Constraints

- **All money is integer ZAR cents.** Never floats. Models validate with `Number.isSafeInteger`.
- **Ledger postings must sum to exactly zero**, debit-positive convention. `LedgerService.post` throws on an unbalanced set — never "correct" it.
- **A stall's `commissionPercent` is read fresh from its Merchant document** on every charge, never cached in a token or copied onto the table.
- **Item name and unitPrice are snapshotted at add time.** A later price change at the stall must not reprice a drink already drunk.
- **Run tests with `npx jest --runInBand`.** Parallel workers in this repo cause `Exceeded timeout of 30000 ms` in `beforeAll` as multiple in-memory Mongo instances start; those failures are environmental, not real.
- **Money-path tests need `connectLedgerTestDb`** (replica set) rather than `connectTestDb` — ledger writes run in a transaction.
- **`node_modules` is a shared symlink** across worktrees. Never `git clean -xfd`, never `git stash push -u`.
- Every task ends green: `npx tsc --noEmit` reports 0 errors and the task's tests pass.

---

# Slice 1 — The actor

Ends with a waiter able to log into the POS and see their event, and nothing else.

### Task 1: Waiter permissions and interface

**Files:**
- Create: `src/interfaces/waiter.interface.ts`
- Test: `src/interfaces/__tests__/waiterPermissions.test.ts`

**Interfaces:**
- Produces: `IWaiter`, `WaiterScope`, `WaiterPermission`, `WAITER_PERMISSIONS`, `WaiterToken`

- [ ] **Step 1: Write the failing test**

```ts
// src/interfaces/__tests__/waiterPermissions.test.ts
import { WaiterPermission, WAITER_PERMISSIONS } from '@interfaces/waiter.interface';

describe('what a waiter holds by default', () => {
  it('serves tables but does not settle them', () => {
    // Settling is the money moment. An organizer may want it held by a
    // supervisor rather than by whoever is carrying trays, so it is granted
    // per person — the same shape as issue_tags on a cashier.
    expect(WAITER_PERMISSIONS).toContain(WaiterPermission.VIEW_EVENTS);
    expect(WAITER_PERMISSIONS).toContain(WaiterPermission.MANAGE_TABLES);
    expect(WAITER_PERMISSIONS).not.toContain(WaiterPermission.SETTLE_TABLES);
  });

  it('namespaces every permission so it can never be confused with a cashier one', () => {
    for (const p of Object.values(WaiterPermission)) {
      expect(p.startsWith('waiter:')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/interfaces/__tests__/waiterPermissions.test.ts`
Expected: FAIL — cannot find module `@interfaces/waiter.interface`.

- [ ] **Step 3: Write the interface**

```ts
// src/interfaces/waiter.interface.ts
import { Document, Types } from 'mongoose';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

/**
 * A Waiter works the FLOOR for an organizer: opens a table, collects items
 * from several stalls onto it, and settles it at the end. Its own actor,
 * mirroring Cashier — NOT a MerchantOperator with a grant, because that actor
 * is scoped to exactly one stall and crossing stalls is this job's whole point.
 */
export type WaiterScope = 'platform' | 'organizer';

export interface IWaiter extends Document {
  fullName: string;
  phoneNumber?: string;
  loginCode: string;
  pin: string;
  scope: WaiterScope;
  vendorId?: Types.ObjectId;
  /** The single event this waiter works. Unset only for platform scope. */
  eventId?: Types.ObjectId;
  isActive: boolean;
  failedPinAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt?: Date;
  /** Inherited from applyOperatorCredentials. Only SETTLE_TABLES uses one today. */
  grants?: OperatorGrant[];
  comparePin(candidate: string): Promise<boolean>;
}

export enum WaiterPermission {
  VIEW_EVENTS = 'waiter:view_events',
  MANAGE_TABLES = 'waiter:manage_tables',
  /** The money moment — granted per person, so absent from WAITER_PERMISSIONS. */
  SETTLE_TABLES = 'waiter:settle_tables',
}

/** Every permission a waiter holds without an extra grant. */
export const WAITER_PERMISSIONS: WaiterPermission[] = [
  WaiterPermission.VIEW_EVENTS,
  WaiterPermission.MANAGE_TABLES,
];

/** JWT payload minted by WaiterAuthService.login, verified by authenticateWaiter. */
export interface WaiterToken {
  scope: 'waiter';
  userType: 'waiter';
  waiterId: string;
  role: 'waiter';
  permissions: WaiterPermission[];
  isSuperAdmin: boolean;
  fullName: string;
  vendorId?: string;
  eventId?: string;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest --runInBand src/interfaces/__tests__/waiterPermissions.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/waiter.interface.ts src/interfaces/__tests__/waiterPermissions.test.ts
git commit -m "feat(waiter): the waiter's permission namespace

Settling is deliberately absent from the default set: serving and taking
money are different jobs, so it is granted per person like issue_tags on a
cashier."
```

---

### Task 2: The Waiter model

**Files:**
- Create: `src/models/waiter.model.ts`
- Test: `src/models/__tests__/waiter.model.test.ts`

**Interfaces:**
- Consumes: `IWaiter` (Task 1)
- Produces: `Waiter` mongoose model

- [ ] **Step 1: Write the failing test**

```ts
// src/models/__tests__/waiter.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Waiter } from '@models/waiter.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const base = {
  fullName: 'Thabo', loginCode: 'WTR001', pin: '123456',
  scope: 'organizer' as const,
  vendorId: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId(),
};

describe('the Waiter actor', () => {
  it('hashes the PIN and never returns it by default', async () => {
    const w = await Waiter.create(base);
    expect(w.pin).not.toBe('123456');
    const read = await Waiter.findById(w._id);
    expect(read!.pin).toBeUndefined();
  });

  it('compares a PIN through the shared credential mixin', async () => {
    await Waiter.create(base);
    const w = await Waiter.findOne({ loginCode: 'WTR001' }).select('+pin');
    expect(await w!.comparePin('123456')).toBe(true);
    expect(await w!.comparePin('000000')).toBe(false);
  });

  it('requires an event for an organizer waiter', async () => {
    // A floor waiter is hired for ONE event and ends with it, same as a cashier.
    const { eventId, ...noEvent } = base;
    await expect(Waiter.create(noEvent)).rejects.toThrow();
  });

  it('refuses to move a waiter to another event', async () => {
    const w = await Waiter.create(base);
    const other = new mongoose.Types.ObjectId();
    w.eventId = other;
    await w.save();
    expect(String((await Waiter.findById(w._id))!.eventId)).toBe(String(base.eventId));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/models/__tests__/waiter.model.test.ts`
Expected: FAIL — cannot find module `@models/waiter.model`.

- [ ] **Step 3: Write the model**

Mirror `src/models/cashier.model.ts` exactly, swapping the names. The `pin`
hashing, `comparePin`, lockout fields and `grants` all come from
`applyOperatorCredentials`, so do NOT redeclare them.

```ts
// src/models/waiter.model.ts
import mongoose, { Schema } from 'mongoose';
import { IWaiter } from '@interfaces/waiter.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

/**
 * Floor waiter for an organizer — opens tables, collects items from several
 * stalls onto them, settles at the end. Same PIN-login shape as Cashier via
 * applyOperatorCredentials.
 *
 * Like a cashier and unlike a gate operator, a waiter works exactly ONE event,
 * so this carries `eventId` rather than the shared multi-event `eventIds`.
 */
const waiterSchema = new Schema<IWaiter>({
  fullName: { type: String, required: true, trim: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  scope: { type: String, required: true, enum: ['platform', 'organizer'], index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    index: true,
    immutable: true,
    required: function (this: { scope?: string }) { return this.scope === 'organizer'; },
  },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(waiterSchema);

waiterSchema.index({ vendorId: 1, isActive: 1 });
waiterSchema.index({ eventId: 1, isActive: 1 });

export const Waiter = mongoose.model<IWaiter>('Waiter', waiterSchema);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest --runInBand src/models/__tests__/waiter.model.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/models/waiter.model.ts src/models/__tests__/waiter.model.test.ts
git commit -m "feat(waiter): the Waiter model, mirroring Cashier

One event per waiter and immutable, same as a cashier: a floor waiter is
hired for a show and ends with it."
```

---

### Task 3: Waiter login

**Files:**
- Create: `src/services/waiterAuth.service.ts`
- Modify: `src/interfaces/operatorGrant.interface.ts` (add the waiter mapping)
- Modify: `src/controllers/operatorAuth.controller.ts` (add the `waiter` branch)
- Test: `src/routes/__tests__/waiterLogin.route.test.ts`

**Interfaces:**
- Consumes: `Waiter` (Task 2), `WAITER_PERMISSIONS`, `WaiterPermission` (Task 1)
- Produces: `WaiterAuthService.login(loginCode, pin)` → `{ accessToken, operator }`; `grantedWaiterPermissions(grants)`

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/waiterLogin.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Waiter } from '@models/waiter.model';
import { WaiterPermission } from '@interfaces/waiter.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const hire = (over: Record<string, unknown> = {}) =>
  Waiter.create({
    fullName: 'Thabo', loginCode: 'WTR001', pin: '123456', scope: 'organizer',
    vendorId: new mongoose.Types.ObjectId(), eventId: new mongoose.Types.ObjectId(),
    ...over,
  });

const login = (loginCode: string, pin: string) =>
  request(app).post('/api/operator/login').send({ loginCode, pin });

describe('a waiter logging into the POS', () => {
  it('answers type waiter so the POS opens the floor screen', async () => {
    await hire();
    const res = await login('WTR001', '123456');
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('waiter');
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  it('carries the default permissions but not settle', async () => {
    await hire();
    const res = await login('WTR001', '123456');
    const payload = JSON.parse(
      Buffer.from(res.body.data.accessToken.split('.')[1], 'base64').toString(),
    );
    expect(payload.permissions).toContain(WaiterPermission.MANAGE_TABLES);
    expect(payload.permissions).not.toContain(WaiterPermission.SETTLE_TABLES);
    expect(payload.eventId).toEqual(expect.any(String));
  });

  it('adds settle when the organizer granted it', async () => {
    await hire({ grants: [OperatorGrant.SETTLE_TABLES] });
    const res = await login('WTR001', '123456');
    const payload = JSON.parse(
      Buffer.from(res.body.data.accessToken.split('.')[1], 'base64').toString(),
    );
    expect(payload.permissions).toContain(WaiterPermission.SETTLE_TABLES);
  });

  it('refuses a deactivated waiter with the same generic message', async () => {
    await hire({ isActive: false });
    const res = await login('WTR001', '123456');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid credentials/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/routes/__tests__/waiterLogin.route.test.ts`
Expected: FAIL — no `waiter` branch, login returns 401.

- [ ] **Step 3: Add the grant and its waiter mapping**

In `src/interfaces/operatorGrant.interface.ts`, add to the `OperatorGrant` enum:

```ts
  /**
   * SETTLING a table — taking the money at the end of service. Separate from
   * serving because they are different jobs: an organizer may want the money
   * moment held by a supervisor. Held by a Waiter; it means nothing on any
   * other actor, whose namespaces have no mapping for it.
   */
  SETTLE_TABLES = 'settle_tables',
```

Add the waiter namespace map beside the existing `GRANT_TO_TICKETS` / `GRANT_TO_CASHIER` maps, and export a resolver mirroring `grantedCashierPermissions`:

```ts
const GRANT_TO_WAITER: Partial<Record<OperatorGrant, WaiterPermission>> = {
  [OperatorGrant.SETTLE_TABLES]: WaiterPermission.SETTLE_TABLES,
};

export function grantedWaiterPermissions(grants: unknown): WaiterPermission[] {
  return sanitizeGrants(grants)
    .map((g) => GRANT_TO_WAITER[g])
    .filter((p): p is WaiterPermission => !!p);
}
```

- [ ] **Step 4: Write the auth service**

Copy `src/services/cashierAuth.service.ts` and swap the actor. Keep the lockout
calls and the generic `Invalid credentials` on every failure — a message that
distinguishes "no such code" from "wrong PIN" is a login oracle.

```ts
// src/services/waiterAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { Waiter } from '@models/waiter.model';
import { WAITER_PERMISSIONS } from '@interfaces/waiter.interface';
import { grantedWaiterPermissions } from '@interfaces/operatorGrant.interface';
import { JWT_SECRET } from '@config/jwt.config';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';
import { recordFailedPinAttempt, clearPinLockout } from '@utils/pinLockout.util';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';

export class WaiterAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    const waiter = await Waiter.findOne({
      loginCode: normalizeLoginCode(loginCode), isActive: true,
    }).select('+pin');
    if (!waiter) throw new Error('Invalid credentials');

    if (waiter.lockedUntil && waiter.lockedUntil.getTime() > Date.now()) {
      throw new Error('Account locked. Try again later.');
    }

    const ok = await waiter.comparePin(pin);
    if (!ok) {
      await recordFailedPinAttempt(Waiter, waiter._id as any);
      throw new Error('Invalid credentials');
    }
    await clearPinLockout(Waiter, waiter._id as any);

    const isSuperAdmin = waiter.scope === 'platform';
    const payload: Record<string, unknown> = {
      scope: 'waiter',
      userType: 'waiter',
      waiterId: (waiter._id as any).toString(),
      role: 'waiter',
      permissions: [...WAITER_PERMISSIONS, ...grantedWaiterPermissions(waiter.grants)],
      isSuperAdmin,
      fullName: waiter.fullName,
    };
    if (!isSuperAdmin && waiter.vendorId) payload['vendorId'] = waiter.vendorId.toString();
    if (!isSuperAdmin && waiter.eventId) payload['eventId'] = waiter.eventId.toString();

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    return {
      accessToken,
      operator: {
        id: (waiter._id as any).toString(),
        fullName: waiter.fullName,
        scope: waiter.scope,
        eventId: waiter.eventId ? waiter.eventId.toString() : null,
      },
    };
  }
}
```

- [ ] **Step 5: Add the login branch**

In `src/controllers/operatorAuth.controller.ts`, add `Waiter.exists({ loginCode: code, isActive: true })` to the existing `Promise.all` lookup, and a branch beside the cashier one:

```ts
        if (waiter) {
          const result = await WaiterAuthService.login(code, pin);
          ApiResponseUtil.success(res, { type: 'waiter', ...result });
          return;
        }
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx jest --runInBand src/routes/__tests__/waiterLogin.route.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/services/waiterAuth.service.ts src/interfaces/operatorGrant.interface.ts src/controllers/operatorAuth.controller.ts src/routes/__tests__/waiterLogin.route.test.ts
git commit -m "feat(waiter): PIN login answering type:waiter

The POS routes on one field, the way it already does for register vs gate.
settle_tables joins as a grant that means nothing in any other namespace."
```

---

### Task 4: Waiter auth middleware and the events route

**Files:**
- Create: `src/middleware/waiterAuth.middleware.ts`
- Create: `src/controllers/waiter.controller.ts`
- Create: `src/routes/waiter.route.ts`
- Modify: `src/app.ts` (mount `/api/waiter`)
- Test: `src/routes/__tests__/waiterEvents.route.test.ts`

**Interfaces:**
- Consumes: `WaiterToken` (Task 1), `WaiterAuthService` (Task 3)
- Produces: `authenticateWaiter`, `requireWaiterPermission(p)`, `WaiterController.getEvents`, `loadWaiterEvent(req, res)` — the shared guard every later table route uses; returns the event or null having already answered

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/waiterEvents.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WAITER_PERMISSIONS } from '@interfaces/waiter.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seed() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(new mongoose.Types.ObjectId()),
    role: 'waiter', permissions: WAITER_PERMISSIONS, isSuperAdmin: false,
    fullName: 'Thabo', vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { eventId: String(event._id), token };
}

describe('the waiter floor screen', () => {
  it('lists the event this waiter works', async () => {
    const { eventId, token } = await seed();
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.events.map((e: any) => e.id)).toEqual([eventId]);
  });

  it('401s without a waiter token', async () => {
    await seed();
    const res = await request(app).get('/api/waiter/events');
    expect(res.status).toBe(401);
  });

  it('401s a cashier token — the scope claim is not interchangeable', async () => {
    await seed();
    const cashierToken = jwt.sign({ scope: 'cashier', userType: 'cashier' }, JWT_SECRET);
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/routes/__tests__/waiterEvents.route.test.ts`
Expected: FAIL — 404, route not mounted.

- [ ] **Step 3: Write the middleware**

Mirror `src/middleware/cashierAuth.middleware.ts`. `verifyToken` must reject any
token whose `scope !== 'waiter'`.

```ts
// src/middleware/waiterAuth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';
import { WaiterPermission } from '@interfaces/waiter.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

export const authenticateWaiter = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const header = req.headers.authorization;
    if (!header) { ApiResponseUtil.unauthorized(res, 'No authorization header provided'); return; }
    const token = header.replace('Bearer ', '');
    if (!token) { ApiResponseUtil.unauthorized(res, 'No token provided'); return; }
    const decoded = jwt.verify(token, JWT_SECRET) as { scope?: string };
    if (decoded.scope !== 'waiter') throw new Error('Invalid or expired token');
    (req as any).waiter = decoded;
    next();
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
  }
};

export const requireWaiterPermission = (permission: WaiterPermission) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const waiter = (req as any).waiter;
    if (!waiter) { ApiResponseUtil.unauthorized(res, 'Authentication required'); return; }
    if (!(waiter.permissions || []).includes(permission)) {
      ApiResponseUtil.forbidden(res, `Permission required: ${permission}`); return;
    }
    next();
  };
```

- [ ] **Step 4: Write the controller with the shared event guard**

```ts
// src/controllers/waiter.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { WaiterToken } from '@interfaces/waiter.interface';

/**
 * Load the event this waiter is working and assert they may act on it. Every
 * table route goes through here, so the "is this my show, and is it even
 * cashless" question is answered in exactly one place. Returns null having
 * ALREADY answered the response.
 */
export async function loadWaiterEvent(req: Request, res: Response): Promise<any | null> {
  const waiter = (req as any).waiter as WaiterToken;
  if (!waiter.eventId) { ApiResponseUtil.forbidden(res, 'No event on this waiter'); return null; }
  const event = await Event.findById(waiter.eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  if (!event.cashless) { ApiResponseUtil.error(res, 'Event is not cashless', 400); return null; }
  return event;
}

export class WaiterController {
  /** GET /api/waiter/events — the one event this waiter works. */
  static async getEvents(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    return ApiResponseUtil.success(res, {
      events: [{
        id: String(event._id), name: event.name, venue: event.venue,
        eventDate: event.eventDate,
      }],
    });
  }
}
```

- [ ] **Step 5: Write the route and mount it**

```ts
// src/routes/waiter.route.ts
import { Router } from 'express';
import { WaiterController } from '@controllers/waiter.controller';
import { authenticateWaiter, requireWaiterPermission } from '@middleware/waiterAuth.middleware';
import { WaiterPermission } from '@interfaces/waiter.interface';

const router = Router();
router.use(authenticateWaiter);

router.get('/events', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), WaiterController.getEvents);

export default router;
```

In `src/app.ts`, beside the existing `/api/cashier` mount:

```ts
app.use('/api/waiter', waiterRoutes);
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx jest --runInBand src/routes/__tests__/waiterEvents.route.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/middleware/waiterAuth.middleware.ts src/controllers/waiter.controller.ts src/routes/waiter.route.ts src/app.ts src/routes/__tests__/waiterEvents.route.test.ts
git commit -m "feat(waiter): authenticate the floor and expose its event

loadWaiterEvent is the single place the my-show-and-is-it-cashless question
is answered; every table route below goes through it."
```

---

### Task 5: Hire, disable and reset a waiter

**Files:**
- Create: `src/controllers/waiterAdmin.controller.ts`
- Modify: `src/routes/tickets.route.ts` (four routes beside the cashier ones, ~line 570)
- Test: `src/routes/__tests__/waiterAdmin.route.test.ts`

**Interfaces:**
- Consumes: `Waiter` (Task 2)
- Produces: `POST /api/tickets/waiters`, `GET /api/tickets/waiters`, `PATCH /api/tickets/waiters/:id`, `POST /api/tickets/waiters/:id/reset-pin`

- [ ] **Step 1: Write the failing test**

Copy the structure of `src/routes/__tests__/cashierAdmin.route.test.ts`. Cover:
hiring returns a login code and PIN once; the organizer is DERIVED from the
event when a super-admin does not name one (`CashierAdminController.create` is
the reference — a super-admin token carries no organizer); an organizer sees only
their own waiters; `grants` are patchable so `settle_tables` can be turned on
after hiring; and a non-existent event is refused with `Event not found`.

```ts
// src/routes/__tests__/waiterAdmin.route.test.ts — the shape of each case
it('derives the organizer from the event when an admin hires', async () => {
  const res = await request(app).post('/api/tickets/waiters')
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
    .send({ fullName: 'Thabo', eventId: myEventId });

  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  expect(res.body.data.pin).toMatch(/^\d{6}$/);
  expect(String(res.body.data.waiter.vendorId)).toBe(VENDOR_A);
});

it('turns settling on for somebody already hired', async () => {
  const hired = await hire('Thabo', myEventId);
  const res = await request(app).patch(`/api/tickets/waiters/${hired._id}`)
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
    .send({ grants: ['settle_tables'] });

  expect(res.status).toBe(200);
  expect((await Waiter.findById(hired._id))!.grants).toEqual(['settle_tables']);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/routes/__tests__/waiterAdmin.route.test.ts`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Write the admin controller**

Copy `src/controllers/cashierAdmin.controller.ts` wholesale and swap `Cashier`
for `Waiter`. Keep every guard, especially:
- `scopeFilter(req)` — an organizer sees only their own; a super-admin sees all.
- Deriving `vendorId` from the event when a super-admin does not supply one, and
  refusing an event with no organizer behind it.
- `sanitizeGrants` on both create and PATCH.
- `eventId` NOT patchable.

- [ ] **Step 4: Register the routes**

In `src/routes/tickets.route.ts`, beside the cashier block:

```ts
router.post('/waiters', requireSuperAdminOrPermission(TicketsPermission.MANAGE_ACCESS), WaiterAdminController.create);
router.get('/waiters', requireSuperAdminOrPermission(TicketsPermission.MANAGE_ACCESS), WaiterAdminController.list);
router.patch('/waiters/:id', requireSuperAdminOrPermission(TicketsPermission.MANAGE_ACCESS), WaiterAdminController.update);
router.post('/waiters/:id/reset-pin', requireSuperAdminOrPermission(TicketsPermission.MANAGE_ACCESS), WaiterAdminController.resetPin);
```

`requireSuperAdminOrPermission`, not `requireTicketsPermission`: a super-admin
token carries an EMPTY permissions array, and gating staff admin on the bare
check is the defect fixed in `5b4820c`.

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx jest --runInBand src/routes/__tests__/waiterAdmin.route.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/controllers/waiterAdmin.controller.ts src/routes/tickets.route.ts src/routes/__tests__/waiterAdmin.route.test.ts
git commit -m "feat(waiter): hire, disable and reset a waiter

Gated with requireSuperAdminOrPermission so Carrot staff can set up a floor
on an organizer's behalf — a super-admin token carries no permissions array."
```

---

### Task 5b: The dashboard's Waiters panel

**Files:**
- Create: `dashboard/src/components/WaitersPanel.tsx`
- Modify: `dashboard/src/lib/api.ts` (a `waiters` client beside `cashiers`)
- Modify: `dashboard/src/components/EventCashlessTab.tsx` (a Waiters sub-tab)
- Test: `dashboard/src/components/__tests__/WaitersPanel.test.tsx`

**Interfaces:**
- Consumes: the four routes from Task 5
- Produces: `apiClient.waiters.{list,create,setActive,setGrants,resetPin}`

- [ ] **Step 1: Write the failing test**

Model it on `dashboard/src/components/__tests__/EventCashlessTab.test.tsx`,
which already mocks `@/lib/api` and `sonner`. Cover: hiring shows the login
code and PIN once; the **Settling on/off** toggle calls `setGrants` with
`['settle_tables']` and with `[]`; and the toast says what the setting buys
rather than "saved", because the difference is who may take money.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/components/__tests__/WaitersPanel.test.tsx`
Expected: FAIL — cannot resolve `@/components/WaitersPanel`.

- [ ] **Step 3: Build the panel**

Copy `dashboard/src/components/CashiersPanel.tsx` and swap the actor. Keep the
credentials-shown-once dialog: the PIN is hashed and cannot be read back, so an
operator who closes that dialog without writing it down needs a reset.

- [ ] **Step 4: Add the sub-tab**

In `EventCashlessTab.tsx`, add a **Waiters** sub-tab beside Cashiers, gated
`canManageAccess(user)` — hiring floor staff is the same capability as hiring a
cashier.

- [ ] **Step 5: Run the test, typecheck and commit**

```bash
npx vitest run src/components/__tests__/WaitersPanel.test.tsx
npx tsc --noEmit -p tsconfig.app.json
git add -A
git commit -m "feat(waiter): hire and manage floor staff from the dashboard"
```

Note: the dashboard's shared `node_modules` is missing `react-easy-crop`, so
four unrelated suites fail to import. That is pre-existing; ignore those four
and check only that yours passes.

---

# Slice 2 — The tab

Ends with a working tab that cannot yet be paid. The half with no money in it, deliberately.

### Task 6: The Table model

**Files:**
- Create: `src/interfaces/table.interface.ts`
- Create: `src/models/table.model.ts`
- Test: `src/models/__tests__/table.model.test.ts`

**Interfaces:**
- Produces: `ITable`, `ITableLine`, `TableStatus`, `Table` model

- [ ] **Step 1: Write the failing test**

```ts
// src/models/__tests__/table.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Table } from '@models/table.model';

const EVENT = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await connectTestDb();
  await Table.syncIndexes();
});
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const open = (label: string) => ({
  eventId: EVENT, label, status: 'open' as const, openedBy: 'w1', items: [], subtotal: 0,
});

describe('a table', () => {
  it('cannot be open twice under one label at one event', async () => {
    await Table.create(open('7'));
    await expect(Table.create(open('7'))).rejects.toThrow(/duplicate key|E11000/i);
  });

  it('frees the label again once settled, so table 7 can be reused', async () => {
    const first = await Table.create(open('7'));
    await Table.updateOne({ _id: first._id }, { $set: { status: 'settled', settledAt: new Date() } });
    const second = await Table.create(open('7'));
    expect(second.label).toBe('7');
  });

  it('rejects a non-integer line price', async () => {
    // Money is integer cents everywhere. A float here would round somewhere
    // downstream, and a bill that does not add up is worse than a refusal.
    await expect(Table.create({
      ...open('8'),
      items: [{
        merchantId: new mongoose.Types.ObjectId(), productId: new mongoose.Types.ObjectId(),
        name: 'Beer', unitPrice: 30.5, qty: 1, addedBy: 'w1', addedAt: new Date(),
      }],
    })).rejects.toThrow(/integer/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/models/__tests__/table.model.test.ts`
Expected: FAIL — cannot find module `@models/table.model`.

- [ ] **Step 3: Write the interface and model**

```ts
// src/interfaces/table.interface.ts
import { Document, Types } from 'mongoose';

export type TableStatus = 'open' | 'settled' | 'voided';

/**
 * One line on a table. Name and unitPrice are SNAPSHOTTED at add time, the way
 * MerchantCharge.items already does: a price change at the stall must never
 * reprice a drink somebody already drank.
 */
export interface ITableLine {
  _id: Types.ObjectId;
  merchantId: Types.ObjectId;
  productId: Types.ObjectId;
  name: string;
  unitPrice: number;
  qty: number;
  addedBy: string;
  addedAt: Date;
}

export interface ITable extends Document {
  eventId: Types.ObjectId;
  label: string;
  status: TableStatus;
  openedBy: string;
  items: ITableLine[];
  subtotal: number;
  settledAt?: Date;
  settledBy?: string;
  walletId?: Types.ObjectId;
  voidedAt?: Date;
  voidReason?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

```ts
// src/models/table.model.ts
import mongoose, { Schema } from 'mongoose';
import { ITable } from '@interfaces/table.interface';

const integerCents = {
  validator: Number.isSafeInteger,
  message: '{PATH} must be integer minor units (ZAR cents)',
};

const tableLineSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true, trim: true },
  unitPrice: { type: Number, required: true, min: 0, validate: integerCents },
  qty: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
  addedBy: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
});

const tableSchema = new Schema<ITable>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  label: { type: String, required: true, trim: true },
  status: { type: String, enum: ['open', 'settled', 'voided'], default: 'open', required: true, index: true },
  openedBy: { type: String, required: true },
  items: { type: [tableLineSchema], default: [] },
  subtotal: { type: Number, default: 0, min: 0, validate: integerCents },
  settledAt: { type: Date },
  settledBy: { type: String },
  walletId: { type: Schema.Types.ObjectId, ref: 'Wallet' },
  voidedAt: { type: Date },
  voidReason: { type: String, trim: true },
}, { timestamps: true });

// One OPEN table per label per event. PARTIAL so a settled "7" frees the name
// for the next group — the same reasoning as the wallet bandUid index.
tableSchema.index(
  { eventId: 1, label: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);

export const Table = mongoose.model<ITable>('Table', tableSchema);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest --runInBand src/models/__tests__/table.model.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/table.interface.ts src/models/table.model.ts src/models/__tests__/table.model.test.ts
git commit -m "feat(tables): the Table model

Label uniqueness is PARTIAL on open tables so 'Table 7' is reusable after it
settles, and line prices are snapshotted so a stall's price change cannot
reprice a drink already drunk."
```

---

### Task 7: Open and list tables

**Files:**
- Create: `src/services/table.service.ts`
- Modify: `src/controllers/waiter.controller.ts`
- Modify: `src/routes/waiter.route.ts`
- Test: `src/routes/__tests__/waiterTables.route.test.ts`

**Interfaces:**
- Consumes: `loadWaiterEvent` (Task 4), `Table` (Task 6)
- Produces: `TableService.open({ eventId, label, openedBy })` → `ITable`; `TableService.list(eventId, status?)`; `POST /api/waiter/tables`, `GET /api/waiter/tables`

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/waiterTables.route.test.ts (opening)
it('opens a table by number', async () => {
  const { token } = await seedFloor();
  const res = await request(app).post('/api/waiter/tables')
    .set('Authorization', `Bearer ${token}`).send({ label: '7' });

  expect(res.status).toBe(201);
  expect(res.body.data.label).toBe('7');
  expect(res.body.data.status).toBe('open');
  expect(res.body.data.subtotal).toBe(0);
});

it('refuses a second open table under the same number', async () => {
  const { token } = await seedFloor();
  await request(app).post('/api/waiter/tables')
    .set('Authorization', `Bearer ${token}`).send({ label: '7' });

  const again = await request(app).post('/api/waiter/tables')
    .set('Authorization', `Bearer ${token}`).send({ label: '7' });

  expect(again.status).toBe(409);
  expect(again.body.message).toMatch(/already open/i);
});

it('requires a label', async () => {
  const { token } = await seedFloor();
  const res = await request(app).post('/api/waiter/tables')
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(400);
});

it('lists only this event tables', async () => {
  const mine = await seedFloor();
  const other = await seedFloor();
  await request(app).post('/api/waiter/tables')
    .set('Authorization', `Bearer ${mine.token}`).send({ label: '7' });

  const res = await request(app).get('/api/waiter/tables')
    .set('Authorization', `Bearer ${other.token}`);
  expect(res.body.data.tables).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/routes/__tests__/waiterTables.route.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Write the service**

```ts
// src/services/table.service.ts
import mongoose from 'mongoose';
import { Table } from '@models/table.model';
import { ITable } from '@interfaces/table.interface';

/** Thrown when a label is already open at this event — the caller maps it to 409. */
export class TableLabelTakenError extends Error {
  constructor(label: string) { super(`Table ${label} is already open`); }
}

export class TableService {
  static async open(params: { eventId: string; label: string; openedBy: string }): Promise<ITable> {
    const label = params.label.trim();
    if (!label) throw new Error('label is required');
    try {
      return await Table.create({
        eventId: new mongoose.Types.ObjectId(params.eventId),
        label, status: 'open', openedBy: params.openedBy, items: [], subtotal: 0,
      });
    } catch (err) {
      // The partial unique index is the arbiter, so two waiters opening "7" at
      // once cannot both win. Discriminated by keyPattern so an E11000 from any
      // other index is not mislabelled.
      if ((err as { keyPattern?: Record<string, unknown> })?.keyPattern?.label) {
        throw new TableLabelTakenError(label);
      }
      throw err;
    }
  }

  static async list(eventId: string, status?: string): Promise<ITable[]> {
    return Table.find({
      eventId: new mongoose.Types.ObjectId(eventId),
      ...(status ? { status } : {}),
    }).sort({ createdAt: -1 }).limit(200);
  }
}
```

- [ ] **Step 4: Add the handlers and routes**

`WaiterController.openTable` and `.listTables`, both starting with
`loadWaiterEvent`, mapping `TableLabelTakenError` to 409 and a missing label
to 400. Routes gated `requireWaiterPermission(WaiterPermission.MANAGE_TABLES)`.

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx jest --runInBand src/routes/__tests__/waiterTables.route.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/services/table.service.ts src/controllers/waiter.controller.ts src/routes/waiter.route.ts src/routes/__tests__/waiterTables.route.test.ts
git commit -m "feat(tables): open and list tables

Two waiters opening '7' at once is arbitrated by the partial unique index,
not by a read-then-write."
```

---

### Task 8: Add an item, and move the stall's stock

**Files:**
- Modify: `src/services/table.service.ts`
- Modify: `src/controllers/waiter.controller.ts`, `src/routes/waiter.route.ts`
- Test: `src/services/__tests__/tableAddItem.test.ts`

**Interfaces:**
- Consumes: `TableService.open` (Task 7), `StockService` movement writer, `Product`, `Merchant`
- Produces: `TableService.addItem({ tableId, eventId, merchantId, productId, qty, addedBy })` → `ITable`

- [ ] **Step 1: Write the shared test helpers**

Tasks 8, 9 and 10 all need the same fixtures. Put them in
`src/__tests__/helpers/tables.ts` so they are written once:

- `seedStall({ price, onHand })` → creates a Merchant on `EVENT`, a Product on
  that merchant at `price` cents, and a stock row with `onHand` units. Returns
  `{ merchantId, productId }`.
- `seedStallAndTable({ price, onHand })` → `seedStall` plus an open Table.
  Returns `{ table, merchantId, productId }`.
- `onHandFor(merchantId, productId)` → reads the current on-hand count, so a
  test asserts the stall's shelf rather than the movement log.

Model them on the fixtures in `src/services/__tests__/merchantCharge.items.service.test.ts`,
which already seeds a stall with priced, stocked products.

- [ ] **Step 2: Write the failing test**

```ts
// src/services/__tests__/tableAddItem.test.ts
it('snapshots the price and moves the stall stock', async () => {
  const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });

  const after = await TableService.addItem({
    tableId: String(table._id), eventId: EVENT, merchantId, productId, qty: 2, addedBy: 'w1',
  });

  expect(after.items).toHaveLength(1);
  expect(after.items[0]!.unitPrice).toBe(3000);
  expect(after.items[0]!.name).toBe('Beer');
  expect(after.subtotal).toBe(6000);
  // The drinks left the shelf when the waiter took them, not when the tab is
  // paid — a stall whose count only moves at settle is wrong all night.
  expect(await onHandFor(merchantId, productId)).toBe(8);
});

it('reprices nothing when the stall changes its price afterwards', async () => {
  const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
  await TableService.addItem({ tableId: String(table._id), eventId: EVENT, merchantId, productId, qty: 1, addedBy: 'w1' });
  await Product.updateOne({ _id: productId }, { $set: { price: 4000 } });

  const after = await TableService.addItem({ tableId: String(table._id), eventId: EVENT, merchantId, productId, qty: 1, addedBy: 'w1' });

  expect(after.items[0]!.unitPrice).toBe(3000);
  expect(after.items[1]!.unitPrice).toBe(4000);
  expect(after.subtotal).toBe(7000);
});

it('holds items from two different stalls on one table', async () => {
  const a = await seedStallAndTable({ price: 3000, onHand: 10 });
  const b = await seedStall({ price: 1500, onHand: 10 });
  await TableService.addItem({ tableId: String(a.table._id), eventId: EVENT, merchantId: a.merchantId, productId: a.productId, qty: 1, addedBy: 'w1' });
  const after = await TableService.addItem({ tableId: String(a.table._id), eventId: EVENT, merchantId: b.merchantId, productId: b.productId, qty: 1, addedBy: 'w1' });

  expect(new Set(after.items.map((i) => String(i.merchantId))).size).toBe(2);
  expect(after.subtotal).toBe(4500);
});

it('refuses a product that belongs to another stall', async () => {
  const a = await seedStallAndTable({ price: 3000, onHand: 10 });
  const b = await seedStall({ price: 1500, onHand: 10 });
  await expect(TableService.addItem({
    tableId: String(a.table._id), eventId: EVENT, merchantId: a.merchantId, productId: b.productId, qty: 1, addedBy: 'w1',
  })).rejects.toThrow(/not sold at that stall/i);
});

it('refuses to add to a settled table', async () => {
  const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
  await Table.updateOne({ _id: table._id }, { $set: { status: 'settled' } });
  await expect(TableService.addItem({
    tableId: String(table._id), eventId: EVENT, merchantId, productId, qty: 1, addedBy: 'w1',
  })).rejects.toThrow(/not open/i);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx jest --runInBand src/services/__tests__/tableAddItem.test.ts`
Expected: FAIL — `TableService.addItem is not a function`.

- [ ] **Step 4: Implement addItem**

Validate the product belongs to the named stall and the stall to this event;
snapshot `name` and `price`; `$push` the line and `$inc` the subtotal in one
update guarded on `status: 'open'`; write the stock movement with
`StockMovementReason.SALE`, `refType: 'table'`, `refId: tableId`. Read
`src/services/merchant.service.ts:230-250` for the movement call shape.

Use SALE rather than a new reason: the item genuinely left as a sale, and a new
reason would have to be taught to every stock report before any of them were
correct.

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx jest --runInBand src/services/__tests__/tableAddItem.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Add the route and commit**

`POST /api/waiter/tables/:id/items`, gated `MANAGE_TABLES`, behind
`loadWaiterEvent`.

```bash
npx tsc --noEmit
git add -A
git commit -m "feat(tables): add an item from a stall, moving its stock

Stock leaves at add time because the drink did. Money and stock legitimately
disagree in time for the life of a tab; that is what a tab is."
```

---

### Task 9: Remove a line, and give the stock back

**Files:**
- Modify: `src/services/table.service.ts`, `src/controllers/waiter.controller.ts`, `src/routes/waiter.route.ts`
- Test: `src/services/__tests__/tableRemoveItem.test.ts`

**Interfaces:**
- Produces: `TableService.removeItem({ tableId, lineId, removedBy })` → `ITable`

- [ ] **Step 1: Write the failing test**

```ts
it('returns the stock — this is the mis-punch, the drink never left the counter', async () => {
  const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
  const withItem = await TableService.addItem({ tableId: String(table._id), eventId: EVENT, merchantId, productId, qty: 2, addedBy: 'w1' });
  expect(await onHandFor(merchantId, productId)).toBe(8);

  const after = await TableService.removeItem({
    tableId: String(table._id), lineId: String(withItem.items[0]!._id), removedBy: 'w1',
  });

  expect(after.items).toHaveLength(0);
  expect(after.subtotal).toBe(0);
  expect(await onHandFor(merchantId, productId)).toBe(10);
});

it('refuses on a settled table', async () => {
  const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
  const withItem = await TableService.addItem({ tableId: String(table._id), eventId: EVENT, merchantId, productId, qty: 1, addedBy: 'w1' });
  await Table.updateOne({ _id: table._id }, { $set: { status: 'settled' } });

  await expect(TableService.removeItem({
    tableId: String(table._id), lineId: String(withItem.items[0]!._id), removedBy: 'w1',
  })).rejects.toThrow(/not open/i);
});

it('404s a line that is not on this table', async () => {
  const { table } = await seedStallAndTable({ price: 3000, onHand: 10 });
  await expect(TableService.removeItem({
    tableId: String(table._id), lineId: String(new mongoose.Types.ObjectId()), removedBy: 'w1',
  })).rejects.toThrow(/line not found/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/services/__tests__/tableRemoveItem.test.ts`
Expected: FAIL — `removeItem is not a function`.

- [ ] **Step 3: Implement removeItem**

`$pull` the line and `$inc` the subtotal down, guarded on `status: 'open'`;
write the compensating stock movement with `StockMovementReason.MANUAL`,
`refType: 'table_line_removed'`, `refId: lineId`, so the return is visible as
its own event rather than a silently smaller SALE.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest --runInBand src/services/__tests__/tableRemoveItem.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the route and commit**

`DELETE /api/waiter/tables/:id/items/:lineId`, gated `MANAGE_TABLES`.

```bash
npx tsc --noEmit
git add -A
git commit -m "feat(tables): remove a line and return its stock

The compensating movement is its own event, not a smaller SALE — a stock
history you cannot read backwards is not an audit trail."
```

---

### Task 10: Void a table

**Files:**
- Modify: `src/services/table.service.ts`, `src/controllers/waiter.controller.ts`, `src/routes/waiter.route.ts`
- Test: `src/services/__tests__/tableVoid.test.ts`

**Interfaces:**
- Produces: `TableService.voidTable({ tableId, reason, voidedBy })` → `ITable`

- [ ] **Step 1: Write the failing test**

```ts
it('closes the table unpaid and does NOT return the stock', async () => {
  // The drinks were consumed or walked. Returning them to the shelf would make
  // a real loss look like it never happened; a voided table IS the record of it.
  const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
  await TableService.addItem({ tableId: String(table._id), eventId: EVENT, merchantId, productId, qty: 2, addedBy: 'w1' });

  const after = await TableService.voidTable({ tableId: String(table._id), reason: 'walked out', voidedBy: 'w1' });

  expect(after.status).toBe('voided');
  expect(after.voidReason).toBe('walked out');
  expect(after.subtotal).toBe(6000);
  expect(await onHandFor(merchantId, productId)).toBe(8);
});

it('requires a reason', async () => {
  const { table } = await seedStallAndTable({ price: 3000, onHand: 10 });
  await expect(TableService.voidTable({ tableId: String(table._id), reason: '  ', voidedBy: 'w1' }))
    .rejects.toThrow(/reason is required/i);
});

it('will not void a settled table', async () => {
  const { table } = await seedStallAndTable({ price: 3000, onHand: 10 });
  await Table.updateOne({ _id: table._id }, { $set: { status: 'settled' } });
  await expect(TableService.voidTable({ tableId: String(table._id), reason: 'oops', voidedBy: 'w1' }))
    .rejects.toThrow(/not open/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/services/__tests__/tableVoid.test.ts`
Expected: FAIL — `void is not a function`.

- [ ] **Step 3: Implement voidTable, add the route, and commit**

Guarded `findOneAndUpdate({ _id, status: 'open' }, { status: 'voided', voidedAt, voidReason })`.
Route `POST /api/waiter/tables/:id/void`, gated `MANAGE_TABLES`.

```bash
npx tsc --noEmit
git add -A
git commit -m "feat(tables): void an unpaid table, keeping the loss visible

Stock is not returned: pretending walked drinks came back would erase the
number that tells an organizer whether table service costs them money."
```

---

# Slice 3 — Settlement

Every money risk in this feature lives here, which is why it lands last and alone.

### Task 11: A charge may name a waiter instead of a till operator

**Files:**
- Modify: `src/models/merchantCharge.model.ts`, `src/interfaces/merchantCharge.interface.ts` (or wherever `IMerchantCharge` lives)
- Test: `src/models/__tests__/merchantChargeWaiter.test.ts`

**Interfaces:**
- Produces: `MerchantCharge.merchantOperatorId` optional; `MerchantCharge.waiterId?: Types.ObjectId`

- [ ] **Step 1: Write the failing test**

```ts
it('accepts a charge raised by a waiter with no till operator', async () => {
  const charge = await MerchantCharge.create({
    merchantId: M, eventId: E, walletId: W, bandUid: '04a22b1c',
    amount: 3000, fee: 0, netAmount: 3000, clientTxnId: 't1', status: 'completed',
    waiterId: WAITER, staffName: 'Thabo',
  });
  expect(charge.merchantOperatorId).toBeUndefined();
  expect(String(charge.waiterId)).toBe(String(WAITER));
});

it('still names a human either way', async () => {
  // staffName is what every existing display reads. A charge that names nobody
  // is a charge no one can be asked about.
  await expect(MerchantCharge.create({
    merchantId: M, eventId: E, walletId: W, bandUid: '04a22b1c',
    amount: 3000, fee: 0, netAmount: 3000, clientTxnId: 't2', status: 'completed',
    waiterId: WAITER,
  })).rejects.toThrow(/staffName/i);
});

it('keeps accepting an ordinary till charge unchanged', async () => {
  const charge = await MerchantCharge.create({
    merchantId: M, eventId: E, walletId: W, bandUid: '04a22b1c',
    amount: 3000, fee: 0, netAmount: 3000, clientTxnId: 't3', status: 'completed',
    merchantOperatorId: OP, staffName: 'Sipho',
  });
  expect(String(charge.merchantOperatorId)).toBe(String(OP));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/models/__tests__/merchantChargeWaiter.test.ts`
Expected: FAIL — `merchantOperatorId` is required.

- [ ] **Step 3: Make the change**

Drop `required: true` from `merchantOperatorId`, keep its index, add
`waiterId: { type: Schema.Types.ObjectId, ref: 'Waiter', index: true }`, and
make `staffName` required. Update `IMerchantCharge` to match
(`merchantOperatorId?`, `waiterId?`).

Add a comment at the field recording that a charge raised from a table has a
WAITER rather than a till operator, and that reports grouping by operator must
treat the absent case as table service rather than dropping the row — it is
still money the stall is owed.

- [ ] **Step 4: Run the whole merchant suite, not just the new test**

Run: `npx jest --silent --runInBand src/services/__tests__/merchantCharge.service.test.ts src/services/__tests__/merchantCharge.items.service.test.ts src/services/__tests__/settlement.service.test.ts src/services/__tests__/walletReconciliation.merchant.test.ts src/models/__tests__/merchantChargeWaiter.test.ts`
Expected: all PASS. This is the one change touching money code that already works.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add -A
git commit -m "feat(tables): a merchant charge may name a waiter instead of a till operator

merchantOperatorId becomes optional with waiterId alongside; staffName is now
required so every charge still names a human. Reports grouping by operator
must read the absent case as table service, not drop the row."
```

---

### Task 12: Settle a table

**Files:**
- Modify: `src/services/table.service.ts`, `src/controllers/waiter.controller.ts`, `src/routes/waiter.route.ts`
- Test: `src/services/__tests__/tableSettle.test.ts` (uses `connectLedgerTestDb`)

**Interfaces:**
- Consumes: `LedgerService.post`, `Wallet`, `Merchant`, `MerchantCharge`, `Table`
- Produces: `TableService.settle({ tableId, eventId, bandUid, settledBy, clientTxnId })` → `{ table, charges, walletBalance }`; `TableShortfallError`

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/tableSettle.test.ts
beforeAll(connectLedgerTestDb, 60000);

it('pays every stall from one tap, each at its own commission', async () => {
  const { table, stallA, stallB } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 10, commissionB: 0 });
  const wallet = await fundedWallet(10000, '04a22b1c');

  const { charges } = await TableService.settle({
    tableId: String(table._id), eventId: EVENT, bandUid: '04a22b1c',
    settledBy: 'w1', clientTxnId: 's1',
  });

  expect((await Wallet.findById(wallet._id))!.balance).toBe(5500);
  const byStall = Object.fromEntries(charges.map((c) => [String(c.merchantId), c]));
  expect(byStall[String(stallA)]!.netAmount).toBe(2700);   // 10% commission
  expect(byStall[String(stallA)]!.fee).toBe(300);
  expect(byStall[String(stallB)]!.netAmount).toBe(1500);   // 0%
  expect(byStall[String(stallB)]!.fee).toBe(0);
});

it('posts ONE balanced journal entry for the whole table', async () => {
  const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 10, commissionB: 0 });
  await fundedWallet(10000, '04a22b1c');

  await TableService.settle({ tableId: String(table._id), eventId: EVENT, bandUid: '04a22b1c', settledBy: 'w1', clientTxnId: 's1' });

  const entries = await LedgerEntry.find({ refType: 'table_settlement', refId: String(table._id) });
  const sum = entries.reduce((t, e) => t + e.delta, 0);
  expect(sum).toBe(0);
  // one wallet debit + two merchant credits + one fee credit
  expect(entries).toHaveLength(4);
});

it('charges nothing at all when the tag is short, and names the shortfall', async () => {
  const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
  const wallet = await fundedWallet(3000, '04a22b1c');

  await expect(TableService.settle({
    tableId: String(table._id), eventId: EVENT, bandUid: '04a22b1c', settledBy: 'w1', clientTxnId: 's1',
  })).rejects.toThrow(/R15\.00 short/);

  expect((await Wallet.findById(wallet._id))!.balance).toBe(3000);
  expect(await MerchantCharge.countDocuments({})).toBe(0);
  expect((await Table.findById(table._id))!.status).toBe('open');
});

it('refuses a second concurrent settle rather than billing twice', async () => {
  const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
  await fundedWallet(10000, '04a22b1c');
  const call = () => TableService.settle({ tableId: String(table._id), eventId: EVENT, bandUid: '04a22b1c', settledBy: 'w1', clientTxnId: `s-${Math.random()}` });

  const results = await Promise.allSettled([call(), call()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await MerchantCharge.countDocuments({})).toBe(2); // two stalls, one settlement
});

it('replays a retried settle instead of billing twice', async () => {
  const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
  const wallet = await fundedWallet(10000, '04a22b1c');
  const args = { tableId: String(table._id), eventId: EVENT, bandUid: '04a22b1c', settledBy: 'w1', clientTxnId: 'same' };

  await TableService.settle(args);
  await TableService.settle(args);

  expect((await Wallet.findById(wallet._id))!.balance).toBe(5500);
  expect(await MerchantCharge.countDocuments({})).toBe(2);
});

it('still pays a stall that was suspended after the drinks were served', async () => {
  // Suspension blocks NEW items, not money already owed. The goods went out.
  const { table, stallA } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
  await fundedWallet(10000, '04a22b1c');
  await Merchant.updateOne({ _id: stallA }, { $set: { status: 'suspended' } });

  const { charges } = await TableService.settle({
    tableId: String(table._id), eventId: EVENT, bandUid: '04a22b1c', settledBy: 'w1', clientTxnId: 's1',
  });

  expect(charges).toHaveLength(2);
});

it('bills the snapshot when the product was deleted mid-service', async () => {
  const { table, productA } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
  const wallet = await fundedWallet(10000, '04a22b1c');
  await Product.deleteOne({ _id: productA });

  await TableService.settle({ tableId: String(table._id), eventId: EVENT, bandUid: '04a22b1c', settledBy: 'w1', clientTxnId: 's1' });

  expect((await Wallet.findById(wallet._id))!.balance).toBe(5500);
});

it('refuses an empty table', async () => {
  const table = await TableService.open({ eventId: EVENT, label: '9', openedBy: 'w1' });
  await fundedWallet(10000, '04a22b1c');
  await expect(TableService.settle({ tableId: String(table._id), eventId: EVENT, bandUid: '04a22b1c', settledBy: 'w1', clientTxnId: 's1' }))
    .rejects.toThrow(/nothing on this table/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/services/__tests__/tableSettle.test.ts`
Expected: FAIL — `settle is not a function`.

- [ ] **Step 3: Implement settle**

Order of operations matters:

1. Load the table; refuse unless `status === 'open'`; refuse an empty one.
2. Group lines by `merchantId`; for each stall load its Merchant and compute
   `gross`, `fee = round(gross * commissionPercent / 100)`, `net = gross - fee`.
   Read commission FRESH from the merchant document.
3. Load the wallet by `{ eventId, bandUid: normalizeBandUid(bandUid) }`; refuse
   if absent. Compute `total = sum(gross)`; if `wallet.balance < total`, throw
   `TableShortfallError` naming the amount short in rands — "declined" alone
   sends the waiter back to the table with nothing to say.
4. Open a transaction (mirror `MerchantService.charge`). Inside it:
   - Guarded `findOneAndUpdate({ _id: tableId, status: 'open' }, { $set: { status: 'settled', settledAt, settledBy, walletId } }, { session })`.
     A null result means another settle won — abort.
   - `LedgerService.post({ postings, refType: 'table_settlement', refId: tableId, session })`
     with ONE `{ WALLET, ref: walletId, delta: +total }` and, per stall,
     `{ MERCHANT, ref: merchantId, delta: -net }` plus `{ FEES, delta: -fee }`
     when `fee > 0`.
   - `$inc` the wallet balance down by `total`, drawing `cashFundedBalance`
     down first the way `MerchantService.charge` does.
   - `MerchantCharge.create` one row per stall, each with `waiterId`,
     `staffName`, the stall's `items` snapshot, and `clientTxnId` suffixed per
     stall (`${clientTxnId}:${merchantId}`) so the existing
     `{ merchantId, clientTxnId }` unique index makes the retry a replay.
5. On E11000 from that index, re-read and return the existing charges — a replay,
   not a second bill.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest --runInBand src/services/__tests__/tableSettle.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the route**

`POST /api/waiter/tables/:id/settle`, gated
`requireWaiterPermission(WaiterPermission.SETTLE_TABLES)` — NOT `MANAGE_TABLES`.
Map `TableShortfallError` to 402 with the message, an already-settled table to
409, and a missing wallet to 404.

- [ ] **Step 6: Run every money suite and commit**

```bash
npx jest --silent --runInBand src/services/__tests__/tableSettle.test.ts src/services/__tests__/merchantCharge.service.test.ts src/services/__tests__/reconciliation.walletBalances.test.ts src/services/__tests__/settlement.service.test.ts
npx tsc --noEmit
git add -A
git commit -m "feat(tables): settle a whole table in one balanced journal entry

One wallet debit and a merchant + fee credit per stall, each at that stall's
own commission, posted together so the table lands atomically or not at all.
A short tag charges nothing and is told how much short."
```

---

### Task 13: The organizer's Tables view

**Files:**
- Create: `src/controllers/tableReport.controller.ts`
- Modify: `src/routes/tickets.route.ts`
- Test: `src/routes/__tests__/tableReport.route.test.ts`

**Interfaces:**
- Produces: `GET /api/tickets/events/:eventId/tables` → `{ open: [...], settled: [...], voided: [...], totals: { openValue, settledValue, voidedValue } }`

- [ ] **Step 1: Write the failing test**

```ts
it('shows what is open, what was settled, and what walked', async () => {
  const { eventId, organizerToken } = await seedEventWithTables();
  const res = await request(app).get(`/api/tickets/events/${eventId}/tables`)
    .set('Authorization', `Bearer ${organizerToken}`);

  expect(res.status).toBe(200);
  expect(res.body.data.totals.openValue).toBe(6000);
  expect(res.body.data.totals.settledValue).toBe(4500);
  // The number that tells an organizer whether table service costs them money.
  expect(res.body.data.totals.voidedValue).toBe(3000);
  expect(res.body.data.voided[0].voidReason).toBe('walked out');
});

it('403s another organizer', async () => {
  const { eventId } = await seedEventWithTables();
  const stranger = signVendorToken(new mongoose.Types.ObjectId().toString(), {
    permissions: [TicketsPermission.VIEW_REVENUE],
  });
  const res = await request(app).get(`/api/tickets/events/${eventId}/tables`)
    .set('Authorization', `Bearer ${stranger}`);
  expect(res.status).toBe(403);
});

it('lets Carrot staff read it on an organizer they do not own', async () => {
  const { eventId } = await seedEventWithTables();
  const res = await request(app).get(`/api/tickets/events/${eventId}/tables`)
    .set('Authorization', `Bearer ${signSuperAdminToken()}`);
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest --runInBand src/routes/__tests__/tableReport.route.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Implement, using the existing ownership guard**

Reuse `loadOwnedCashlessEvent` from `src/controllers/organizerCashless.controller.ts`
— it already answers "is this my event, is it cashless, or am I platform staff".
Gate the route with `requireSuperAdminOrPermission(TicketsPermission.VIEW_REVENUE)`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest --runInBand src/routes/__tests__/tableReport.route.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Full sweep, then commit**

```bash
npx jest --silent --runInBand src/services/__tests__ src/models/__tests__ src/routes/__tests__/waiter*.test.ts src/routes/__tests__/table*.test.ts
npx tsc --noEmit
git add -A
git commit -m "feat(tables): the organizer's Tables view

Voided value is deliberately its own total: it is the number that says
whether table service is costing the organizer money."
```

---

## Definition of done

- A waiter logs into the POS, opens Table 7, adds a beer from one stall and a
  burger from another, and settles the lot against one tag.
- Each stall is credited at its own commission; the journal entry sums to zero.
- A short tag charges nothing and is told the shortfall.
- Stock leaves each stall when the item is added.
- The organizer sees open, settled and voided tables with totals.
- `npx tsc --noEmit` clean; every suite named above passes under `--runInBand`.
