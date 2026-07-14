# Operator Type + Permission Hybrid — Design

**Date:** 2026-07-14
**Repos touched:** `carrot-tickets-api`, `carrot-tickets-dashboard`
**Status:** Approved (brainstorm), pending spec review

## Goal

Give every vendor account an explicit **operator type** (`events` | `transport` | `both`) that is set when the account is created, drives which permissions the account actually receives, and frames the dashboard so a bus operator is never confused by an event-organizer UI (and vice-versa).

## Why (problem statement)

1. **Everyone sees buses.** Permissions are role-derived, not stored on the vendor. A vendor owner's JWT is built from `TICKETS_ROLE_PERMISSIONS[OWNER]`, which is *every* permission except three platform-staff ones — so **every** owner holds `VIEW_TRANSPORT` + `MANAGE_TRANSPORT`. The dashboard nav gates the Bus tabs on `canManageTransport(user)`, so a pure event organizer already sees Bus Trips / Routes / Vehicles / Bookings. This is both a UX confusion and an over-permission (they can call `/api/tickets/transport/*`).
2. **No notion of "what kind of operator this is."** The only type-ish field, `businessType`, enumerates *event* sub-categories (`event_organizer`, `venue`, `promoter`…), can't express "does both," and drives nothing — it's a display label.
3. **No way to add a bus operator.** Vendors only exist via self-signup (always an event organizer). There is no admin create-vendor path. Bus operators must be **added by an admin**, not self-signup.

## Locked decisions (brainstormed with the user)

- **Explicit type, not derived.** Add a first-class `operatorType` field; do not infer type from live permissions (permissions fluctuate; the OWNER role is all-or-nothing, so it can't distinguish verticals).
- **Type + permissions are a hybrid, two orthogonal axes.** `operatorType` = identity/vertical (frames the UI + scopes the grant); permissions = fine-grained capability. *Type frames the dashboard; permissions gate the doors.*
- **Choosing the type grants the permissions.** Selecting a type at creation is what scopes the account's permission set.
- **Bus operators are admin-added; they cannot self-sign-up.** Self-signup is always `events`. `transport` / `both` can only be minted through a super-admin flow.
- **Admin-created operators are auto-`VERIFIED`** (the admin vouches for them; skip the pending-review gate).
- **Transport operators scan only bus tickets.** Bus scanning is the existing POS boarding flow; the dashboard event-scan permission (`SCAN_TICKETS`/`VIEW_SCANS`) is **not** granted to transport operators.
- Keep `businessType` as-is (event sub-category); do **not** overload it.

## Data model

### `operatorType` on Vendor

```ts
// src/interfaces/vendor.interface.ts
export enum OperatorType {
  EVENTS = 'events',
  TRANSPORT = 'transport',
  BOTH = 'both',
}
```

```ts
// src/models/vendor.model.ts — new field
operatorType: {
  type: String,
  enum: Object.values(OperatorType),
  default: OperatorType.EVENTS,
  index: true,
}
```

Distinct from `businessType` (unchanged). Default `events` so any pre-existing / self-signup account reads as an event organizer.

## Permission model — vertical masking

Partition the non-platform-staff permissions into three **disjoint** vertical groups (co-located with the enum in `ticketsPermission.interface.ts`):

Principle: **a vertical group holds only permissions that have a dashboard surface for that vertical today.** Every event surface (analytics, sales, scan, access) is event-shaped right now, so those perms live in the event group; the transport group is just the two transport perms. As cross-vertical surfaces become vertical-aware (a real transport analytics page, bus refunds), their perms migrate into `SHARED_PERMISSIONS`.

```ts
export const TRANSPORT_PERMISSIONS = [
  TicketsPermission.VIEW_TRANSPORT,
  TicketsPermission.MANAGE_TRANSPORT,
];

// Cross-cutting — granted to every type. Empty in v1: no cross-vertical
// dashboard surface exists yet (analytics/sales/refund views are all
// event-shaped). Perms migrate here as their surfaces become vertical-aware.
export const SHARED_PERMISSIONS: TicketsPermission[] = [];

// Everything else non-staff — event-specific dashboard surfaces (incl.
// analytics/revenue/reports, which today only render event data).
export const EVENT_PERMISSIONS = [
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

The three platform-staff permissions (`VIEW_USERS`, `PRINT_WRISTBANDS`, `MODERATE_SOCIAL`) belong to **no** vertical. They are never in a role's set; they are assigned explicitly via `TicketsUserAccess.permissions[]` (or granted implicitly to super-admins by middleware). The mask must never strip them.

### `effectivePermissions` helper

```ts
// allowed vertical scope for a type
function allowedByType(type: OperatorType): Set<TicketsPermission> {
  const s = new Set(SHARED_PERMISSIONS);
  if (type === OperatorType.EVENTS || type === OperatorType.BOTH)
    EVENT_PERMISSIONS.forEach((p) => s.add(p));
  if (type === OperatorType.TRANSPORT || type === OperatorType.BOTH)
    TRANSPORT_PERMISSIONS.forEach((p) => s.add(p));
  return s;
}

// role perms scoped to the vertical, PLUS any explicit (staff) grants, unmasked
export function effectivePermissions(
  type: OperatorType,
  role: TicketsRole,
  explicit: TicketsPermission[] = [],
): TicketsPermission[] {
  const allowed = allowedByType(type);
  const scoped = TICKETS_ROLE_PERMISSIONS[role].filter((p) => allowed.has(p));
  return Array.from(new Set([...scoped, ...explicit]));
}
```

Resulting owner grants:
- `events` → today's owner set **minus** transport perms (unchanged behaviour for every existing vendor).
- `transport` → `[VIEW_TRANSPORT, MANAGE_TRANSPORT]` (their surfaces are the four transport-gated pages; sales/revenue visibility is the transport-gated **Bus Bookings** page, not the event analytics tabs).
- `both` → unchanged from today (full owner set).

### Token-build refactor (DRY)

`src/services/ticketsAuth.service.ts` assigns `permissions: TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]` in ~6 places (owner login/register/refresh, etc.) and builds sub-user tokens from `TicketsUserAccess.role` + `.permissions`. Replace every raw assignment with `effectivePermissions(vendor.operatorType, role, explicit)`:
- **Owner** tokens: `effectivePermissions(vendor.operatorType, OWNER)` (no explicit array).
- **Sub-user** tokens: `effectivePermissions(vendor.operatorType, access.role, access.permissions)` — the sub-user's role perms are vertically masked by *their vendor's* type, explicit perms unioned on top.

Both the access token and any refresh-time rebuild must read `operatorType` off the vendor. Load `operatorType` wherever the vendor is fetched for token building.

## Admin create-operator flow (new)

### API — `POST /api/tickets/admin/organizers` (super-admin)

- Mount alongside the existing admin organizer routes in `tickets.route.ts` (`requireSuperAdmin`).
- Body (Joi-validated): `businessName` (required), `operatorType` (required, `OperatorType`), one of `email` / `phoneNumber` (required), `password` (required), optional `businessType`, `primaryContact`, `bio`, `logoUrl`, address fields.
- Behaviour: reuse the existing vendor-creation logic in `TicketsAuthService` (DRY — do not duplicate hashing/slug/uniqueness). Create the vendor with the supplied `operatorType`, and set `verificationStatus = VERIFIED`, `isVerified = true`, `verifiedAt = now` (admin-vouched). Returns the created vendor (no token).
- Invariant enforced here: this is the **only** path that can set `operatorType` to `transport` or `both`.

### Self-signup unchanged

`POST /api/tickets/auth/register` continues to create `events` operators only. It must **not** accept `operatorType` from the client; it always persists `events`.

### Dashboard — "Add Operator" on OrganizersPage

- An **Add Operator** button opening a dialog: business name, contact (email/phone), password, and an **operator-type selector** (`Event Organizer` / `Bus Operator` / `Events & Bus`), plus the existing optional business fields.
- On submit → `apiClient` new method `admin.createOrganizer(...)` → `POST /api/tickets/admin/organizers` → invalidate the organizers query. Surface success/error via the existing `sonner` toast (fail loudly, no silent fallback).

## Auth payload exposure

Add `operatorType` to the returned user object everywhere the dashboard reads the authenticated user (login response + `/me` / whoami). Frontend `AuthUser` type gains `operatorType: 'events' | 'transport' | 'both'`.

## Dashboard framing (anti-confusion)

A single helper drives all framing off `user.operatorType`:

```ts
// src/lib/operatorContext.ts
export type OperatorContext = 'events' | 'transport' | 'both';
export function getOperatorContext(user): OperatorContext { return user?.operatorType ?? 'events'; }
export function operatorLabel(ctx): string  // 'Event Organizer' | 'Bus Ticket Operator' | 'Events & Bus'
```

Apply it in:
- **Sidebar** ([Sidebar.tsx](../../../src/components/layout/Sidebar.tsx)): replace the `'Event Management'` subtitle fallback and the `'🎫 Vendor'` footer with the context label + a badge. Group Bus tabs under a "Transport" section label and event tabs under an "Events" label when context is `both`.
- **Header** ([Header.tsx](../../../src/components/layout/Header.tsx)): replace the `'Event Ticketing'` fallback with the context label; show the badge near the business name.
- **Landing / default route:** after login, a `transport` operator lands on `/transport/trips` (not the event-centric `DashboardPage`, which would show empty event charts). `events`/`both` keep `/`. For `transport` context the always-on **"Dashboard"** nav item also points to `/transport/trips` (or is hidden) so there is no path to the empty event dashboard; `events`/`both` keep it pointing to `/`.

With permission masking in place the nav auto-corrects (an `events` owner no longer holds transport perms, so `canManageTransport` is false). The badge, labels, and default route are the explicit signals on top.

## Backfill

One-time idempotent script `src/scripts/backfillOperatorType.ts`: set `operatorType = 'events'` for every vendor missing the field.

```ts
await Vendor.updateMany({ operatorType: { $exists: false } }, { $set: { operatorType: 'events' } });
```

All existing vendors are event organizers (transport launched 2026-07-13). Safe to re-run. Must run before the masking deploy so existing owners keep their (event) permissions deterministically; the schema `default: 'events'` is the backstop.

## Invariants

1. `transport` / `both` operators can only be created through the admin endpoint; self-signup always yields `events`.
2. The vertical mask applies **only** to role-derived permissions; explicitly-assigned permissions (incl. the three platform-staff perms) are unioned on top and never masked.
3. `operatorType` frames the UI and scopes the grant; it does not itself gate API routes — existing permission middleware still authorizes (now that owners are correctly scoped).
4. `businessType` is untouched.

## Testing

- **effectivePermissions** unit tests: each `(type × role)` → asserts transport perms present/absent as expected; shared perms always present; explicit staff perms always survive; `both` == today's set.
- **Token build:** owner of an `events` vendor has no `MANAGE_TRANSPORT`; owner of a `transport` vendor has no `CREATE_EVENT` but has `MANAGE_TRANSPORT`; sub-user perms masked by vendor type; Carrot-team sub-user keeps `VIEW_USERS` under any type.
- **Admin create-operator:** super-admin only (401/403 otherwise); creates `transport` operator, auto-verified; rejects missing type; created operator can log in and receives a transport-scoped token.
- **Self-signup:** ignores a client-supplied `operatorType`, always persists `events`.
- **Route authorization:** an `events` operator calling `GET /api/tickets/transport/routes` is now 403 (was 200-capable via the blanket owner grant).
- **Dashboard:** `getOperatorContext` / `operatorLabel` unit tests; render checks that Bus tabs hide for `events` context and show for `transport`/`both`.
- **Backfill:** idempotent; only fills missing field; doesn't overwrite an existing value.

## Out of scope (later)

- Per-vertical landing analytics (a real transport dashboard with bus KPIs) — for now `transport` just default-routes to Bus Trips.
- Editing an existing vendor's `operatorType` from the admin UI (add-only for now; can be a follow-up on the verification/detail screen).
- Transport sub-categories on `businessType` (e.g. bus/shuttle/coach).
- A dedicated dashboard-side bus boarding/scan surface or a distinct boarding permission (boarding stays on the POS).

## File touch list

**API (`carrot-tickets-api`)**
- `src/interfaces/vendor.interface.ts` — `OperatorType` enum + `operatorType` on `IVendor`.
- `src/models/vendor.model.ts` — `operatorType` field.
- `src/interfaces/ticketsPermission.interface.ts` — vertical permission groups.
- `src/services/permissions.util.ts` (new) or co-located — `effectivePermissions` + `allowedByType`.
- `src/services/ticketsAuth.service.ts` — use `effectivePermissions` at all token-build sites; admin create-operator service method.
- `src/controllers/adminOrganizers.controller.ts` + `src/routes/tickets.route.ts` — `POST /api/tickets/admin/organizers`.
- `src/validators/*` — Joi schema for create-operator.
- `src/scripts/backfillOperatorType.ts` — backfill.
- Expose `operatorType` in the auth/whoami response shape.
- Tests alongside each.

**Dashboard (`carrot-tickets-dashboard`)**
- `src/types/index.ts` — `AuthUser.operatorType`.
- `src/lib/operatorContext.ts` (new) — context helper + labels.
- `src/lib/api.ts` — `admin.createOrganizer`.
- `src/pages/OrganizersPage.tsx` — Add Operator dialog + type selector.
- `src/components/layout/Sidebar.tsx`, `Header.tsx` — badge, label fixes, section grouping.
- Router/landing — default route by context.
