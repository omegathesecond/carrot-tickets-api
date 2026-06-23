# Operator User ID + PIN Authentication — Design

**Date:** 2026-06-23
**Status:** Approved (pending spec review)
**Scope:** Replace reseller-operator email/password login with a user ID + PIN
model modeled on supermarket till workers. Anti-theft is the driving concern.

## Problem

Reseller operators currently log in with email-or-phone + a bcrypt password
(`POST /api/reseller/auth/login`). This is wrong for the target user: a till
worker at a hub. They need a fast, memorable credential they're *given*, and
they must NOT be able to change it themselves — only a supervisor can, so a
worker can't quietly take over a till or lock others out.

## Decisions (locked)

1. **User ID** = system-generated **6-digit numeric login code**, globally
   unique, random (not sequential, so codes aren't guessable), immutable.
2. **PIN** = **6-digit numeric**, bcrypt-hashed.
3. **PIN authority** = anyone holding `MANAGE_OPERATORS` (platform super admin,
   `reseller_admin`, `reseller_hub_manager`). Operators have **no** self-service
   PIN change. Hub managers are scoped to their own hub; reseller_admin to their
   reseller.
4. **Migration** = full replacement. The email/phone+password operator login
   path is removed. (No production operators exist yet.)
5. **Build scope** = everything in one change, including the in-portal operator
   management screen for reseller admins/managers.

## Data model — `ResellerOperator`

Add:
- `loginCode: string` — `unique`, indexed, 6 digits (`100000`–`999999`),
  generated at creation with collision-retry. Immutable after creation.
- `pin: string` — bcrypt-hashed, `select: false`. Replaces `password`.
- `failedPinAttempts: number` — default `0`.
- `lockedUntil: Date | null` — default `null`.

Remove: `password`, `mustChangePassword`, `firstLogin`.

Keep: `email`, `phoneNumber` as **optional contact** fields (no longer used for
authentication; uniqueness constraints retained as sparse but irrelevant to login).

Methods/hooks:
- `comparePin(candidate)` → bcrypt compare against `pin`.
- pre-save: hash `pin` when modified (same pattern as the old password hook).

The `toJSON`/`toObject` transforms must also strip `pin` (in addition to the
existing `password`/`__v` strip — `password` can be dropped once removed).

## Login — `POST /api/reseller/auth/login`

Request body: `{ loginCode: string, pin: string }`.

Flow:
1. Find operator by `{ loginCode, isActive: true }` with `+pin`.
2. If not found → `Invalid credentials` (generic, no enumeration).
3. If `lockedUntil` is in the future → reject: "Too many attempts, try again later".
4. `comparePin`:
   - Fail → increment `failedPinAttempts`; if it reaches **5**, set
     `lockedUntil = now + 15 min` and reset the counter. Throw `Invalid credentials`.
   - Success → reset `failedPinAttempts = 0`, `lockedUntil = null`, stamp
     `lastLoginAt`, issue the JWT.
5. JWT payload is unchanged (`scope: 'reseller'`, `resellerId`, `hubId`,
   `operatorId`, `role`, `permissions`).

## Creating an operator

Issuer: super admin (existing `/api/admin/...` flow) **or** a privileged reseller
user via the new portal endpoint.

- Generate the unique `loginCode`.
- PIN: caller may supply a 6-digit PIN, otherwise the system auto-generates one.
- Response returns `{ loginCode, pin }` **once** (plain) so the issuer can hand
  the worker their credentials. PIN is never retrievable again after this.
- No `mustChangePassword` / forced-change step.

A shared util `generateOperatorCredentials()` (in `utils/`) produces the random
login code (with a uniqueness check against the collection) and, when needed, a
random 6-digit PIN. DRY — used by both the admin and reseller creation paths.

## PIN reset / management endpoints

**Super admin (`/api/admin`, `requireSuperAdmin`):**
- `POST /api/admin/operators/:id/reset-pin` — optional `{ pin }`, else auto-gen.
  Returns `{ pin }` once.

**Reseller portal (`/api/reseller`, `requireResellerPermission(MANAGE_OPERATORS)`):**
- `GET  /api/reseller/operators` — list operators in scope.
  - `reseller_admin` → all operators for their `resellerId`.
  - `reseller_hub_manager` → operators in their `hubId` only.
- `POST /api/reseller/operators` — create operator + issue code/PIN.
  - hub_manager: forced into their own `hubId`.
  - reseller_admin: must pass a `hubId` belonging to their reseller.
- `POST /api/reseller/operators/:id/reset-pin` — scoped reset, returns `{ pin }` once.
- `PATCH /api/reseller/operators/:id` — `isActive` (deactivate/reactivate) and
  `fullName`/`role` edits, within scope. Role changes cannot exceed the actor's
  own authority (a hub_manager cannot mint a reseller_admin).

All reseller endpoints enforce scope server-side from the JWT
(`resellerId`/`hubId`/`role`) — never trust client-supplied scope.

There is deliberately **no** endpoint by which an operator changes their own PIN.

## Frontend

**Reseller login (`ResellerLoginPage`):**
- Replace "Email or Phone" + password with **User ID** (numeric inputmode) and
  **PIN** (numeric inputmode, masked). Calls `resellerApi.login({ loginCode, pin })`.

**Portal operator management (new):**
- New route `/reseller/operators`, guarded by `ResellerProtectedRoute` and only
  reachable by roles with `MANAGE_OPERATORS`. Navigation entry shown
  conditionally in the portal for privileged roles.
- Screen: list operators in scope (loginCode, name, hub, role, active),
  **Add Operator** (returns code+PIN to display/hand over), **Reset PIN**, and
  activate/deactivate.
- POS page (`ResellerPosPage`) gains a link to operator management for privileged
  roles; plain operators never see it.

**Admin dashboard Operators tab (`ResellerDetailPage`):**
- Show `loginCode` column.
- Create flow returns and displays `{ loginCode, pin }` (replaces temp-password toast).
- Add **Reset PIN** action per operator, displaying the new PIN once.

## Migration

No production operators exist. A one-off script (`scripts/`) will assign a
`loginCode` + random `pin` to any pre-existing operator rows and drop legacy
auth fields, OR the collection is simply reseeded. We will reseed; the script is
a fallback only if dev data must be preserved.

## Testing

Existing reseller tests assume password auth and must be updated:
- `services/__tests__/resellerAuth.service.test.ts` — login by code+PIN, lockout
  after 5 fails, lockout expiry, success resets counter.
- `models/__tests__/reseller.models.test.ts` — loginCode uniqueness, pin hashing,
  `comparePin`, `toJSON` strips `pin`.
- `routes/__tests__/reseller.route.test.ts` and `resellerAdmin.route.test.ts` —
  new operator endpoints, scope enforcement (hub_manager can't touch another
  hub's operator; operator role has no access), reset-pin authority.
- Test fixtures/helpers updated to build operators with `loginCode`/`pin`.
- New: `generateOperatorCredentials` util test (format, collision-retry).

## Out of scope

- Rate limiting beyond the per-operator PIN lockout (no global IP throttle here).
- PIN complexity rules beyond "6 digits" (no sequential/repeat rejection).
- Audit log of who reset whose PIN (worth a follow-up given the anti-theft goal,
  but not in this change).
