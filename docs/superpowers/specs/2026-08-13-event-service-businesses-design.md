# Event Service Businesses — Design

**Date:** 2026-08-13
**Status:** Approved (design), pending spec review → implementation plan
**Repos:** `carrot-tickets-api` (this repo) + `carrot-tickets-website` (`landing/`)
**Branch:** `feat/event-service-businesses`

## 1. Summary

Add a new kind of account to Carrot Tickets: an **event service business** — a
supplier that caters for events but does **not** sell tickets (Sound hire, Food
stalls, Furniture & Decor, Toilet rental, Catering, Photography, Lighting,
Security, Marquees & tent, Transport, Other).

Users choose **User** vs **Business** when they sign up in the consumer
"Tickets" section. A Business gets a public profile (logo, bio/About, posts,
reviews, "Enquire Now", starting price, category, location) and is listed —
after admin verification — in a new **Services** directory with category
filtering and search. Customers send an **enquiry** (a lead) via a form; the
business receives it in an inbox. Only a customer who has enquired may leave a
review.

### Core decision: a Business is a `Vendor`, not a new model

A Business is a **`Vendor` with `operatorType: 'services'`** plus a
`serviceCategory`. This reuses the entire brand/social stack that already backs
event organizers — profiles, `logoUrl`, `bio`, `slug`, `address`, `location`
(Nearby), `verificationStatus` ("Verified" badge), posts (`Update`
`authorType:'vendor'`), followers, the star-rating aggregate, and R2 logo
upload. The only genuinely new data is the `Enquiry` collection and three new
`Vendor` fields.

Alternatives considered and rejected:
- **New `ServiceProvider` model** — duplicates ~6 subsystems (profile, posts,
  follows, reviews aggregate, verification, logo upload). Violates DRY. Rejected.
- **Business as an extended `Buyer`** — buyers lack `businessName`, `logoUrl`,
  rating, and verification, and reviews are `vendorId`-anchored. Weak fit.
  Rejected.

### Non-breaking guarantee

Every change is additive. Existing organizers, buyers, events, tickets, and the
dashboard/POS are untouched. The one change to a shipped collection (making
`Review.eventId` optional + reworking its indexes) is called out as an explicit,
reviewed migration in §7 and Slice 5.

### Product decisions (confirmed with the user)

| Question | Decision |
|---|---|
| "Enquire Now" behavior | **Enquiry form → business inbox** (net-new `Enquiry` lead model) |
| How businesses earn reviews | **Enquirers can review** — a review requires ≥1 prior enquiry from that buyer |
| Directory visibility | **After admin verification** — `verificationStatus === 'verified'` gates listing |
| Starting price | **Optional** "From E___/day" field |

## 2. Scope

**In scope (this feature):** api + `landing/` (consumer website) only.

**Out of scope:** the `dashboard/` (manage.carrottickets.com) and `pos-app/`.
Businesses manage everything from the consumer website, exactly like organizers
already manage their brand social there. Verification piggybacks on the existing
super-admin Organizers directory in the dashboard (services vendors appear there
with `verificationStatus`; the existing verify/reject UI already works — no
dashboard code change required for v1).

## 3. Data model (api)

### 3.1 `OperatorType` — add a third vertical

`src/interfaces/vendor.interface.ts`:

```ts
export enum OperatorType {
  EVENTS = 'events',
  TRANSPORT = 'transport',
  BOTH = 'both',
  SERVICES = 'services',   // NEW: event service business, sells no tickets
}
```

### 3.2 `Vendor` — three additive fields

`src/interfaces/vendor.interface.ts` + `src/models/vendor.model.ts`:

- `serviceCategory?: ServiceCategory` — **required when
  `operatorType === 'services'`** (enforced in the service + a schema-level
  conditional `required`), ignored otherwise. Indexed (directory filter).
- `startingPrice?: { amountCents: number; unit: 'day' | 'event' | 'hour' }` —
  optional; `unit` defaults to `'day'`. Currency is implicitly SZL (E). Hidden
  in UI when absent.
- No other new fields — `logoUrl`, `bio`, `address.city/region`, `location`,
  `verificationStatus`, `primaryContact` are reused as-is.

### 3.3 Service categories constant

New `src/constants/serviceCategories.ts` — value/label pairs (richer than
`eventCategories.ts`'s plain strings, so category filtering uses URL-safe slugs):

```ts
export const SERVICE_CATEGORIES = [
  { value: 'sound_hire',       label: 'Sound hire' },
  { value: 'food_stalls',      label: 'Food stalls' },
  { value: 'furniture_decor',  label: 'Furniture & Decor' },
  { value: 'toilet_rental',    label: 'Toilet rental' },
  { value: 'catering',         label: 'Catering' },
  { value: 'photography',      label: 'Photography' },
  { value: 'lighting',         label: 'Lighting' },
  { value: 'security',         label: 'Security' },
  { value: 'marquees_tents',   label: 'Marquees & tent' },
  { value: 'transport',        label: 'Transport' },
  { value: 'other',            label: 'Other' },
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]['value'];
```

The same file (or a shared package copy) is mirrored in `landing/` for the
signup dropdown and filter chips.

### 3.4 `Enquiry` — the lead model (new)

New `src/models/enquiry.model.ts`:

```ts
interface IEnquiry {
  businessId: Types.ObjectId;   // ref Vendor (operatorType 'services'), required, indexed
  customerId: Types.ObjectId;   // ref Buyer (login-gated), required
  eventDate?: Date;
  eventType?: string;           // free text v1 (e.g. "Wedding")
  message: string;              // required, max 1000
  contactPhone?: string;        // prefilled from buyer, editable
  contactEmail?: string;
  status: 'new' | 'read' | 'replied' | 'closed';   // default 'new'
  createdAt: Date; updatedAt: Date;
}
```

Indexes: `{ businessId: 1, createdAt: -1 }` (inbox), `{ customerId: 1, businessId: 1 }`
(review-eligibility check "has this buyer enquired?"). Multiple enquiries per
buyer↔business are allowed (not unique).

### 3.5 `Review` — support service (event-less) reviews

`src/models/review.model.ts`:
- `eventId` becomes **optional** (`required: false`); `vendorId` + `buyerId` stay
  required.
- **Index rework** (see §7 migration): the current
  `{ eventId, buyerId } unique` becomes a *partial* unique index scoped to event
  reviews, and a new partial unique index enforces one service review per
  buyer per business:
  ```ts
  reviewSchema.index({ eventId: 1, buyerId: 1 },
    { unique: true, partialFilterExpression: { eventId: { $exists: true } } });
  reviewSchema.index({ vendorId: 1, buyerId: 1 },
    { unique: true, partialFilterExpression: { eventId: { $exists: false } } });
  ```
- `ReviewService.vendorAggregate(vendorId)` is unchanged — because it already
  keys on `vendorId`, service reviews are counted automatically. This is the
  DRY payoff: the business profile's star rating "just works".

## 4. Permissions (api)

`src/utils/permissions.util.ts` + `src/interfaces/ticketsPermission.interface.ts`:

1. Add a services-vertical permission group and a new permission:
   ```ts
   MANAGE_ENQUIRIES = 'tickets:manage_enquiries'
   export const SERVICES_PERMISSIONS = [TicketsPermission.MANAGE_ENQUIRIES];
   ```
2. Generalize `disallowedForType` to the full partition — a type drops **every
   other vertical's** perms:
   - `EVENTS` → drop `TRANSPORT ∪ SERVICES`
   - `TRANSPORT` → drop `EVENT ∪ SERVICES`
   - `SERVICES` → drop `EVENT ∪ TRANSPORT`
   - `BOTH` → drop `SERVICES` (a BOTH operator is events+transport, not a service business)
3. `MANAGE_ENQUIRIES` joins the `OWNER` role's default set automatically
   (`Object.values(...)` minus platform-staff perms). After scoping, a
   **services** OWNER keeps `EDIT_BRAND` + `MANAGE_ENQUIRIES` and **no**
   ticket/event/transport permissions — enforcing "cannot sell tickets" at the
   auth layer, not just the UI.

## 5. API endpoints

### 5.1 Business signup (OTP-gated — mirrors organizer signup on `main`)

Reuse the shared `OtpService` audience `'vendor'`.

- **Step 1 (reused):** `POST /api/tickets/auth/register/request-otp` — already
  exists, operator-type-agnostic (dup-checks Vendor by email/phone, issues a
  vendor-audience code). Businesses call it unchanged.
- **Step 2 (new):** `POST /api/tickets/auth/business/register` — mirrors
  `TicketsAuthService.register` but creates the Vendor with
  `operatorType: SERVICES`, a required `serviceCategory`, optional `startingPrice`
  and `address.city`. Same `OtpService.withVerified` guard, same OWNER token +
  refresh token minting, same PENDING verification state. Returns the vendor
  session shape so the website signs the new business straight in.
  - Validator `businessRegisterSchema`: `businessName, serviceCategory (required,
    enum), email?|phoneNumber? (.or), password (min 6), code, startingPrice?,
    city?`.

### 5.2 Public directory + profile (consumer, no auth)

- `GET /api/public/services?category=<slug>&search=<q>&page=<n>` — list verified
  services vendors. Filter: `operatorType:'services'`, `verificationStatus:'verified'`,
  `isActive:true`. Card shape:
  `{ id, businessName, slug, logoUrl, serviceCategory, city, rating:{average,count}, startingPrice?, tagline }`
  (`tagline` = truncated `bio`). Scan-floor pagination (matches `/activity`).
- `GET /api/public/services/:businessId` — business profile payload:
  `{ id, businessName, slug, logoUrl, serviceCategory, city, region, bio, rating,
  followerCount, startingPrice?, contact:{ email?, phone? }, verified }`.
  Rejects non-services or unverified vendors with 404. Posts come from the
  existing `GET /api/public/updates/by/vendor/:id`; reviews from 5.3.
- Categories for filter chips are served from the client constant (no endpoint);
  optional counts can be added later.

### 5.3 Enquiries + reviews (consumer, buyer-auth)

- `POST /api/public/services/:businessId/enquiries` (buyer-auth) — create an
  `Enquiry`; prefill contact from the buyer; then fire an `enquiry_received`
  notification to the business (reuse `NotificationService`). Fails loudly on
  send/save error (no silent fallback).
- `GET /api/public/services/:businessId/reviews` (public) — list service reviews.
- `POST /api/public/services/:businessId/reviews` (buyer-auth) — submit; **gated**
  on ≥1 existing `Enquiry` from this buyer to this business; one per buyer per
  business (partial unique index). Rejects with 403 if the buyer never enquired.

### 5.4 Business self-service (services-vendor auth, app `'tickets'`)

- `GET /api/tickets/services/enquiries` (`MANAGE_ENQUIRIES`) — the inbox, newest
  first, hydrated with buyer name/contact.
- `PATCH /api/tickets/services/enquiries/:id/status` (`MANAGE_ENQUIRIES`) — set
  `read`/`replied`/`closed` (own enquiries only).
- Profile edits reuse `PATCH /api/tickets/organizer/profile`, extended to accept
  optional `serviceCategory`, `startingPrice`, `address.city` when the caller is
  a services vendor.

## 6. Frontend (`landing/`)

### 6.1 Signup toggle
- `BuyerAuthPanel.tsx` gains an **`allowBusiness?: boolean`** prop (default
  `false`, so the ~13 other embed sites are unchanged). Only the main "Tickets"
  signup surface (`MyTicketsLoginPage`) passes `allowBusiness`.
- When on, the Sign-up tab shows a **User | Business** segmented control. Business
  mode collects `businessName`, `serviceCategory` (dropdown), `city`, email-or-
  phone, password → OTP → `businessRegister` → `signInVendor(token, refresh)`.
- A newly signed-in Business is a **vendor session**; it lands on its business
  area (see 6.5).

### 6.2 Services directory — `ServicesPage` at `/services`
- Search bar + category filter chips (`All` + 11) + provider-card grid. Mirrors
  the Figma "Event Services" screen. New `ServiceCard`, `CategoryChips`.
- Add **"Services"** (Briefcase icon) to `src/components/layout/Sidebar.tsx`
  `items` and to `src/components/layout/BottomNav.tsx`.

### 6.3 Business profile — `BusinessProfilePage` at `/services/:businessId`
- Cover + logo + name + category badge + location + rating + "From E__/day" +
  **Enquire Now** + contact chips + tabs **Portfolio** (reuse `UpdatesGrid`
  `authorType="vendor"`) / **Reviews** / **About**. Reuse `FollowButton`
  (`targetType="organizer"`), `StarRating`. Mirrors the Figma "Luxe Decor" screen.
- `EnquiryModal`: event date, event type, message, contact (prefilled). Anon
  users hit the inline `BuyerAuthPanel` first (existing pattern).
- Reviews tab: if the viewer has enquired and not yet reviewed, show "Write a
  review".

### 6.4 API client
- New `src/services/servicesApi.ts`: `listServices`, `getBusiness`,
  `getBusinessReviews`, `submitEnquiry`, `submitReview`, `businessRegister`
  (+ reuse `requestRegistrationOtp`), `getMyEnquiries`, `updateEnquiryStatus`.
  Follows the `socialApi` arrow-function + `authed<T>` pattern.

### 6.5 Session + routing
- `SessionContext`: the vendor bootstrap (`getBrandProfile`) exposes
  `operatorType`. `HomeRoute` routes a **services** vendor to its **own public
  business profile** (`BusinessProfilePage` for its own id) rather than
  `/events`, so the first thing it sees is what customers see, with an owner-only
  affordance to edit the profile and a prominent link to the **Enquiries inbox**.
  Event organizers are unchanged.
- New `EnquiriesPage` for the business owner (inbox list + status controls),
  reached from the profile and the nav.

## 7. Migration & ops

1. **Review index migration** (Slice 5, before deploy): drop the existing
   `{ eventId: 1, buyerId: 1 }` unique index and create the two partial unique
   indexes in §3.5. All existing reviews have `eventId`, so the event-review
   partial index covers them identically; no data change. Carrot Tickets is
   MongoDB/Mongoose — run a one-off script that drops the old `{eventId, buyerId}`
   unique index and calls `Review.syncIndexes()` (Mongoose will not drop a
   changed unique index automatically), against dev then prod.
2. **No backfill** — existing vendors keep `operatorType` untouched; the new
   fields are absent until a business sets them.
3. `enquiry_received` notification type added to the notification enum.

## 8. Build order (slices)

Each slice is independently shippable and TDD'd.

1. **Account + signup** — `OperatorType.SERVICES`, `serviceCategory` +
   `startingPrice` on Vendor, `serviceCategories` constant, permission partition
   (`SERVICES_PERMISSIONS` + `MANAGE_ENQUIRIES`), `POST /auth/business/register`,
   and the `BuyerAuthPanel` User|Business toggle + `signInVendor`. **End-to-end:
   create a business, land on its own public profile.**
2. **Services directory** — `GET /api/public/services`, `ServicesPage`, sidebar +
   bottom-nav item.
3. **Business profile** — `GET /api/public/services/:id`, `BusinessProfilePage`
   (Portfolio/About), FollowButton/StarRating reuse.
4. **Enquiries** — `Enquiry` model, create + inbox + status endpoints,
   `EnquiryModal`, `EnquiriesPage`, `enquiry_received` notification.
5. **Reviews** — `Review.eventId` optional + index migration, enquiry-gated
   submit/list endpoints, Reviews tab write path.

## 9. Testing

- **api:** unit + route tests per slice. Key cases: services register creates a
  PENDING services vendor with a scoped token containing **no** ticket perms;
  directory excludes unverified/non-services; enquiry create notifies; review
  submit 403s without a prior enquiry and 409/dedupes on a second review;
  permission scoping for all four operator types.
- **landing:** component tests for the signup toggle (business mode → vendor
  session), `ServiceCard`, category filtering, `EnquiryModal` gating on auth.
- Verify the `landing` build with `npm run build` (not just `tsc --noEmit`) —
  Pages build catches `noUnusedLocals` the typecheck misses.

## 10. Open follow-ups (explicitly deferred, not v1)

- Category counts on filter chips.
- Redirect `/o/:vendorId` → `/services/:id` when a vendor is a services type.
- Enquiry replies as in-app threads (v1 status is `replied` as a manual flag).
- `startingPrice.unit` UI beyond `'day'`.
