# Operator Type + Permission Hybrid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every vendor an explicit `operatorType` (`events | transport | both`), set at creation, that scopes the account's permission grant and frames the dashboard so bus operators and event organizers each see only their world.

**Architecture:** New `operatorType` field on Vendor. A single subtractive helper `scopePermissionsToType(base, type)` strips the *other* vertical's permissions from any base set; it wraps every JWT permission assignment in `ticketsAuth.service.ts`. A new super-admin `POST /api/tickets/admin/organizers` mints `transport`/`both` operators (auto-verified); self-signup stays `events`. The dashboard reads `operatorType` (exposed via login/getMe) to drive a context badge, labels, and the post-login landing route.

**Tech Stack:** carrot-tickets-api (Node/TS, Express, Mongoose, Jest + mongodb-memory-server); carrot-tickets-dashboard (React 19 + Vite + TS, vitest, @tanstack/react-query, sonner, shadcn/Radix).

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-07-14-operator-type-and-permission-hybrid-design.md`. Values below are copied verbatim from it.
- `OperatorType` values are exactly `'events' | 'transport' | 'both'`; Vendor default is `'events'`.
- The three vertical permission groups **partition all non-platform-staff permissions** (disjoint + exhaustive). Platform-staff perms (`VIEW_USERS`, `PRINT_WRISTBANDS`, `MODERATE_SOCIAL`) belong to no group and must never be stripped by the mask.
- `transport`/`both` can be created **only** via the admin endpoint; self-signup (`POST /api/tickets/auth/register`) always persists `events` and must not read `operatorType` from the client.
- Admin-created operators are auto-`VERIFIED` (`verificationStatus = VERIFIED`, `isVerified = true`, `verifiedAt = now`).
- `both` == today's full owner grant (no behaviour change); `events` == today's grant **minus** transport perms.
- Do NOT touch `businessType`. Do NOT add backward-compat shims. Fail loudly — surface errors via the API envelope / sonner toast; no silent fallbacks.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- API worktree: `.claude/worktrees/operator-type` (branch `feat/operator-type`). Dashboard worktree is created separately at execution time off `origin/main` (branch `feat/operator-type`).

## File Structure

**carrot-tickets-api**
- `src/interfaces/vendor.interface.ts` — `OperatorType` enum + `operatorType` on `IVendor` (Task 1).
- `src/models/vendor.model.ts` — `operatorType` schema field (Task 1).
- `src/interfaces/ticketsPermission.interface.ts` — `EVENT_PERMISSIONS` / `TRANSPORT_PERMISSIONS` / `SHARED_PERMISSIONS` groups (Task 2).
- `src/utils/permissions.util.ts` (new) — `scopePermissionsToType` (Task 2).
- `src/services/ticketsAuth.service.ts` — scope every token/user permission set; expose `operatorType`; `adminCreateOperator` (Tasks 3, 4, 5).
- `src/validators/tickets.validator.ts` — `createOrganizerSchema` (Task 5).
- `src/controllers/adminOrganizers.controller.ts` + `src/routes/tickets.route.ts` — `POST /admin/organizers` (Task 5).
- `src/scripts/backfillOperatorType.ts` (new) + `package.json` script (Task 6).
- `src/services/transport/trip.service.ts`, `src/controllers/transportPos.controller.ts`, `src/routes/transportPos.route.ts`, `src/validators/transportPos.validator.ts` — `GET /reseller/transport/operators` + optional `vendorId` on trip list (Task 10).

**carrot-tickets-pos**
- `lib/transport_api.dart` — `getOperators()` + `getTrips({vendorId})`; `lib/pages/bus_operator_picker_page.dart` (new); `lib/pages/{bus_pos_page,bus_board_page,home_page}.dart` — route bus flows through the picker (Task 11).

**carrot-tickets-dashboard**
- `src/types/index.ts` — `AuthUser.operatorType` + `CreateOrganizerData` (Tasks 7, 9).
- `src/lib/operatorContext.ts` (new) — context helper/labels/home path (Task 7).
- `src/components/layout/Sidebar.tsx`, `Header.tsx` — badge/labels/dashboard href (Task 8).
- `src/pages/LoginPage.tsx` — post-login landing route (Task 8).
- `src/lib/api.ts` — `organizers.create` (Task 9).
- `src/pages/OrganizersPage.tsx` — Add Operator dialog (Task 9).

---

## Task 1: `operatorType` field + `OperatorType` enum

**Files:**
- Modify: `src/interfaces/vendor.interface.ts`
- Modify: `src/models/vendor.model.ts:43-48` (add field after `businessType`)
- Test: `src/models/__tests__/vendor.operatorType.test.ts` (create)

**Interfaces:**
- Produces: `enum OperatorType { EVENTS='events', TRANSPORT='transport', BOTH='both' }` (exported from `vendor.interface.ts`); `IVendor.operatorType: OperatorType`; Vendor schema field `operatorType` (default `events`, indexed).

- [ ] **Step 1: Write the failing test**

```ts
// src/models/__tests__/vendor.operatorType.test.ts
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('Vendor.operatorType', () => {
  it('defaults to events', async () => {
    const v = await Vendor.create({ businessName: 'Acme', email: 'a@b.co', password: 'secret1' });
    expect(v.operatorType).toBe(OperatorType.EVENTS);
  });

  it('accepts transport and both', async () => {
    const v = await Vendor.create({ businessName: 'Bus Co', phoneNumber: '+268760000001', password: 'secret1', operatorType: OperatorType.TRANSPORT });
    expect(v.operatorType).toBe('transport');
  });

  it('rejects an invalid operatorType', async () => {
    await expect(
      Vendor.create({ businessName: 'Bad', email: 'x@y.co', password: 'secret1', operatorType: 'aviation' as any }),
    ).rejects.toThrow();
  });
});
```

> Confirm the mongo helper exports used here (`connectTestDb`/`disconnectTestDb`/`clearTestDb`) match `src/__tests__/helpers/mongo.ts`; if the names differ, use the actual exports (do not invent new ones).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/__tests__/vendor.operatorType.test.ts`
Expected: FAIL — `OperatorType` not exported / `operatorType` undefined.

- [ ] **Step 3: Add the enum + interface field**

In `src/interfaces/vendor.interface.ts`, add the enum near `VerificationStatus`:

```ts
export enum OperatorType {
  EVENTS = 'events',
  TRANSPORT = 'transport',
  BOTH = 'both',
}
```

And in `IVendor`, after `businessType?: string;`:

```ts
  operatorType: OperatorType;
```

- [ ] **Step 4: Add the schema field**

In `src/models/vendor.model.ts`, import the enum and add the field immediately after the `businessType` block (line ~48):

```ts
// at top with other imports
import { IVendor, VerificationStatus, OperatorType } from '@interfaces/vendor.interface';

// after the businessType field
  operatorType: {
    type: String,
    enum: Object.values(OperatorType),
    default: OperatorType.EVENTS,
    index: true,
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/models/__tests__/vendor.operatorType.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/vendor.interface.ts src/models/vendor.model.ts src/models/__tests__/vendor.operatorType.test.ts
git commit -m "feat(operator-type): add operatorType field + enum to Vendor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Permission vertical groups + `scopePermissionsToType`

**Files:**
- Modify: `src/interfaces/ticketsPermission.interface.ts` (append the three groups after `TICKETS_ROLE_PERMISSIONS`)
- Create: `src/utils/permissions.util.ts`
- Test: `src/utils/__tests__/permissions.util.test.ts`

**Interfaces:**
- Consumes: `TicketsPermission` enum, `TICKETS_ROLE_PERMISSIONS` (Task pre-existing), `OperatorType` (Task 1).
- Produces: `EVENT_PERMISSIONS`, `TRANSPORT_PERMISSIONS`, `SHARED_PERMISSIONS: TicketsPermission[]` (from `ticketsPermission.interface.ts`); `scopePermissionsToType(permissions: TicketsPermission[], type: OperatorType): TicketsPermission[]` (from `utils/permissions.util.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/__tests__/permissions.util.test.ts
import { TicketsPermission, TICKETS_ROLE_PERMISSIONS, TicketsRole,
  EVENT_PERMISSIONS, TRANSPORT_PERMISSIONS, SHARED_PERMISSIONS } from '@interfaces/ticketsPermission.interface';
import { OperatorType } from '@interfaces/vendor.interface';
import { scopePermissionsToType } from '@utils/permissions.util';

const OWNER = TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER];
const STAFF = [TicketsPermission.VIEW_USERS, TicketsPermission.PRINT_WRISTBANDS, TicketsPermission.MODERATE_SOCIAL];

describe('vertical permission groups', () => {
  it('partition all non-staff permissions (disjoint + exhaustive)', () => {
    const groups = [...EVENT_PERMISSIONS, ...TRANSPORT_PERMISSIONS, ...SHARED_PERMISSIONS];
    // disjoint
    expect(new Set(groups).size).toBe(groups.length);
    // exhaustive: every non-staff permission appears in exactly one group
    const nonStaff = Object.values(TicketsPermission).filter((p) => !STAFF.includes(p));
    expect(new Set(groups)).toEqual(new Set(nonStaff));
  });
});

describe('scopePermissionsToType', () => {
  it('events strips transport perms, keeps event perms', () => {
    const scoped = scopePermissionsToType(OWNER, OperatorType.EVENTS);
    expect(scoped).not.toContain(TicketsPermission.MANAGE_TRANSPORT);
    expect(scoped).not.toContain(TicketsPermission.VIEW_TRANSPORT);
    expect(scoped).toContain(TicketsPermission.CREATE_EVENT);
  });

  it('transport strips event perms, keeps the two transport perms', () => {
    const scoped = scopePermissionsToType(OWNER, OperatorType.TRANSPORT);
    expect(scoped).not.toContain(TicketsPermission.CREATE_EVENT);
    expect(scoped).toEqual(expect.arrayContaining([TicketsPermission.VIEW_TRANSPORT, TicketsPermission.MANAGE_TRANSPORT]));
    expect(scoped.filter((p) => EVENT_PERMISSIONS.includes(p))).toHaveLength(0);
  });

  it('both strips nothing', () => {
    expect(scopePermissionsToType(OWNER, OperatorType.BOTH).sort()).toEqual([...OWNER].sort());
  });

  it('never strips platform-staff perms (they belong to no vertical)', () => {
    const withStaff = [...OWNER, ...STAFF];
    const scoped = scopePermissionsToType(withStaff, OperatorType.EVENTS);
    STAFF.forEach((p) => expect(scoped).toContain(p));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/utils/__tests__/permissions.util.test.ts`
Expected: FAIL — groups / `scopePermissionsToType` not exported.

- [ ] **Step 3: Add the permission groups**

Append to `src/interfaces/ticketsPermission.interface.ts` (after `TICKETS_ROLE_PERMISSIONS`):

```ts
// ── Operator-type verticals ────────────────────────────────────────────────
// These three groups PARTITION all non-platform-staff permissions (disjoint +
// exhaustive). The platform-staff perms (VIEW_USERS, PRINT_WRISTBANDS,
// MODERATE_SOCIAL) belong to no vertical and are never scoped by operator type.
export const TRANSPORT_PERMISSIONS: TicketsPermission[] = [
  TicketsPermission.VIEW_TRANSPORT,
  TicketsPermission.MANAGE_TRANSPORT,
];

// Cross-cutting — granted to every type. Empty in v1 (no cross-vertical
// dashboard surface exists yet; analytics/sales/refund views are event-shaped).
export const SHARED_PERMISSIONS: TicketsPermission[] = [];

export const EVENT_PERMISSIONS: TicketsPermission[] = [
  TicketsPermission.CREATE_EVENT,
  TicketsPermission.EDIT_EVENT,
  TicketsPermission.DELETE_EVENT,
  TicketsPermission.VIEW_EVENTS,
  TicketsPermission.PUBLISH_EVENT,
  TicketsPermission.SELL_TICKETS,
  TicketsPermission.VIEW_SALES,
  TicketsPermission.REFUND_TICKET,
  TicketsPermission.SCAN_TICKETS,
  TicketsPermission.VIEW_SCANS,
  TicketsPermission.VIEW_STATS,
  TicketsPermission.VIEW_REVENUE,
  TicketsPermission.EXPORT_REPORTS,
  TicketsPermission.MANAGE_ACCESS,
];
```

- [ ] **Step 4: Create the scope helper**

```ts
// src/utils/permissions.util.ts
import {
  TicketsPermission,
  EVENT_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';
import { OperatorType } from '@interfaces/vendor.interface';

/** The permissions to strip for a type — the OPPOSITE vertical's perms. */
function disallowedForType(type: OperatorType): Set<TicketsPermission> {
  if (type === OperatorType.EVENTS) return new Set(TRANSPORT_PERMISSIONS);
  if (type === OperatorType.TRANSPORT) return new Set(EVENT_PERMISSIONS);
  return new Set(); // BOTH strips nothing
}

/**
 * Scope a base permission set to a vendor's operator type. Subtractive: removes
 * only the opposite vertical's perms; shared perms and the platform-staff perms
 * (which belong to no vertical group) always survive. Used to scope both the
 * owner's role-derived set and a sub-user's stored permission array.
 */
export function scopePermissionsToType(
  permissions: TicketsPermission[],
  type: OperatorType,
): TicketsPermission[] {
  const drop = disallowedForType(type);
  return permissions.filter((p) => !drop.has(p));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/utils/__tests__/permissions.util.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/ticketsPermission.interface.ts src/utils/permissions.util.ts src/utils/__tests__/permissions.util.test.ts
git commit -m "feat(operator-type): vertical permission groups + scopePermissionsToType

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Scope owner tokens + expose `operatorType`

Applies the mask at the four **owner** sites in `ticketsAuth.service.ts` (`register`, `login` vendor branch, `getMe` vendor branch, `refreshAccessToken` vendor branch) and adds `operatorType` to the returned user objects. Sub-user sites are Task 4.

**Files:**
- Modify: `src/services/ticketsAuth.service.ts` (lines ~76, 94, 130, 150, 343, 584)
- Test: `src/services/__tests__/ticketsAuth.owner.test.ts` (create)

**Interfaces:**
- Consumes: `scopePermissionsToType` (Task 2), `OperatorType` + `Vendor.operatorType` (Task 1).
- Produces: owner login/register/getMe user objects now include `operatorType`; owner JWT `permissions` scoped to type.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/ticketsAuth.owner.test.ts
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { TicketsAuthService } from '@services/ticketsAuth.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

async function make(type: OperatorType) {
  await Vendor.create({ businessName: 'X', email: 'o@x.co', password: 'secret1', operatorType: type });
  return TicketsAuthService.login('o@x.co', 'secret1');
}

describe('owner token scoping', () => {
  it('events owner has no transport perms and reports operatorType', async () => {
    const r = await make(OperatorType.EVENTS);
    expect(r.user.permissions).not.toContain(TicketsPermission.MANAGE_TRANSPORT);
    expect(r.user.permissions).toContain(TicketsPermission.CREATE_EVENT);
    expect((r.user as any).operatorType).toBe('events');
  });

  it('transport owner has transport perms but no event perms', async () => {
    const r = await make(OperatorType.TRANSPORT);
    expect(r.user.permissions).toEqual(expect.arrayContaining([TicketsPermission.VIEW_TRANSPORT, TicketsPermission.MANAGE_TRANSPORT]));
    expect(r.user.permissions).not.toContain(TicketsPermission.CREATE_EVENT);
    expect((r.user as any).operatorType).toBe('transport');
  });

  it('getMe reflects the same scoping', async () => {
    const v = await Vendor.create({ businessName: 'Y', email: 'g@y.co', password: 'secret1', operatorType: OperatorType.TRANSPORT });
    const me = await TicketsAuthService.getMe(undefined, v._id.toString(), 'vendor');
    expect(me.permissions).not.toContain(TicketsPermission.CREATE_EVENT);
    expect((me as any).operatorType).toBe('transport');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/ticketsAuth.owner.test.ts`
Expected: FAIL — events owner still has `MANAGE_TRANSPORT`; `operatorType` undefined.

- [ ] **Step 3: Apply the scope + expose operatorType (owner sites)**

At the top of `src/services/ticketsAuth.service.ts` add imports:

```ts
import { OperatorType } from '@interfaces/vendor.interface';
import { scopePermissionsToType } from '@utils/permissions.util';
```

In **`register`** — replace the payload `permissions` (line ~76) and the user object `permissions` (line ~94), and add `operatorType`:

```ts
    const ownerPerms = scopePermissionsToType(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER], vendor.operatorType);
    const payload = {
      vendorId: vendor._id.toString(),
      userType: 'vendor',
      app: 'tickets',
      role: TicketsRole.OWNER,
      permissions: ownerPerms,
      isSuperAdmin: false
    };
    // ...
      user: {
        // ...existing fields...
        permissions: ownerPerms,
        operatorType: vendor.operatorType,
        // ...
      }
```

In **`login`** vendor branch — same treatment (payload line ~130, user line ~150):

```ts
      const ownerPerms = scopePermissionsToType(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER], vendor.operatorType);
      const payload = { /* ...unchanged... */ permissions: ownerPerms, isSuperAdmin: vendor.isSuperAdmin || false };
      // ...
        user: { /* ...unchanged... */ permissions: ownerPerms, operatorType: vendor.operatorType, /* ... */ }
```

In **`getMe`** vendor branch (line ~343) — replace `permissions` and add `operatorType`:

```ts
      return {
        // ...existing fields...
        permissions: scopePermissionsToType(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER], vendor.operatorType),
        operatorType: vendor.operatorType,
        // ...
      };
```

In **`refreshAccessToken`** vendor branch (line ~584) — replace payload `permissions`:

```ts
      payload = {
        vendorId: vendor._id.toString(),
        userType: 'vendor',
        app: 'tickets',
        role: TicketsRole.OWNER,
        permissions: scopePermissionsToType(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER], vendor.operatorType),
        isSuperAdmin: vendor.isSuperAdmin || false
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/ticketsAuth.owner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ticketsAuth.service.ts src/services/__tests__/ticketsAuth.owner.test.ts
git commit -m "feat(operator-type): scope owner JWT perms by operatorType + expose it

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Scope sub-user tokens by their vendor's type

Applies the mask at the three **sub-user** sites (`login`, `getMe`, `refreshAccessToken` sub-user branches). `login` already loads `vendorForSubUser`; `getMe` and `refresh` must additionally load the vendor to read `operatorType`.

**Files:**
- Modify: `src/services/ticketsAuth.service.ts` (lines ~200, ~219, ~354-372, ~588-609)
- Test: `src/services/__tests__/ticketsAuth.subuser.test.ts` (create)

**Interfaces:**
- Consumes: `scopePermissionsToType` (Task 2), `Vendor.operatorType` (Task 1), `TicketsUserAccess`, `VendorSubUser`.
- Produces: sub-user tokens/user objects with `permissions` scoped by their vendor's type; staff perms preserved.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/ticketsAuth.subuser.test.ts
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { VendorSubUser } from '@models/vendorSubUser.model';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsRole, TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { TicketsAuthService } from '@services/ticketsAuth.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

async function subUserOf(type: OperatorType, perms: TicketsPermission[]) {
  const vendor = await Vendor.create({ businessName: 'V', email: 'v@v.co', password: 'secret1', operatorType: type });
  const su = await VendorSubUser.create({ vendorId: vendor._id, username: 'staff1', fullName: 'Staff One', password: 'secret1' });
  await TicketsUserAccess.create({ userId: su._id, vendorId: vendor._id, role: TicketsRole.MANAGER, permissions: perms, isActive: true });
  return TicketsAuthService.login('staff1', 'secret1');
}

describe('sub-user token scoping', () => {
  it("strips transport perms for a sub-user of an events vendor", async () => {
    const r = await subUserOf(OperatorType.EVENTS, [TicketsPermission.VIEW_EVENTS, TicketsPermission.MANAGE_TRANSPORT]);
    expect(r.user.permissions).toContain(TicketsPermission.VIEW_EVENTS);
    expect(r.user.permissions).not.toContain(TicketsPermission.MANAGE_TRANSPORT);
  });

  it('preserves platform-staff perms regardless of type', async () => {
    const r = await subUserOf(OperatorType.TRANSPORT, [TicketsPermission.VIEW_USERS, TicketsPermission.VIEW_TRANSPORT, TicketsPermission.CREATE_EVENT]);
    expect(r.user.permissions).toContain(TicketsPermission.VIEW_USERS);      // staff — survives
    expect(r.user.permissions).toContain(TicketsPermission.VIEW_TRANSPORT);  // own vertical — survives
    expect(r.user.permissions).not.toContain(TicketsPermission.CREATE_EVENT); // other vertical — stripped
  });
});
```

> Confirm `VendorSubUser` required fields against `src/models/vendorSubUser.model.ts` and adjust the `create(...)` payloads to match (do not guess field names).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/ticketsAuth.subuser.test.ts`
Expected: FAIL — `MANAGE_TRANSPORT` still present for events sub-user.

- [ ] **Step 3: Scope the sub-user sites**

In **`login`** sub-user branch, `vendorForSubUser` is already loaded. Replace the payload `permissions: ticketsAccess.permissions` (line ~200) and user `permissions` (line ~219), and add `operatorType` to the returned user (so a sub-user gets dashboard framing too):

```ts
      const subUserPerms = scopePermissionsToType(ticketsAccess.permissions as any, vendorForSubUser.operatorType);
      const payload = { /* ...unchanged... */ role: ticketsAccess.role, permissions: subUserPerms };
      // ...
        user: { /* ...unchanged... */ role: ticketsAccess.role, permissions: subUserPerms, operatorType: vendorForSubUser.operatorType }
```

In **`getMe`** sub-user branch (after `ticketsAccess` is fetched, ~line 361), load the vendor and scope, and expose `operatorType`:

```ts
      const vendorForSubUser = await Vendor.findById(subUser.vendorId);
      const subType = vendorForSubUser?.operatorType ?? OperatorType.EVENTS;
      return {
        // ...existing fields...
        role: ticketsAccess.role,
        permissions: scopePermissionsToType(ticketsAccess.permissions as any, subType),
        operatorType: subType,
      };
```

In **`refreshAccessToken`** sub-user branch (~line 602), load the vendor and scope:

```ts
      const vendorForSubUser = await Vendor.findById(subUser.vendorId);
      const subType = vendorForSubUser?.operatorType ?? OperatorType.EVENTS;
      payload = {
        userId: subUser._id.toString(),
        vendorId: subUser.vendorId.toString(),
        userType: 'sub-user',
        app: 'tickets',
        role: ticketsAccess.role,
        permissions: scopePermissionsToType(ticketsAccess.permissions as any, subType),
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/ticketsAuth.subuser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full auth suite regression + commit**

Run: `npx jest src/services/__tests__/ src/routes/__tests__/ -t auth` then commit:

```bash
git add src/services/ticketsAuth.service.ts src/services/__tests__/ticketsAuth.subuser.test.ts
git commit -m "feat(operator-type): scope sub-user JWT perms by their vendor's type

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Admin create-operator endpoint

**Files:**
- Modify: `src/services/ticketsAuth.service.ts` (add `adminCreateOperator`)
- Modify: `src/validators/tickets.validator.ts` (add `createOrganizerSchema`)
- Modify: `src/controllers/adminOrganizers.controller.ts` (add `createOrganizer`)
- Modify: `src/routes/tickets.route.ts:70` (add `POST /admin/organizers`)
- Test: `src/routes/__tests__/adminCreateOrganizer.route.test.ts` (create)

**Interfaces:**
- Consumes: `Vendor`, `OperatorType`, `VerificationStatus`, `requireSuperAdmin` middleware, `ApiResponseUtil`.
- Produces: `TicketsAuthService.adminCreateOperator(params): Promise<IVendor>`; route `POST /api/tickets/admin/organizers`.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/adminCreateOrganizer.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signTicketsToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const superAdmin = () => signTicketsToken({ isSuperAdmin: true });
const plainOwner = () => signTicketsToken({ isSuperAdmin: false });

describe('POST /api/tickets/admin/organizers', () => {
  it('super-admin creates a verified transport operator', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/organizers')
      .set('Authorization', `Bearer ${superAdmin()}`)
      .send({ businessName: 'Kombi Co', phoneNumber: '+268760000009', password: 'secret1', operatorType: 'transport' });
    expect(res.status).toBe(201);
    const v = await Vendor.findOne({ phoneNumber: '+268760000009' });
    expect(v?.operatorType).toBe('transport');
    expect(v?.isVerified).toBe(true);
    expect(v?.verificationStatus).toBe('verified');
  });

  it('rejects a non-super-admin (403)', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/organizers')
      .set('Authorization', `Bearer ${plainOwner()}`)
      .send({ businessName: 'X', email: 'x@x.co', password: 'secret1', operatorType: 'transport' });
    expect(res.status).toBe(403);
  });

  it('rejects a missing operatorType (400)', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/organizers')
      .set('Authorization', `Bearer ${superAdmin()}`)
      .send({ businessName: 'X', email: 'x@x.co', password: 'secret1' });
    expect(res.status).toBe(400);
  });
});
```

> Confirm the exact export name/signature of the token test-helper in `src/__tests__/helpers/auth.ts` (it may be `signTicketsToken`, `makeToken`, etc.) and the super-admin flag it expects; use the real one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/adminCreateOrganizer.route.test.ts`
Expected: FAIL — route returns 404 (not mounted).

- [ ] **Step 3: Add the service method**

In `src/services/ticketsAuth.service.ts`, add (reusing the same dedup pattern as `register`; note it does NOT return a token):

```ts
  /**
   * Admin-only: create an operator (event/transport/both). Unlike self-signup
   * this accepts operatorType and lands the account already VERIFIED (an admin
   * vouches for it). Returns the created vendor; no token is minted.
   */
  static async adminCreateOperator(params: {
    businessName: string;
    operatorType: OperatorType;
    email?: string;
    phoneNumber?: string;
    password: string;
    businessType?: string;
    primaryContact?: string;
  }) {
    const { businessName, operatorType, email, phoneNumber, password, businessType, primaryContact } = params;
    if (!email && !phoneNumber) throw new Error('An email address or phone number is required');
    if (email && await Vendor.findOne({ email })) throw new Error('An account with this email already exists');
    if (phoneNumber && await Vendor.findOne({ phoneNumber })) throw new Error('An account with this phone number already exists');

    const vendor = new Vendor({
      businessName, operatorType, email, phoneNumber, password, businessType, primaryContact,
      verificationStatus: VerificationStatus.VERIFIED,
      isVerified: true,
      verifiedAt: new Date(),
    });
    await vendor.save();
    return vendor;
  }
```

Add `VerificationStatus` to the `vendor.interface` import at the top of the file.

- [ ] **Step 4: Add the validator**

In `src/validators/tickets.validator.ts` (import `OperatorType` from `@interfaces/vendor.interface`):

```ts
export const createOrganizerSchema = Joi.object({
  businessName: Joi.string().trim().min(2).max(100).required(),
  operatorType: Joi.string().valid(...Object.values(OperatorType)).required(),
  email: Joi.string().email().trim().lowercase().optional(),
  phoneNumber: Joi.string().trim().max(20).optional(),
  password: Joi.string().min(6).required(),
  businessType: Joi.string().trim().optional(),
  primaryContact: Joi.string().trim().max(100).optional(),
}).or('email', 'phoneNumber');
```

- [ ] **Step 5: Add the controller method**

In `src/controllers/adminOrganizers.controller.ts` (import `createOrganizerSchema` and `TicketsAuthService`):

```ts
  /** POST /api/tickets/admin/organizers — super-admin creates a (verified) operator. */
  static async createOrganizer(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = createOrganizerSchema.validate(req.body);
      if (error) return ApiResponseUtil.badRequest(res, error.message);
      const vendor = await TicketsAuthService.adminCreateOperator(value);
      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        operatorType: vendor.operatorType,
        email: vendor.email ?? null,
        phoneNumber: vendor.phoneNumber ?? null,
        verificationStatus: vendor.verificationStatus,
      }, 'Operator created', 201);
    } catch (error: any) {
      console.error('Create organizer error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to create operator', 400);
    }
  }
```

> Match `ApiResponseUtil.success`'s real signature (status/message argument order) to the existing usages in this file; adjust the call if it differs.

- [ ] **Step 6: Mount the route**

In `src/routes/tickets.route.ts`, directly after line 70 (`router.get('/admin/organizers', ...)`):

```ts
router.post('/admin/organizers', requireSuperAdmin, AdminOrganizersController.createOrganizer);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/routes/__tests__/adminCreateOrganizer.route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add src/services/ticketsAuth.service.ts src/validators/tickets.validator.ts src/controllers/adminOrganizers.controller.ts src/routes/tickets.route.ts src/routes/__tests__/adminCreateOrganizer.route.test.ts
git commit -m "feat(operator-type): admin create-operator endpoint (super-admin, auto-verified)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Backfill existing vendors → `events`

**Files:**
- Create: `src/scripts/backfillOperatorType.ts`
- Modify: `package.json` (add `backfill:operator-type` script)
- Test: `src/scripts/__tests__/backfillOperatorType.test.ts` (create)

**Interfaces:**
- Produces: `backfillOperatorType(): Promise<{ updated: number }>` (exported), CLI-runnable like `src/scripts/backfillSocialActorTypes.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/scripts/__tests__/backfillOperatorType.test.ts
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { backfillOperatorType } from '../backfillOperatorType';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

it('fills missing operatorType with events, idempotently, without overwriting', async () => {
  // insert raw docs bypassing the schema default to simulate pre-migration rows
  await mongoose.connection.collection('vendors').insertMany([
    { businessName: 'Legacy A', password: 'x', slug: 'legacy-a' },
    { businessName: 'Legacy B', password: 'x', slug: 'legacy-b' },
  ] as any);
  const transport = await Vendor.create({ businessName: 'Bus', phoneNumber: '+268760000010', password: 'secret1', operatorType: 'transport' });

  const first = await backfillOperatorType();
  expect(first.updated).toBe(2);
  const again = await backfillOperatorType();
  expect(again.updated).toBe(0); // idempotent

  const a = await Vendor.findOne({ slug: 'legacy-a' });
  expect(a?.operatorType).toBe('events');
  const t = await Vendor.findById(transport._id);
  expect(t?.operatorType).toBe('transport'); // untouched
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/scripts/__tests__/backfillOperatorType.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the script** (mirror `backfillSocialActorTypes.ts`'s CLI shape)

```ts
// src/scripts/backfillOperatorType.ts
import mongoose from 'mongoose';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';

/** One-time, idempotent: every vendor written before operatorType existed is an
 *  event organizer (transport launched 2026-07-13). Fills only missing fields. */
export async function backfillOperatorType(): Promise<{ updated: number }> {
  const res = await Vendor.updateMany(
    { operatorType: { $exists: false } },
    { $set: { operatorType: OperatorType.EVENTS } },
  );
  return { updated: res.modifiedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillOperatorType] done:', await backfillOperatorType());
    await mongoose.disconnect();
  })().catch((err) => { console.error('[backfillOperatorType] failed:', err); process.exit(1); });
}
```

- [ ] **Step 4: Add the npm script**

In `package.json` scripts, mirroring the existing `backfill:social-actor-types` entry:

```json
"backfill:operator-type": "ts-node -r tsconfig-paths/register src/scripts/backfillOperatorType.ts",
```

> Copy the exact runner prefix from the existing `backfill:social-actor-types` script; match it verbatim.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/scripts/__tests__/backfillOperatorType.test.ts`
Expected: PASS.

- [ ] **Step 6: Full API suite + typecheck, then commit**

Run: `npx tsc --noEmit && npx jest`
Expected: clean tsc; full suite green.

```bash
git add src/scripts/backfillOperatorType.ts src/scripts/__tests__/backfillOperatorType.test.ts package.json
git commit -m "feat(operator-type): idempotent backfill of existing vendors to events

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Dashboard — `AuthUser.operatorType` + `operatorContext` helper

**Files:**
- Modify: `src/types/index.ts:25-45` (add `operatorType` to `AuthUser`)
- Create: `src/lib/operatorContext.ts`
- Test: `src/lib/__tests__/operatorContext.test.ts`

**Interfaces:**
- Produces: `AuthUser.operatorType?: OperatorContext`; `type OperatorContext = 'events' | 'transport' | 'both'`; `getOperatorContext(user): OperatorContext`; `operatorLabel(ctx): string`; `operatorHomePath(ctx): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/operatorContext.test.ts
import { describe, it, expect } from 'vitest';
import { getOperatorContext, operatorLabel, operatorHomePath } from '@/lib/operatorContext';

describe('operatorContext', () => {
  it('defaults to events when unset', () => {
    expect(getOperatorContext(null)).toBe('events');
    expect(getOperatorContext({} as any)).toBe('events');
  });
  it('reads operatorType', () => {
    expect(getOperatorContext({ operatorType: 'transport' } as any)).toBe('transport');
  });
  it('labels each context', () => {
    expect(operatorLabel('events')).toBe('Event Organizer');
    expect(operatorLabel('transport')).toBe('Bus Ticket Operator');
    expect(operatorLabel('both')).toBe('Events & Bus');
  });
  it('routes transport home to bus trips, others to /', () => {
    expect(operatorHomePath('transport')).toBe('/transport/trips');
    expect(operatorHomePath('events')).toBe('/');
    expect(operatorHomePath('both')).toBe('/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/operatorContext.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the type + helper**

In `src/types/index.ts`, inside `interface AuthUser` (after `isSuperAdmin?`):

```ts
  operatorType?: 'events' | 'transport' | 'both';
```

Create `src/lib/operatorContext.ts`:

```ts
import type { AuthUser } from '@/types';

export type OperatorContext = 'events' | 'transport' | 'both';

export function getOperatorContext(user: AuthUser | null | undefined): OperatorContext {
  return user?.operatorType ?? 'events';
}

export function operatorLabel(ctx: OperatorContext): string {
  if (ctx === 'transport') return 'Bus Ticket Operator';
  if (ctx === 'both') return 'Events & Bus';
  return 'Event Organizer';
}

/** Where an operator lands after login. Transport operators skip the
 *  event-centric dashboard (empty charts) and go straight to their trips. */
export function operatorHomePath(ctx: OperatorContext): string {
  return ctx === 'transport' ? '/transport/trips' : '/';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/operatorContext.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/operatorContext.ts src/lib/__tests__/operatorContext.test.ts
git commit -m "feat(operator-type): AuthUser.operatorType + operatorContext helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Dashboard — framing (badge, labels, default route)

No unit test (component/DOM testing isn't set up beyond `src/lib` helpers); verified by `tsc -b && vite build` + the manual checks below.

**Files:**
- Modify: `src/components/layout/Sidebar.tsx:176-181, 218-223, 122-127`
- Modify: `src/components/layout/Header.tsx:56-59`
- Modify: `src/pages/LoginPage.tsx` (post-login redirect)

**Interfaces:**
- Consumes: `getOperatorContext`, `operatorLabel`, `operatorHomePath` (Task 7).

- [ ] **Step 1: Sidebar — context label + badge + Dashboard href**

In `src/components/layout/Sidebar.tsx`, import the helpers and derive context:

```ts
import { getOperatorContext, operatorLabel, operatorHomePath } from '@/lib/operatorContext';
// inside Sidebar():
const ctx = getOperatorContext(user);
const homePath = operatorHomePath(ctx);
```

- Change the `Dashboard` nav item `href` from `'/'` to `homePath`.
- Replace the subtitle fallback (`user?.businessName || 'Event Management'`) with `user?.businessName || operatorLabel(ctx)`.
- In the footer, under the role line, add a context badge:

```tsx
<p className="text-orange-600 font-medium mt-2">{operatorLabel(ctx)}</p>
```

- [ ] **Step 2: Header — context fallback + badge**

In `src/components/layout/Header.tsx`, import `getOperatorContext, operatorLabel`; replace the `user?.businessName || 'Event Ticketing'` fallback with `user?.businessName || operatorLabel(getOperatorContext(user))`, and render a small badge (`operatorLabel(getOperatorContext(user))`) beside the business name.

- [ ] **Step 3: LoginPage — land by context**

In `src/pages/LoginPage.tsx`, after a successful `login(...)`, navigate to `operatorHomePath(getOperatorContext(user))` instead of a hard-coded `'/'`. (Read the file to find the current post-login `navigate('/')`; if it navigates before `user` is set in context, compute the context from the `login` response's returned user, or navigate to `operatorHomePath` reading the freshly-set `user`.)

- [ ] **Step 4: Build + manual verification**

Run: `npm run build`
Expected: `tsc -b && vite build` succeeds.

Manual (dev server): log in as a `transport` operator → lands on Bus Trips, sidebar/header show "Bus Ticket Operator", no Events/Analytics tabs. Log in as an `events` operator → lands on `/`, no Bus tabs.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/Sidebar.tsx src/components/layout/Header.tsx src/pages/LoginPage.tsx
git commit -m "feat(operator-type): dashboard context badge, labels, default landing route

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Dashboard — Add Operator dialog + `organizers.create`

**Files:**
- Modify: `src/types/index.ts` (add `CreateOrganizerData`)
- Modify: `src/lib/api.ts:679` (add `organizers.create`)
- Modify: `src/pages/OrganizersPage.tsx` (Add Operator button + dialog)

**Interfaces:**
- Consumes: existing `apiClient.request`, `organizers` group, `useMutation`, `toast`, `Dialog`.
- Produces: `apiClient.organizers.create(data: CreateOrganizerData)`; a create dialog on OrganizersPage.

- [ ] **Step 1: Add the type + api method**

In `src/types/index.ts`:

```ts
export interface CreateOrganizerData {
  businessName: string;
  operatorType: 'events' | 'transport' | 'both';
  email?: string;
  phoneNumber?: string;
  password: string;
  primaryContact?: string;
}
```

In `src/lib/api.ts`, inside the `organizers = { ... }` group (after `updateVerification`):

```ts
    create: async (data: CreateOrganizerData): Promise<{ id: string; businessName: string; operatorType: string }> =>
      this.request(`/tickets/admin/organizers`, { method: 'POST', body: JSON.stringify(data) }),
```

> Match the exact call shape of the sibling `updateVerification` (how it passes method/body/headers through `this.request`); mirror it verbatim.

- [ ] **Step 2: Add the Add Operator dialog to OrganizersPage**

In `src/pages/OrganizersPage.tsx`:
- Add an **Add Operator** `Button` beside the `<h1>Organizers</h1>` header.
- Add local form state (`businessName`, `operatorType` default `'transport'`, `email`, `phoneNumber`, `password`, `primaryContact`) and an `open` boolean.
- Add a create `Dialog` (mirroring the existing reason dialog structure) with inputs and a native `<select>` for `operatorType` (`Event Organizer` / `Bus Operator` / `Events & Bus`).
- Add a `useMutation` calling `apiClient.organizers.create(form)`, `onSuccess` → `toast.success('Operator created')`, `queryClient.invalidateQueries({ queryKey: [...] })` (match the list query key), close dialog, reset form; `onError` → `toast.error(e instanceof Error ? e.message : 'Create failed')`.

- [ ] **Step 3: Build + manual verification**

Run: `npm run build`
Expected: succeeds.

Manual: super-admin opens Organizers → Add Operator → pick "Bus Operator" → submit → row appears, verified; that operator can log in and sees the transport dashboard.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/lib/api.ts src/pages/OrganizersPage.tsx
git commit -m "feat(operator-type): Add Operator dialog with type selector on OrganizersPage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: API — `GET /reseller/transport/operators` + optional trip `vendorId`

**Files:**
- Modify: `src/services/transport/trip.service.ts` (add `listSellableOperators`)
- Modify: `src/controllers/transportPos.controller.ts` (add `listOperators`)
- Modify: `src/routes/transportPos.route.ts` (add route)
- Modify: `src/validators/transportPos.validator.ts` (optional `vendorId` on trip-list query)
- Test: `src/services/transport/__tests__/listSellableOperators.test.ts` (create)

**Interfaces:**
- Consumes: `Trip`, `Vendor`, `OperatorType`, `TripStatus`, existing `listSellable` sellable predicate.
- Produces: `TripService.listSellableOperators(): Promise<Array<{ id: string; businessName: string }>>`; route `GET /api/reseller/transport/operators`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/transport/__tests__/listSellableOperators.test.ts
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TripService } from '@services/transport/trip.service';
// Reuse the transport test fixtures used by the existing bus-vertical suite to
// create a sellable trip (route + vehicleType + trip). Import the same helper
// those tests use; if none is exported, create route/vehicleType/trip via the
// respective services exactly as the SP1b/SP1c tests do.
import { createSellableTripFor } from '../../../__tests__/helpers/fixtures';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

it('lists only active transport/both vendors that have a sellable trip', async () => {
  const busWithTrip = await Vendor.create({ businessName: 'Kombi Co', phoneNumber: '+268760000021', password: 'secret1', operatorType: OperatorType.TRANSPORT });
  const busNoTrip   = await Vendor.create({ businessName: 'Idle Bus', phoneNumber: '+268760000022', password: 'secret1', operatorType: OperatorType.TRANSPORT });
  const eventsVendor = await Vendor.create({ businessName: 'Event Co', email: 'e@e.co', password: 'secret1', operatorType: OperatorType.EVENTS });
  await createSellableTripFor(busWithTrip._id.toString());
  await createSellableTripFor(eventsVendor._id.toString()); // events vendor: excluded even with a trip

  const ops = await TripService.listSellableOperators();
  const ids = ops.map((o) => o.id);
  expect(ids).toContain(busWithTrip._id.toString());
  expect(ids).not.toContain(busNoTrip._id.toString());   // no sellable trip
  expect(ids).not.toContain(eventsVendor._id.toString()); // not a bus operator
});
```

> If no shared `createSellableTripFor` fixture exists, inline the route→vehicleType→trip creation the existing transport tests use (check `src/services/transport/__tests__/`), or call `TripService.createTrip` with the same inputs those tests pass. Do NOT guess Trip's required fields — copy them from a passing transport test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/listSellableOperators.test.ts`
Expected: FAIL — `listSellableOperators` not a function.

- [ ] **Step 3: Add the service method**

In `src/services/transport/trip.service.ts` (mirror the exact sellable predicate `listSellable` uses — same `status` set and any departure/`now` filter — so "has a sellable trip" means the same thing in both):

```ts
  static async listSellableOperators(now = new Date()): Promise<Array<{ id: string; businessName: string }>> {
    const vendorIds = await Trip.distinct('vendorId', {
      status: { $in: [TripStatus.SCHEDULED, TripStatus.BOARDING] },
      // + copy any departure/now filter from listSellable so the predicate matches
    });
    if (!vendorIds.length) return [];
    const vendors = await Vendor.find({
      _id: { $in: vendorIds },
      operatorType: { $in: [OperatorType.TRANSPORT, OperatorType.BOTH] },
      isActive: true,
    }).select('businessName').lean();
    return vendors.map((v) => ({ id: String(v._id), businessName: v.businessName as string }));
  }
```

Add imports for `Vendor` and `OperatorType` if not already present in the file.

- [ ] **Step 4: Add the controller + route + validator**

In `src/controllers/transportPos.controller.ts`:

```ts
  /** GET /api/reseller/transport/operators — bus companies a conductor can sell for. */
  static async listOperators(_req: Request, res: Response): Promise<any> {
    try {
      return ApiResponseUtil.success(res, await TripService.listSellableOperators());
    } catch (error: any) {
      return ApiResponseUtil.error(res, error.message || 'Failed to load operators', 500);
    }
  }
```

In `src/routes/transportPos.route.ts`, after the `/trips` route (line ~12):

```ts
router.get('/operators', requireResellerPermission(ResellerPermission.VIEW_EVENTS), TransportPosController.listOperators);
```

In `src/validators/transportPos.validator.ts`, add `vendorId` to the trip-list query schema (so `GET /trips?vendorId=…` validates):

```ts
  vendorId: Joi.string().hex().length(24).optional(),
```

> Match `ApiResponseUtil.success`/`.error` signatures to the existing calls in `transportPos.controller.ts`.

- [ ] **Step 5: Run test + typecheck to verify pass**

Run: `npx jest src/services/transport/__tests__/listSellableOperators.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/transport/trip.service.ts src/controllers/transportPos.controller.ts src/routes/transportPos.route.ts src/validators/transportPos.validator.ts src/services/transport/__tests__/listSellableOperators.test.ts
git commit -m "feat(operator-type): list bus operators for POS + optional vendorId trip filter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: POS — operator picker before selling/boarding buses

Flutter app (no unit-test harness for pages); verified by `flutter analyze` + manual. **Do not build or upload the APK** — the user builds it when they ask.

**Files:**
- Modify: `lib/transport_api.dart` (`getOperators()`, `getTrips({vendorId})`)
- Create: `lib/pages/bus_operator_picker_page.dart`
- Modify: `lib/pages/bus_pos_page.dart`, `lib/pages/bus_board_page.dart` (accept `vendorId`)
- Modify: `lib/pages/home_page.dart` (route bus flows through the picker)

**Interfaces:**
- Consumes: API `GET /reseller/transport/operators`, `GET /reseller/transport/trips?vendorId=`.
- Produces: `TransportApi.getOperators(): Future<List<BusOperator>>`; `BusOperator { id, businessName }`; `getTrips({String? vendorId})`; `BusPosPage(vendorId:)`, `BusBoardPage(vendorId:)`.

- [ ] **Step 1: API client — getOperators + vendorId trips**

In `lib/transport_api.dart` add a `BusOperator` model and method, and thread `vendorId` into `getTrips`:

```dart
class BusOperator {
  final String id;
  final String businessName;
  BusOperator({required this.id, required this.businessName});
  factory BusOperator.fromJson(Map<String, dynamic> j) =>
      BusOperator(id: j['id'].toString(), businessName: (j['businessName'] ?? '').toString());
}

// in TransportApi:
static Future<List<BusOperator>> getOperators() async {
  final res = await http.get(Uri.parse('$kApiBase/reseller/transport/operators'), headers: _h());
  final data = ResellerApi._unwrapDynamic(res);
  final list = data is List ? data : (data?['data'] as List<dynamic>? ?? []);
  return list.map((o) => BusOperator.fromJson(o as Map<String, dynamic>)).toList();
}

static Future<List<TransportTrip>> getTrips({String? vendorId}) async {
  final uri = Uri.parse('$kApiBase/reseller/transport/trips')
      .replace(queryParameters: vendorId != null ? {'vendorId': vendorId} : null);
  final res = await http.get(uri, headers: _h());
  final data = ResellerApi._unwrapDynamic(res);
  final list = data is List ? data : (data?['data'] as List<dynamic>? ?? []);
  return list.map((t) => TransportTrip.fromJson(t as Map<String, dynamic>)).toList();
}
```

- [ ] **Step 2: Operator picker page**

Create `lib/pages/bus_operator_picker_page.dart`: a `StatefulWidget` that loads `TransportApi.getOperators()` in `initState`, shows a loading state, an empty state ("No bus companies with trips available"), and a tappable list of company names. On tap it calls a `onPick(BusOperator)` callback (or pushes a supplied builder). Mirror the visual style of `home_page.dart`'s cards. On load error, show the error (fail loud — no silent empty list).

- [ ] **Step 3: Thread `vendorId` into the wizard + board pages**

- `BusPosPage`: add `final String vendorId;` (required ctor param) and use `TransportApi.getTrips(vendorId: widget.vendorId)` where it currently calls `getTrips()`.
- `BusBoardPage`: same — add required `vendorId`, filter its trip load by it.

- [ ] **Step 4: Route the home tiles through the picker**

In `lib/pages/home_page.dart`, change the **Sell Bus Tickets** and **Board Bus** `onTap`s to push `BusOperatorPickerPage`, and on pick push `BusPosPage(vendorId: op.id)` / `BusBoardPage(vendorId: op.id)` respectively.

- [ ] **Step 5: Analyze + commit**

Run: `flutter analyze`
Expected: no new issues.

```bash
git add lib/transport_api.dart lib/pages/bus_operator_picker_page.dart lib/pages/bus_pos_page.dart lib/pages/bus_board_page.dart lib/pages/home_page.dart
git commit -m "feat(bus): pick the bus company before selling/boarding on the POS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Sequencing & notes

- **API Tasks 1-6 + 10** land first (foundation): 1→2→(3,4)→5→6, then 10 (needs `operatorType` from Task 1). **Dashboard Tasks 7-9** and **POS Task 11** depend only on the API surface (`operatorType` exposure + create endpoint for the dashboard; the `/operators` endpoint for the POS); each needs its own worktree off `origin/main`.
- **Deploy order at the end:** run `npm run backfill:operator-type` against prod **before** the API deploy (so existing owners deterministically become `events` and lose the now-scoped transport perm). Then deploy the API (trigger `…-kesxwl`), then the dashboard (Cloudflare Pages on merge to `main`). The POS ships as a new APK build **only when the user asks** (per project rule). The backfill is a prod DB mutation — hand it to the user to run (auto-mode reserves prod DB migrations for the user).
- **Regression watch:** existing event organizers lose `VIEW_TRANSPORT`/`MANAGE_TRANSPORT` (never used — buses launched 2026-07-13) and existing sub-users keep their stored perms minus any stray transport perm. `both` and super-admin behaviour is unchanged. The POS `getTrips()` gains a `vendorId` arg but the API keeps it optional, so any un-migrated POS build still works.
