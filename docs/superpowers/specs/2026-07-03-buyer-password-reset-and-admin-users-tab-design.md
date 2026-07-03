# Buyer password reset + admin Users tab — design

Date: 2026-07-03

Two independent features, built in order. Backend lives in `carrot-tickets-api`;
frontends in `carrot-tickets-website` (landing) and `carrot-tickets-dashboard`.

---

## Part 1 — Buyer "Forgot password" (landing + API)

Buyers authenticate with phone + password (`Buyer` model). Reset reuses the
existing `BuyerOtp` collection and `BuyerAuthService.consumeOtp` — the same
plumbing signup uses. Registration OTP *rejects* numbers that already have an
account; reset OTP *requires* one (the inverse).

### API (`carrot-tickets-api`)
- `BuyerAuthService.requestPasswordResetOtp(rawPhone)` — normalise/validate,
  require an existing `Buyer`, invalidate outstanding codes, create a hashed OTP,
  SMS it via `SmsService.sendOtp` (throw loudly on send failure — no silent
  fallback). If no account: throw "We couldn't find an account for this number."
  (Account existence is already observable via login's `requiresRegistration`,
  so this leaks nothing new.)
- `BuyerAuthService.resetPassword(rawPhone, code, newPassword)` — validate
  password length (≥6), `consumeOtp(phone, code)`, load the buyer, set
  `password = newPassword` (pre-save hook re-hashes), `lastLoginAt = now`, save,
  and return `{ accessToken, phone }` (signs the buyer straight in).
- Controller handlers `forgotPasswordBuyer` / `resetPasswordBuyer` in
  `public.controller.ts` (validate body, map service errors to ApiResponse).
- Routes (unauthenticated, `public.route.ts`):
  - `POST /api/public/auth/forgot-password` → `{ phone }`
  - `POST /api/public/auth/reset-password` → `{ phone, code, password }`

### Landing (`carrot-tickets-website`)
- `services/api.ts`: `requestPasswordResetOtp(phone)` and
  `resetPassword(phone, code, password)` (latter persists the returned token via
  `setBuyerToken`).
- `BuyerAuthPanel.tsx`: a **"Forgot password?"** link under the Log in form opens
  a `view: 'reset'` inside the panel:
  1. phone → `requestPasswordResetOtp` → step `reset-verify`
  2. 6-digit code + new password → `resetPassword` → `onAuthenticated(token, phone)`
  Reuses the existing feedback/resend affordances. Both hosts (My Tickets page +
  PurchaseModal) inherit it via the shared panel. A "Back to log in" control
  returns to the login/signup toggle.

---

## Part 2 — Users tab + analytics (dashboard + API)

Platform-wide view of every registered buyer, for Carrot **super-admins** and
**team members granted a new permission** — never regular organizers.

### New permission
- Add `VIEW_USERS = 'tickets:view_users'` to `TicketsPermission`
  (`api/src/interfaces/ticketsPermission.interface.ts`). OWNER already gets every
  permission via `Object.values(...)`. Do NOT add to MANAGER/SALES/SCANNER — it
  must be granted explicitly.
- Mirror the string in `dashboard/src/lib/permissions.ts` and add
  `canViewUsers(user) = user.isSuperAdmin || hasPermission(user, VIEW_USERS)`.
- New middleware `requireSuperAdminOrPermission(permission)` in
  `ticketsAuth.middleware.ts` (passes if `ticketsUser.isSuperAdmin` OR the
  permission is present) — `requireTicketsPermission` alone does not bypass for
  super-admins.

### API (`carrot-tickets-api`) — under `/api/tickets` (authenticated `dualAuth`)
- `GET /api/tickets/admin/users?search=&page=&limit=` — paginated buyer list.
  Each row: `{ name, phone, createdAt, lastLoginAt, ticketsBought, totalSpent,
  lastPurchaseAt }`. Aggregate purchases from the ticket/ticketSale collections
  keyed on `customerPhone == Buyer.phone` (normalised on both sides).
- `GET /api/tickets/admin/users/analytics` — `{ totalUsers, newThisWeek,
  newThisMonth, activeBuyers, signups: [{ date, count }] }` (signups series
  bucketed by day over a trailing window, e.g. 30 days).
- Both gated by `requireSuperAdminOrPermission(VIEW_USERS)`. New
  `adminUsers.controller.ts` (keeps `tickets.controller.ts` from growing).

### Dashboard (`carrot-tickets-dashboard`)
- `lib/api.ts`: `apiClient.users.list(params)` and `apiClient.users.analytics()`.
- New `pages/UsersPage.tsx` mirroring `AnalyticsPage` patterns (React Query +
  `recharts` + shadcn Card/Table):
  - KPI stat cards (total, new this week/month, active buyers)
  - signups-over-time line chart
  - searchable, paginated users table
    (name, phone, joined, last active, tickets, spent)
- Sidebar: a **"Users"** item gated by `canViewUsers`.
- Router: the `/users` route wrapped in a guard allowing `canViewUsers`
  (super-admin or the permission) — not the super-admin-only `AdminRoute`.

---

## Build order & verification
1. Part 1 (API → landing), typecheck + build both, drive the reset flow in-browser.
2. Part 2 (permission + API → dashboard), typecheck + build, drive the Users tab.

No backward-compat shims. No silent fallbacks — every API/SMS failure surfaces
through the normal error channel.
