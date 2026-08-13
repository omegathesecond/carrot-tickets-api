# Event Service Businesses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users sign up as an event **service business** (Sound hire, Catering, etc.) that has a public profile and appears in a filterable **Services** directory but sells no tickets — customers reach them via an **enquiry** form and can review them after enquiring.

**Architecture:** A Business is a `Vendor` with `operatorType: 'services'` + a `serviceCategory`, reusing the existing brand/social stack (profile, posts, followers, rating aggregate, verification, logo). Net-new backend: three `Vendor` fields, a `SERVICES` permission vertical, an `Enquiry` lead model, a services directory/profile service, and event-less reviews. Net-new frontend (`landing/`): a User|Business signup toggle, a Services directory page, a Business profile page, an enquiry modal, and a business enquiries inbox.

**Tech Stack:** api — Node + TypeScript + Express + Mongoose (MongoDB) + Joi + Jest. landing — React + Vite + TypeScript + react-router v6 + Vitest/RTL + Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-13-event-service-businesses-design.md` (read it alongside this plan).

## Global Constraints

- **Both repos, additive only.** No breaking changes to existing organizer/buyer/ticket flows, the dashboard, or pos-app. (CLAUDE.md: never break compat without asking.)
- **No silent fallbacks.** Every failed dependency call surfaces via the normal error channel (thrown `HttpError`/`Error` → 4xx/5xx, or a UI error state). Never substitute canned data. (CLAUDE.md.)
- **Money in cents, currency SZL (E).** `startingPrice.amountCents` is an integer; display "From E{amount}/day".
- **Service categories (11, verbatim labels):** Sound hire · Food stalls · Furniture & Decor · Toilet rental · Catering · Photography · Lighting · Security · Marquees & tent · Transport · Other.
- **Business signup is OTP-gated**, audience `'vendor'`, reusing `OtpService` — mirrors the organizer signup already on `main` (`TicketsAuthService.register`).
- **A verified-only directory:** the public list shows only `operatorType:'services'` + `verificationStatus:'verified'` + `isActive:true`.
- **DRY:** reuse `ReviewService.vendorAggregate`, `FollowService`, `UpdatesGrid`, `StarRating`, `FollowButton`, `BuyerAuthPanel`, the `socialApi`/`api` client patterns — do not reimplement.
- **api path aliases:** imports use `@models/…`, `@services/…`, `@interfaces/…`, `@utils/…`, `@controllers/…`, `@validators/…`, `@/constants/…` (see tsconfig paths).
- **Task ordering is dependency-ordered.** The spec groups "account + signup + land on profile" as slice 1; this plan implements the profile page (Task group C) *before* signup routing (D) so signup can land on a real profile.

**Verification commands** (run from the repo root of the file you changed):
- api tests: `cd api && npx jest <path> --runInBand`
- landing build (catches `noUnusedLocals` that `tsc --noEmit` misses): `cd landing && npm run build`
- landing tests: `cd landing && npx vitest run <path>`

> Worktrees: api work happens in `api-services-wt/` (branch `feat/event-service-businesses`, off `origin/main`). Create the landing worktree the same way before Task group C's first landing task: `git -C landing worktree add ../landing-services-wt -b feat/event-service-businesses origin/master` then `cd ../landing-services-wt && npm install`.

---

## Task Group A — Backend account foundation (api)

### Task A1: `OperatorType.SERVICES` + service-category constant + Vendor fields

**Files:**
- Modify: `src/interfaces/vendor.interface.ts` (OperatorType enum + IVendor fields)
- Create: `src/constants/serviceCategories.ts`
- Modify: `src/models/vendor.model.ts` (schema fields)
- Test: `src/models/__tests__/vendor.services.test.ts`

**Interfaces:**
- Produces: `OperatorType.SERVICES = 'services'`; `ServiceCategory` (union of 11 slugs); `SERVICE_CATEGORIES` (`{value,label}[]`), `SERVICE_CATEGORY_VALUES: string[]`; `IVendor.serviceCategory?`, `IVendor.startingPrice?: { amountCents: number; unit: 'day'|'event'|'hour' }`.

- [ ] **Step 1: Write the constant** `src/constants/serviceCategories.ts`

```ts
export const SERVICE_CATEGORIES = [
  { value: 'sound_hire',      label: 'Sound hire' },
  { value: 'food_stalls',     label: 'Food stalls' },
  { value: 'furniture_decor', label: 'Furniture & Decor' },
  { value: 'toilet_rental',   label: 'Toilet rental' },
  { value: 'catering',        label: 'Catering' },
  { value: 'photography',     label: 'Photography' },
  { value: 'lighting',        label: 'Lighting' },
  { value: 'security',        label: 'Security' },
  { value: 'marquees_tents',  label: 'Marquees & tent' },
  { value: 'transport',       label: 'Transport' },
  { value: 'other',           label: 'Other' },
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]['value'];
export const SERVICE_CATEGORY_VALUES: ServiceCategory[] = SERVICE_CATEGORIES.map((c) => c.value);
export const STARTING_PRICE_UNITS = ['day', 'event', 'hour'] as const;
export type StartingPriceUnit = (typeof STARTING_PRICE_UNITS)[number];
```

- [ ] **Step 2: Extend the interface** `src/interfaces/vendor.interface.ts`

Add `SERVICES = 'services'` to `OperatorType`, and to `IVendor` (after `bio`):
```ts
  serviceCategory?: import('@/constants/serviceCategories').ServiceCategory;
  startingPrice?: { amountCents: number; unit: import('@/constants/serviceCategories').StartingPriceUnit };
```

- [ ] **Step 3: Write the failing model test** `src/models/__tests__/vendor.services.test.ts`

```ts
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';

describe('Vendor — services fields', () => {
  it('persists a services vendor with category and starting price', async () => {
    const v = await Vendor.create({
      businessName: 'Luxe Decor', phoneNumber: '+26876000001', password: 'secret1',
      operatorType: OperatorType.SERVICES, serviceCategory: 'furniture_decor',
      startingPrice: { amountCents: 18000, unit: 'day' },
    });
    expect(v.operatorType).toBe('services');
    expect(v.serviceCategory).toBe('furniture_decor');
    expect(v.startingPrice?.amountCents).toBe(18000);
    expect(v.startingPrice?.unit).toBe('day');
  });

  it('rejects an unknown service category', async () => {
    await expect(Vendor.create({
      businessName: 'X', phoneNumber: '+26876000002', password: 'secret1',
      operatorType: OperatorType.SERVICES, serviceCategory: 'bouncy_castle' as any,
    })).rejects.toThrow();
  });

  it('requires a category when operatorType is services', async () => {
    await expect(Vendor.create({
      businessName: 'NoCat', phoneNumber: '+26876000003', password: 'secret1',
      operatorType: OperatorType.SERVICES,
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run it, expect FAIL** — `cd api && npx jest src/models/__tests__/vendor.services.test.ts --runInBand` (fails: fields/enum not defined).

- [ ] **Step 5: Add the schema fields** `src/models/vendor.model.ts` (after the `bio` field, before `primaryContact`):

```ts
  // Service business (operatorType 'services') — the vertical of the supplier.
  serviceCategory: {
    type: String,
    enum: SERVICE_CATEGORY_VALUES,
    required: [
      function (this: IVendor) { return this.operatorType === OperatorType.SERVICES; },
      'A service category is required for service businesses',
    ],
    index: true,
  },
  startingPrice: {
    type: new Schema(
      { amountCents: { type: Number, min: 0, required: true },
        unit: { type: String, enum: STARTING_PRICE_UNITS, default: 'day' } },
      { _id: false },
    ),
    required: false,
  },
```
Add the import at the top: `import { SERVICE_CATEGORY_VALUES, STARTING_PRICE_UNITS } from '@/constants/serviceCategories';`

- [ ] **Step 6: Run it, expect PASS** — same jest command.

- [ ] **Step 7: Commit**
```bash
git add src/interfaces/vendor.interface.ts src/constants/serviceCategories.ts src/models/vendor.model.ts src/models/__tests__/vendor.services.test.ts
git commit -m "feat(vendor): services operatorType + serviceCategory + startingPrice"
```

### Task A2: `SERVICES` permission vertical

**Files:**
- Modify: `src/interfaces/ticketsPermission.interface.ts` (new perm + `SERVICES_PERMISSIONS`)
- Modify: `src/utils/permissions.util.ts` (`disallowedForType` generalization)
- Test: `src/utils/__tests__/permissions.services.test.ts`

**Interfaces:**
- Produces: `TicketsPermission.MANAGE_ENQUIRIES = 'tickets:manage_enquiries'`; `SERVICES_PERMISSIONS`; `scopePermissionsToType(perms, OperatorType.SERVICES)` strips all EVENT + TRANSPORT perms.

- [ ] **Step 1: Write the failing test** `src/utils/__tests__/permissions.services.test.ts`

```ts
import { scopePermissionsToType } from '@utils/permissions.util';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsPermission, TICKETS_ROLE_PERMISSIONS, TicketsRole } from '@interfaces/ticketsPermission.interface';

describe('scopePermissionsToType — SERVICES', () => {
  const owner = TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER];

  it('strips all ticket/event/transport perms but keeps brand + enquiries', () => {
    const scoped = scopePermissionsToType(owner, OperatorType.SERVICES);
    expect(scoped).toContain(TicketsPermission.EDIT_BRAND);
    expect(scoped).toContain(TicketsPermission.MANAGE_ENQUIRIES);
    expect(scoped).not.toContain(TicketsPermission.SELL_TICKETS);
    expect(scoped).not.toContain(TicketsPermission.CREATE_EVENT);
    expect(scoped).not.toContain(TicketsPermission.MANAGE_TRANSPORT);
  });

  it('keeps MANAGE_ENQUIRIES out of an events owner (services vertical stripped)', () => {
    const scoped = scopePermissionsToType(owner, OperatorType.EVENTS);
    expect(scoped).not.toContain(TicketsPermission.MANAGE_ENQUIRIES);
    expect(scoped).toContain(TicketsPermission.SELL_TICKETS);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npx jest src/utils/__tests__/permissions.services.test.ts --runInBand`.

- [ ] **Step 3: Add the permission + group** `src/interfaces/ticketsPermission.interface.ts`

In the enum, after `EDIT_BRAND`:
```ts
  ,
  // Service-business leads — a services vendor reads/updates its own enquiry
  // inbox. Vertical (SERVICES) so scoping strips it from events/transport.
  MANAGE_ENQUIRIES = 'tickets:manage_enquiries'
```
After `TRANSPORT_PERMISSIONS`:
```ts
export const SERVICES_PERMISSIONS: TicketsPermission[] = [
  TicketsPermission.MANAGE_ENQUIRIES,
];
```

- [ ] **Step 4: Generalize `disallowedForType`** `src/utils/permissions.util.ts`

```ts
import {
  TicketsPermission, EVENT_PERMISSIONS, TRANSPORT_PERMISSIONS, SERVICES_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';
import { OperatorType } from '@interfaces/vendor.interface';

/** Strip every vertical EXCEPT the operator's own (full disjoint partition). */
function disallowedForType(type: OperatorType): Set<TicketsPermission> {
  switch (type) {
    case OperatorType.EVENTS:    return new Set([...TRANSPORT_PERMISSIONS, ...SERVICES_PERMISSIONS]);
    case OperatorType.TRANSPORT: return new Set([...EVENT_PERMISSIONS, ...SERVICES_PERMISSIONS]);
    case OperatorType.SERVICES:  return new Set([...EVENT_PERMISSIONS, ...TRANSPORT_PERMISSIONS]);
    case OperatorType.BOTH:      return new Set(SERVICES_PERMISSIONS); // events+transport, not a service biz
    default:                     return new Set();
  }
}
```
(Keep `scopePermissionsToType` unchanged.)

- [ ] **Step 5: Run it, expect PASS.** Also run the existing `src/utils/__tests__/permissions*.test.ts` to confirm no regression.

- [ ] **Step 6: Commit**
```bash
git add src/interfaces/ticketsPermission.interface.ts src/utils/permissions.util.ts src/utils/__tests__/permissions.services.test.ts
git commit -m "feat(permissions): SERVICES vertical strips ticket perms, keeps brand + enquiries"
```

### Task A3: Business signup service + validator

**Files:**
- Modify: `src/services/ticketsAuth.service.ts` (add `registerBusiness`)
- Modify: `src/validators/tickets.validator.ts` (add `businessRegisterSchema`)
- Test: `src/services/__tests__/ticketsAuth.business.test.ts`

**Interfaces:**
- Consumes: `OtpService.issue`/`withVerified` (audience `'vendor'`), `scopePermissionsToType`.
- Produces: `TicketsAuthService.registerBusiness(params: { businessName; email?; phoneNumber?; password; serviceCategory: ServiceCategory; startingPrice?: {amountCents:number; unit?:StartingPriceUnit}; city?; code: string })` → `{ accessToken, refreshToken, user }` (same shape as `register`); `businessRegisterSchema`.

- [ ] **Step 1: Write the validator** `src/validators/tickets.validator.ts`

Add import: `import { SERVICE_CATEGORY_VALUES, STARTING_PRICE_UNITS } from '@/constants/serviceCategories';`
```ts
export const businessRegisterSchema = Joi.object({
  businessName: Joi.string().required().trim().max(100).messages({
    'string.empty': 'Business name is required', 'any.required': 'Business name is required',
  }),
  serviceCategory: Joi.string().valid(...SERVICE_CATEGORY_VALUES).required().messages({
    'any.only': 'Choose a valid service category', 'any.required': 'Choose a service category',
  }),
  email: Joi.string().email().trim().lowercase().optional(),
  phoneNumber: Joi.string().trim().max(20).optional(),
  password: Joi.string().required().min(6),
  code: Joi.string().required().pattern(/^\d{6}$/).messages({
    'string.pattern.base': 'Enter the 6-digit code we sent you',
  }),
  city: Joi.string().trim().max(100).optional(),
  startingPrice: Joi.object({
    amountCents: Joi.number().integer().min(0).required(),
    unit: Joi.string().valid(...STARTING_PRICE_UNITS).default('day'),
  }).optional(),
}).or('email', 'phoneNumber').messages({ 'object.missing': 'An email address or phone number is required' });
```

- [ ] **Step 2: Write the failing service test** `src/services/__tests__/ticketsAuth.business.test.ts`

```ts
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { OtpService } from '@services/otp.service';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';

// Bypass real OTP: run the guarded action, no code check.
jest.spyOn(OtpService, 'withVerified').mockImplementation(async (_a, _i, _c, action: any) => action());

describe('TicketsAuthService.registerBusiness', () => {
  it('creates a PENDING services vendor and mints a token with no ticket perms', async () => {
    const res = await TicketsAuthService.registerBusiness({
      businessName: 'SoundWave Pro', phoneNumber: '+26876111222', password: 'secret1',
      serviceCategory: 'sound_hire', startingPrice: { amountCents: 25000, unit: 'day' }, code: '000000',
    });
    const v = await Vendor.findOne({ phoneNumber: '+26876111222' });
    expect(v?.operatorType).toBe(OperatorType.SERVICES);
    expect(v?.serviceCategory).toBe('sound_hire');
    expect(v?.verificationStatus).toBe('pending');
    const claims: any = jwt.verify(res.accessToken, JWT_SECRET);
    expect(claims.permissions).toContain(TicketsPermission.MANAGE_ENQUIRIES);
    expect(claims.permissions).not.toContain(TicketsPermission.SELL_TICKETS);
    expect(res.refreshToken).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it, expect FAIL** — `npx jest src/services/__tests__/ticketsAuth.business.test.ts --runInBand`.

- [ ] **Step 4: Implement `registerBusiness`** in `src/services/ticketsAuth.service.ts` — mirror `register` (lines 84–140+) but set the services fields. Add near `register`:

```ts
  static async registerBusiness(params: {
    businessName: string; email?: string; phoneNumber?: string; password: string;
    serviceCategory: string; startingPrice?: { amountCents: number; unit?: 'day' | 'event' | 'hour' };
    city?: string; code: string;
  }) {
    const { businessName, email, phoneNumber, password, serviceCategory, startingPrice, city, code } = params;
    const id = this.signupIdentifier(email, phoneNumber);
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters long');
    if (email && await Vendor.findOne({ email })) throw new Error('An account with this email already exists');
    if (phoneNumber && await Vendor.findOne({ phoneNumber })) throw new Error('An account with this phone number already exists');

    const vendor = await OtpService.withVerified('vendor', id, code, async () => {
      const v = new Vendor({
        businessName, email, phoneNumber, password,
        operatorType: OperatorType.SERVICES, serviceCategory,
        ...(startingPrice ? { startingPrice: { amountCents: startingPrice.amountCents, unit: startingPrice.unit ?? 'day' } } : {}),
        ...(city ? { address: { city } } : {}),
      });
      await v.save();
      return v;
    });

    const ownerPerms = scopePermissionsToType(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER], vendor.operatorType);
    const payload = { vendorId: vendor._id.toString(), userType: 'vendor', app: 'tickets', role: TicketsRole.OWNER, permissions: ownerPerms, isSuperAdmin: false };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);
    const refreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(refreshToken, undefined, vendor._id.toString(), 'vendor');
    return { accessToken, refreshToken, user: this.toAuthUser(vendor) };
  }
```
> If `register` builds its return via inline object rather than a `toAuthUser` helper, copy that exact tail (lines ~140–160) instead of `this.toAuthUser(vendor)`. Read `register` first and match its return shape verbatim.

- [ ] **Step 5: Run it, expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add src/services/ticketsAuth.service.ts src/validators/tickets.validator.ts src/services/__tests__/ticketsAuth.business.test.ts
git commit -m "feat(auth): registerBusiness creates a services vendor (OTP-gated)"
```

### Task A4: Business signup controller + route

**Files:**
- Modify: `src/controllers/tickets.controller.ts` (add `registerBusiness` handler + import `businessRegisterSchema`)
- Modify: `src/routes/tickets.route.ts` (add route above the `dualAuth` wall, near line 34)
- Test: `src/routes/__tests__/businessAuth.route.test.ts`

**Interfaces:**
- Produces: `POST /api/tickets/auth/business/register` → 201 `{ accessToken, refreshToken, user }`. Step 1 reuses the existing `POST /api/tickets/auth/register/request-otp`.

- [ ] **Step 1: Write the failing route test** `src/routes/__tests__/businessAuth.route.test.ts` — model it on the existing `register` route test. Mock `OtpService.withVerified` as in A3, POST to `/api/tickets/auth/business/register` with a valid body, assert 201 + `data.accessToken`, and assert a 400 when `serviceCategory` is missing.

- [ ] **Step 2: Run it, expect FAIL** — `npx jest src/routes/__tests__/businessAuth.route.test.ts --runInBand`.

- [ ] **Step 3: Add the controller** `src/controllers/tickets.controller.ts` (after `register`, import `businessRegisterSchema` in the validator import block):

```ts
  /**
   * POST /api/tickets/auth/business/register — create an event SERVICE business
   * (operatorType 'services'): sells no tickets, appears in the Services
   * directory once verified. OTP-gated (reuses /auth/register/request-otp).
   */
  static async registerBusiness(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = businessRegisterSchema.validate(req.body);
      if (error) { ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400); return; }
      const result = await TicketsAuthService.registerBusiness(value);
      ApiResponseUtil.created(res, result, 'Business account created. Your profile goes live once verified.');
    } catch (error: any) {
      console.error('Business register error:', error);
      ApiResponseUtil.error(res, error.message || 'Registration failed', 400);
    }
  }
```

- [ ] **Step 4: Add the route** `src/routes/tickets.route.ts` (right after line 34's `/auth/register`):
```ts
router.post('/auth/business/register', TicketsController.registerBusiness);
```

- [ ] **Step 5: Run it, expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add src/controllers/tickets.controller.ts src/routes/tickets.route.ts src/routes/__tests__/businessAuth.route.test.ts
git commit -m "feat(auth): POST /api/tickets/auth/business/register"
```

---

## Task Group B — Services directory + profile endpoints (api)

### Task B1: `ServicesService` — directory list + business profile

**Files:**
- Create: `src/services/services.service.ts`
- Test: `src/services/__tests__/services.service.test.ts`

**Interfaces:**
- Produces:
  - `ServicesService.listDirectory(opts: { category?: string; search?: string; before?: string; limit?: number }): Promise<ServiceCard[]>` where `ServiceCard = { id; businessName; slug; logoUrl; serviceCategory; city; rating: {average,count}; startingPrice?; tagline }`.
  - `ServicesService.getBusinessProfile(businessId: string): Promise<BusinessProfile>` where `BusinessProfile = { id; businessName; slug; logoUrl; serviceCategory; city; region; bio; rating; followerCount; startingPrice?; contact: {email?; phone?}; verified: true }`; throws `HttpError(404)` if not a verified active services vendor.

- [ ] **Step 1: Write the failing test** `src/services/__tests__/services.service.test.ts`

```ts
import { ServicesService } from '@services/services.service';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';

async function mkBiz(over: any = {}) {
  return Vendor.create({
    businessName: over.businessName ?? 'Luxe Decor', phoneNumber: over.phoneNumber ?? '+2687650' + Math.floor(Math.random()*100000),
    password: 'secret1', operatorType: OperatorType.SERVICES, serviceCategory: over.serviceCategory ?? 'furniture_decor',
    verificationStatus: over.verificationStatus ?? VerificationStatus.VERIFIED, bio: over.bio ?? 'Elegant furniture & styling',
    address: over.address, startingPrice: over.startingPrice,
  });
}

describe('ServicesService.listDirectory', () => {
  it('lists only verified active services vendors', async () => {
    await mkBiz({ businessName: 'Verified Co' });
    await mkBiz({ businessName: 'Pending Co', verificationStatus: VerificationStatus.PENDING });
    await Vendor.create({ businessName: 'Event Org', phoneNumber: '+26876999001', password: 'secret1', operatorType: OperatorType.EVENTS });
    const cards = await ServicesService.listDirectory({});
    const names = cards.map((c) => c.businessName);
    expect(names).toContain('Verified Co');
    expect(names).not.toContain('Pending Co');
    expect(names).not.toContain('Event Org');
  });

  it('filters by category and searches by name', async () => {
    await mkBiz({ businessName: 'SoundWave', serviceCategory: 'sound_hire' });
    await mkBiz({ businessName: 'FoodFest', serviceCategory: 'food_stalls' });
    expect((await ServicesService.listDirectory({ category: 'sound_hire' })).map((c) => c.businessName)).toEqual(['SoundWave']);
    expect((await ServicesService.listDirectory({ search: 'food' })).map((c) => c.businessName)).toEqual(['FoodFest']);
  });
});

describe('ServicesService.getBusinessProfile', () => {
  it('returns the profile for a verified services vendor', async () => {
    const v = await mkBiz({ startingPrice: { amountCents: 18000, unit: 'day' }, address: { city: 'Manzini', region: 'Manzini' } });
    const p = await ServicesService.getBusinessProfile(String(v._id));
    expect(p.businessName).toBe('Luxe Decor');
    expect(p.serviceCategory).toBe('furniture_decor');
    expect(p.startingPrice?.amountCents).toBe(18000);
    expect(p.city).toBe('Manzini');
    expect(p.verified).toBe(true);
  });

  it('404s for an events vendor', async () => {
    const v = await Vendor.create({ businessName: 'Org', phoneNumber: '+26876999002', password: 'secret1', operatorType: OperatorType.EVENTS });
    await expect(ServicesService.getBusinessProfile(String(v._id))).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement `src/services/services.service.ts`** (reuse `ReviewService.vendorAggregate` + `FollowService.followerCount`):

```ts
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';
import { ReviewService } from '@services/review.service';
import { FollowService } from '@services/follow.service';
import { HttpError } from '@utils/httpError.util';

const HEX24 = /^[a-f0-9]{24}$/i;
const DIRECTORY_FILTER = { operatorType: OperatorType.SERVICES, verificationStatus: VerificationStatus.VERIFIED, isActive: true };
const tagline = (bio?: string) => (bio ? (bio.length > 120 ? bio.slice(0, 117) + '…' : bio) : null);

export interface ServiceCard {
  id: string; businessName: string; slug: string | null; logoUrl: string | null;
  serviceCategory: string; city: string | null;
  rating: { average: number | null; count: number };
  startingPrice: { amountCents: number; unit: string } | null; tagline: string | null;
}

export class ServicesService {
  static async listDirectory(opts: { category?: string; search?: string; before?: string; limit?: number } = {}): Promise<ServiceCard[]> {
    const limit = Math.min(Math.max(opts.limit ?? 24, 1), 50);
    const query: Record<string, unknown> = { ...DIRECTORY_FILTER };
    if (opts.category) query['serviceCategory'] = opts.category;
    if (opts.search) query['businessName'] = { $regex: opts.search.trim(), $options: 'i' };
    if (opts.before && HEX24.test(opts.before)) query['_id'] = { $lt: opts.before };

    const docs = await Vendor.find(query)
      .select('businessName slug logoUrl serviceCategory address bio startingPrice')
      .sort({ _id: -1 }).limit(limit);

    // Rating aggregate per vendor (small page, so N small aggregates is fine).
    return Promise.all(docs.map(async (v): Promise<ServiceCard> => ({
      id: String(v._id), businessName: v.businessName, slug: (v as any).slug ?? null,
      logoUrl: v.logoUrl ?? null, serviceCategory: (v as any).serviceCategory,
      city: v.address?.city ?? null, rating: await ReviewService.vendorAggregate(String(v._id)),
      startingPrice: (v as any).startingPrice ?? null, tagline: tagline(v.bio),
    })));
  }

  static async getBusinessProfile(businessId: string) {
    if (!HEX24.test(businessId)) throw new HttpError(400, 'Invalid business id');
    const v = await Vendor.findOne({ _id: businessId, ...DIRECTORY_FILTER })
      .select('businessName slug logoUrl serviceCategory address bio startingPrice email phoneNumber');
    if (!v) throw new HttpError(404, 'Business not found');
    const [rating, followerCount] = await Promise.all([
      ReviewService.vendorAggregate(businessId),
      FollowService.followerCount('organizer', businessId),
    ]);
    return {
      id: String(v._id), businessName: v.businessName, slug: (v as any).slug ?? null,
      logoUrl: v.logoUrl ?? null, serviceCategory: (v as any).serviceCategory,
      city: v.address?.city ?? null, region: v.address?.region ?? null, bio: v.bio ?? null,
      rating, followerCount, startingPrice: (v as any).startingPrice ?? null,
      contact: { email: (v as any).email ?? null, phone: (v as any).phoneNumber ?? null },
      verified: true as const,
    };
  }
}
```
> `email`/`phoneNumber` are not `select:false`, so the explicit `.select()` includes them. Verify `FollowService.followerCount('organizer', id)` matches the signature used in `organizerProfile.controller.ts:90`.

- [ ] **Step 4: Run it, expect PASS.**

- [ ] **Step 5: Commit**
```bash
git add src/services/services.service.ts src/services/__tests__/services.service.test.ts
git commit -m "feat(services): directory list + business profile service"
```

### Task B2: Public services routes + controller

**Files:**
- Create: `src/controllers/services.controller.ts`
- Modify: `src/routes/public.route.ts` (add two GET routes near the `/organizers/:vendorId` block, ~line 203)
- Test: `src/routes/__tests__/services.route.test.ts`

**Interfaces:**
- Produces: `GET /api/public/services?category=&search=&before=&limit=` → `{ items }`; `GET /api/public/services/:businessId` → the profile object.

- [ ] **Step 1: Write the failing route test** `src/routes/__tests__/services.route.test.ts` — seed a verified services vendor (as in B1), GET `/api/public/services` → 200 with the card in `data.items`; GET `/api/public/services/:id` → 200; GET a random hex id → 404.

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement the controller** `src/controllers/services.controller.ts`:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { ServicesService } from '@services/services.service';
import { HttpError } from '@utils/httpError.util';

export class ServicesController {
  static async directory(req: Request, res: Response): Promise<any> {
    try {
      const items = await ServicesService.listDirectory({
        category: req.query['category'] ? String(req.query['category']) : undefined,
        search: req.query['search'] ? String(req.query['search']) : undefined,
        before: req.query['before'] ? String(req.query['before']) : undefined,
        limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
      });
      return ApiResponseUtil.success(res, { items }, 'Services');
    } catch (e: any) { return ApiResponseUtil.error(res, e.message || 'Failed to list services', e instanceof HttpError ? e.status : 500); }
  }

  static async profile(req: Request, res: Response): Promise<any> {
    try {
      const data = await ServicesService.getBusinessProfile(String(req.params['businessId'] || ''));
      return ApiResponseUtil.success(res, data, 'Business profile');
    } catch (e: any) { return ApiResponseUtil.error(res, e.message || 'Not found', e instanceof HttpError ? e.status : 500); }
  }
}
```

- [ ] **Step 4: Wire routes** `src/routes/public.route.ts` (import `ServicesController`; add near the organizers block). **Order matters** — the static `/services` list must be registered before `/services/:businessId`:
```ts
router.get('/services', ServicesController.directory);
router.get('/services/:businessId', ServicesController.profile);
```

- [ ] **Step 5: Run it, expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add src/controllers/services.controller.ts src/routes/public.route.ts src/routes/__tests__/services.route.test.ts
git commit -m "feat(services): public GET /api/public/services[/:id]"
```

---

## Task Group C — Landing: profile page + directory + signup

> Create the landing worktree now (see header note) and `npm install`. Mirror the category constant first.

### Task C1: Frontend constant + `servicesApi` client

**Files:**
- Create: `landing/src/constants/serviceCategories.ts` (mirror of api's — same values/labels)
- Create: `landing/src/services/servicesApi.ts`
- Modify: `landing/src/types/social.ts` (add `ServiceCard`, `BusinessProfile` types)

**Interfaces:**
- Produces: `servicesApi.listServices(params)`, `servicesApi.getBusiness(id)`, `servicesApi.getBusinessReviews(id)`, `servicesApi.businessRequestOtp(body)`, `servicesApi.businessRegister(body)`, `servicesApi.submitEnquiry(id, body)`, `servicesApi.submitReview(id, body)`, `servicesApi.getMyEnquiries()`, `servicesApi.updateEnquiryStatus(id, status)`.

- [ ] **Step 1:** Copy `SERVICE_CATEGORIES`/`ServiceCategory`/`STARTING_PRICE_UNITS` into `landing/src/constants/serviceCategories.ts` (identical values). Add `categoryLabel(value): string` helper.

- [ ] **Step 2:** Add types to `landing/src/types/social.ts`:
```ts
export interface ServiceCard {
  id: string; businessName: string; slug: string | null; logoUrl: string | null;
  serviceCategory: string; city: string | null;
  rating: { average: number | null; count: number };
  startingPrice: { amountCents: number; unit: string } | null; tagline: string | null;
}
export interface BusinessProfile extends Omit<ServiceCard, 'tagline'> {
  region: string | null; bio: string | null; followerCount: number;
  contact: { email: string | null; phone: string | null }; verified: boolean;
}
```

- [ ] **Step 3:** Implement `landing/src/services/servicesApi.ts` following the `socialApi.ts` `authed<T>`/`fetchApi` pattern (see `socialApi.ts:77,99,428`). Signup calls hit the vendor auth base; use `fetchApi` directly and unwrap `.data`:
```ts
import { fetchApi, ApiResponse, setVendorSession } from './api';
import { authed } from './socialApi';
import type { ServiceCard, BusinessProfile } from '../types/social';

export const servicesApi = {
  listServices: (p: { category?: string; search?: string; before?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();
    return authed<{ items: ServiceCard[] }>(`/api/public/services${q ? `?${q}` : ''}`);
  },
  getBusiness: (id: string) => authed<BusinessProfile>(`/api/public/services/${id}`),
  getBusinessReviews: (id: string) => authed<{ items: unknown[] }>(`/api/public/services/${id}/reviews`),
  businessRequestOtp: (body: { email?: string; phoneNumber?: string }) =>
    fetchApi<ApiResponse<{ channel: 'sms' | 'email'; identifier: string }>>('/api/tickets/auth/register/request-otp', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data),
  businessRegister: (body: Record<string, unknown>) =>
    fetchApi<ApiResponse<{ accessToken: string; refreshToken: string; user: unknown }>>('/api/tickets/auth/business/register', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data),
  submitEnquiry: (id: string, body: Record<string, unknown>) =>
    authed<{ id: string }>(`/api/public/services/${id}/enquiries`, { method: 'POST', body: JSON.stringify(body) }),
  submitReview: (id: string, body: { rating: number; text?: string }) =>
    authed<{ id: string }>(`/api/public/services/${id}/reviews`, { method: 'POST', body: JSON.stringify(body) }),
  getMyEnquiries: () => authed<{ items: unknown[] }>(`/api/tickets/services/enquiries`),
  updateEnquiryStatus: (id: string, status: string) =>
    authed<{ ok: true }>(`/api/tickets/services/enquiries/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
};
```
> Confirm `authed` is exported from `socialApi.ts` (it is used internally at line 77 — export it if not already). `setVendorSession` import is used by C4.

- [ ] **Step 4:** `cd landing && npm run build` → passes (no unused locals). Commit:
```bash
git add landing/src/constants/serviceCategories.ts landing/src/services/servicesApi.ts landing/src/types/social.ts
git commit -m "feat(services): frontend category constant + servicesApi client"
```

### Task C2: `ServiceCard` + `CategoryChips` components

**Files:**
- Create: `landing/src/components/services/ServiceCard.tsx`, `landing/src/components/services/CategoryChips.tsx`
- Test: `landing/src/components/services/__tests__/ServiceCard.test.tsx`

- [ ] **Step 1: Write the failing test** — render `ServiceCard` with a `ServiceCard` fixture (name, category, city, rating count, `startingPrice`), assert it shows the business name, the category **label** (via `categoryLabel`), the city, "128 reviews", and "From E250/day". Add a case with `startingPrice: null` asserting no price text.

- [ ] **Step 2: Run it, expect FAIL** — `cd landing && npx vitest run src/components/services/__tests__/ServiceCard.test.tsx`.

- [ ] **Step 3: Implement** `ServiceCard.tsx` (link to `/services/:id`, reuse existing `StarRating` if suitable; format price as `E{Math.round(amountCents/100)}/{unit}`) and `CategoryChips.tsx` (an `All` chip + one per `SERVICE_CATEGORIES`, controlled `value`/`onChange`). Match the Figma "Event Services" card layout and coral accent tokens.

- [ ] **Step 4: Run it, expect PASS.**

- [ ] **Step 5: Commit**
```bash
git add landing/src/components/services/
git commit -m "feat(services): ServiceCard + CategoryChips"
```

### Task C3: `BusinessProfilePage` + route

**Files:**
- Create: `landing/src/pages/BusinessProfilePage.tsx`
- Modify: `landing/src/App.tsx` (add `/services/:businessId` route)
- Test: `landing/src/pages/__tests__/BusinessProfilePage.test.tsx`

**Interfaces:**
- Consumes: `servicesApi.getBusiness`, `servicesApi.getBusinessReviews`, `UpdatesGrid`, `StarRating`, `FollowButton`.
- Produces: route `/services/:businessId`.

- [ ] **Step 1: Write the failing test** — mock `servicesApi.getBusiness` to resolve a `BusinessProfile`; render at `/services/<id>`; assert name, category label, "From E180/day", the **Enquire Now** button, the contact chips, and the three tabs (Portfolio/Reviews/About) appear.

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement `BusinessProfilePage.tsx`** — model on `OrganizerProfilePage.tsx`: header (logo, name, category badge, city, `StarRating`, `FollowButton targetType="organizer"`), a "STARTING PRICE / From E__/{unit}" block, an **Enquire Now** button (opens `EnquiryModal` from Task D3 — until D3 lands, the button can route to a stub that C4 wires; leave a `TODO(D3)` only if D3 is not yet merged), contact chips, and tabs: **Portfolio** → `<UpdatesGrid authorType="vendor" authorId={businessId} />`, **Reviews** → list from `getBusinessReviews` (empty state "No reviews yet"), **About** → `bio` + city/region. Add `<Route path="/services/:businessId" element={<BusinessProfilePage />} />` to `App.tsx` (line ~115, beside `/o/:vendorId`).

- [ ] **Step 4: Run it, expect PASS + `npm run build`.**

- [ ] **Step 5: Commit**
```bash
git add landing/src/pages/BusinessProfilePage.tsx landing/src/App.tsx landing/src/pages/__tests__/BusinessProfilePage.test.tsx
git commit -m "feat(services): BusinessProfilePage at /services/:id"
```

### Task C4: `BuyerAuthPanel` User|Business signup toggle + land-on-profile

**Files:**
- Modify: `landing/src/components/BuyerAuthPanel.tsx` (add `allowBusiness` prop + business mode)
- Modify: `landing/src/pages/MyTicketsLoginPage.tsx` (pass `allowBusiness`)
- Modify: `landing/src/contexts/SessionContext.tsx` + `landing/src/services/socialApi.ts` (`getBrandProfile` returns `operatorType`)
- Modify: `landing/src/App.tsx` (`HomeRoute`: services vendor → `/services/:vendorId`)
- Test: `landing/src/components/__tests__/BuyerAuthPanel.business.test.tsx`

**Interfaces:**
- Consumes: `servicesApi.businessRequestOtp`, `servicesApi.businessRegister`, `signInVendor`.
- Produces: `BuyerAuthPanel` accepts `allowBusiness?: boolean`; a signed-in services vendor lands on `/services/:vendorId`.

- [ ] **Step 1: Write the failing test** — render `<BuyerAuthPanel allowBusiness />` on the Sign-up tab; assert a **User | Business** control renders; switch to Business; assert `businessName` + a category `<select>` + email/phone + password fields; mock `businessRequestOtp`→`{channel:'sms'}` and `businessRegister`→`{accessToken,refreshToken,user}`; submit → OTP step → submit code → assert `signInVendor` called with the token.

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run src/components/__tests__/BuyerAuthPanel.business.test.tsx`.

- [ ] **Step 3: Implement.** In `BuyerAuthPanel.tsx`: add `allowBusiness?: boolean` to props; when true and `tab === 'signup'`, render a `mode: 'user' | 'business'` segmented control above the form. In `business` mode, render the business fields and drive a two-step flow reusing the existing `step` state (`'form' → 'verify'`): `form` submit → `businessRequestOtp({ email|phoneNumber })` then move to `verify`; `verify` submit → `businessRegister({ businessName, serviceCategory, email|phoneNumber, password, code, startingPrice?, city? })` → `signInVendor(res.accessToken, res.refreshToken)` → `onAuthenticated`. Keep `user` mode calling the existing buyer path unchanged. Pass `allowBusiness` from `MyTicketsLoginPage`.

- [ ] **Step 4:** Add `operatorType` to `getBrandProfile`'s return (api `GET /api/tickets/social/me` already has the vendor — include `operatorType` in that payload if missing; otherwise read it client-side) and expose `operatorType` on `SessionContext`. In `App.tsx` `HomeRoute`, route a vendor whose `operatorType === 'services'` to `/services/${vendorId}` instead of `/events`.

- [ ] **Step 5: Run it, expect PASS + `npm run build`.**

- [ ] **Step 6: Commit**
```bash
git add landing/src/components/BuyerAuthPanel.tsx landing/src/pages/MyTicketsLoginPage.tsx landing/src/contexts/SessionContext.tsx landing/src/services/socialApi.ts landing/src/App.tsx landing/src/components/__tests__/BuyerAuthPanel.business.test.tsx
git commit -m "feat(services): User|Business signup toggle; services vendor lands on its profile"
```

### Task C5: `ServicesPage` + sidebar/bottom-nav entry

**Files:**
- Create: `landing/src/pages/ServicesPage.tsx`
- Modify: `landing/src/App.tsx` (route `/services`), `landing/src/components/layout/Sidebar.tsx` (items array ~line 71), `landing/src/components/layout/BottomNav.tsx` (tab arrays ~line 52)
- Test: `landing/src/pages/__tests__/ServicesPage.test.tsx`

- [ ] **Step 1: Write the failing test** — mock `servicesApi.listServices` → two cards; render `/services`; assert both names show; type in the search box → assert `listServices` called with `{ search }`; click the "Sound Hire" chip → assert called with `{ category: 'sound_hire' }`.

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement `ServicesPage.tsx`** — header "Event Services / Find trusted suppliers", a search input (debounced), `<CategoryChips>`, an "N providers found" count, and a grid of `<ServiceCard>`. Add `<Route path="/services" element={<ServicesPage />} />` (register BEFORE `/services/:businessId`). Add a **"Services"** item (`Briefcase` from lucide-react) to `Sidebar.tsx` `items` and to `BottomNav.tsx`.

- [ ] **Step 4: Run it, expect PASS + `npm run build`.**

- [ ] **Step 5: Commit**
```bash
git add landing/src/pages/ServicesPage.tsx landing/src/App.tsx landing/src/components/layout/Sidebar.tsx landing/src/components/layout/BottomNav.tsx landing/src/pages/__tests__/ServicesPage.test.tsx
git commit -m "feat(services): Services directory page + nav entry"
```

---

## Task Group D — Enquiries (api + landing)

### Task D1: `Enquiry` model + `EnquiryService`

**Files:**
- Create: `src/models/enquiry.model.ts`, `src/services/enquiry.service.ts`
- Modify: `src/models/notification.model.ts` (add `'enquiry_received'` to `NotificationType` union + enum array)
- Test: `src/services/__tests__/enquiry.service.test.ts`

**Interfaces:**
- Produces: `EnquiryService.create(businessId, buyer, input: { message; eventDate?; eventType?; contactPhone?; contactEmail? })` → `IEnquiry` (validates the business is a services vendor; fires an `enquiry_received` notification to the vendor); `EnquiryService.hasEnquired(buyerId, businessId): Promise<boolean>`; `EnquiryService.listForBusiness(vendorId, opts)`; `EnquiryService.setStatus(vendorId, enquiryId, status)`.

- [ ] **Step 1:** Add `'enquiry_received'` to both the `NotificationType` union (line 3) and the schema enum array (line 27) in `src/models/notification.model.ts`.

- [ ] **Step 2: Write the model** `src/models/enquiry.model.ts`:
```ts
import { Schema, model, Document, Types } from 'mongoose';
export type EnquiryStatus = 'new' | 'read' | 'replied' | 'closed';
export interface IEnquiry extends Document {
  businessId: Types.ObjectId; customerId: Types.ObjectId;
  eventDate?: Date; eventType?: string; message: string;
  contactPhone?: string; contactEmail?: string; status: EnquiryStatus;
  createdAt: Date; updatedAt: Date;
}
const enquirySchema = new Schema<IEnquiry>({
  businessId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
  eventDate: { type: Date }, eventType: { type: String, trim: true, maxlength: 100 },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  contactPhone: { type: String, trim: true }, contactEmail: { type: String, trim: true, lowercase: true },
  status: { type: String, enum: ['new', 'read', 'replied', 'closed'], default: 'new', required: true },
}, { timestamps: true });
enquirySchema.index({ businessId: 1, createdAt: -1 });
enquirySchema.index({ customerId: 1, businessId: 1 });
export const Enquiry = model<IEnquiry>('Enquiry', enquirySchema);
```

- [ ] **Step 3: Write the failing service test** `src/services/__tests__/enquiry.service.test.ts` — create a verified services vendor + a buyer; `EnquiryService.create(...)` → assert an `Enquiry` exists with `status:'new'` and a `Notification` with `type:'enquiry_received'`, `recipientType:'vendor'`, `recipientId=businessId`; `hasEnquired(buyer, business)` → true, and false for a different buyer; `create` against an events vendor → throws 404/400.

- [ ] **Step 4: Run it, expect FAIL.**

- [ ] **Step 5: Implement `src/services/enquiry.service.ts`**:
```ts
import { Enquiry, IEnquiry, EnquiryStatus } from '@models/enquiry.model';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';
import { IBuyer } from '@models/buyer.model';
import { NotificationService } from '@services/notification.service';
import { HttpError } from '@utils/httpError.util';

export class EnquiryService {
  static async create(businessId: string, buyer: IBuyer, input: { message: string; eventDate?: string; eventType?: string; contactPhone?: string; contactEmail?: string }): Promise<IEnquiry> {
    const biz = await Vendor.findOne({ _id: businessId, operatorType: OperatorType.SERVICES, verificationStatus: VerificationStatus.VERIFIED, isActive: true });
    if (!biz) throw new HttpError(404, 'Business not found');
    if (!input.message?.trim()) throw new HttpError(400, 'A message is required');

    const enquiry = await Enquiry.create({
      businessId: biz._id, customerId: buyer._id, message: input.message.trim(),
      eventDate: input.eventDate ? new Date(input.eventDate) : undefined, eventType: input.eventType,
      contactPhone: input.contactPhone ?? (buyer as any).phone, contactEmail: input.contactEmail ?? (buyer as any).email,
    });
    // Best-effort surface is NOT allowed here — an enquiry the business never
    // sees is a lost lead, so a failed notification must throw (no silent swallow).
    await NotificationService.create('vendor', String(biz._id), 'enquiry_received',
      'New enquiry', `${(buyer as any).name ?? 'Someone'} sent you an enquiry`, { buyerId: String(buyer._id), enquiryId: String(enquiry._id) });
    return enquiry;
  }

  static async hasEnquired(buyerId: string, businessId: string): Promise<boolean> {
    return (await Enquiry.exists({ customerId: buyerId, businessId })) != null;
  }

  static async listForBusiness(vendorId: string, opts: { before?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const q: Record<string, unknown> = { businessId: vendorId };
    if (opts.before) q['_id'] = { $lt: opts.before };
    return Enquiry.find(q).sort({ _id: -1 }).limit(limit).populate('customerId', 'name username avatarUrl phone email');
  }

  static async setStatus(vendorId: string, enquiryId: string, status: EnquiryStatus): Promise<IEnquiry> {
    const updated = await Enquiry.findOneAndUpdate({ _id: enquiryId, businessId: vendorId }, { $set: { status } }, { new: true });
    if (!updated) throw new HttpError(404, 'Enquiry not found');
    return updated;
  }
}
```
> Confirm `actorRef` in `notification.service.ts` maps `enquiry_received` → `{ kind: 'buyer', id: data.buyerId }` so the inbox row shows the enquirer's avatar; add that case (mirror `meetup_request`).

- [ ] **Step 6: Run it, expect PASS.**

- [ ] **Step 7: Commit**
```bash
git add src/models/enquiry.model.ts src/services/enquiry.service.ts src/models/notification.model.ts src/services/notification.service.ts src/services/__tests__/enquiry.service.test.ts
git commit -m "feat(enquiries): Enquiry model + service + enquiry_received notification"
```

### Task D2: Enquiry routes (public create + business inbox)

**Files:**
- Create: `src/controllers/enquiry.controller.ts`
- Modify: `src/routes/public.route.ts` (`POST /services/:businessId/enquiries`, `authenticateBuyer`), `src/routes/tickets.route.ts` (`GET /services/enquiries`, `PATCH /services/enquiries/:id/status`, guarded by `MANAGE_ENQUIRIES`)
- Test: `src/routes/__tests__/enquiry.route.test.ts`

**Interfaces:**
- Produces: `POST /api/public/services/:businessId/enquiries` (buyer-auth); `GET /api/tickets/services/enquiries` + `PATCH /api/tickets/services/enquiries/:id/status` (`MANAGE_ENQUIRIES`).

- [ ] **Step 1: Write the failing route test** — buyer token POSTs an enquiry → 201; a services-vendor token GETs `/api/tickets/services/enquiries` → sees it; PATCHes status → 200; a buyer token GET on the inbox → 403 (lacks `MANAGE_ENQUIRIES`). Follow the auth-middleware usage in existing `public.route`/`tickets.route` tests.

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement the controller** (`EnquiryController.create`, `.list`, `.setStatus`) mirroring `ReviewController` — read `req.buyer` (buyer routes) / `req.ticketsUser.vendorId` (vendor routes); validate a small Joi body (`message` required max 1000, optional `eventDate`/`eventType`/contact; `status` ∈ enum). Return via `ApiResponseUtil`.

- [ ] **Step 4: Wire routes.** In `public.route.ts` (buyer-auth, mirror `/events/:eventId/reviews` at line 172):
```ts
router.post('/services/:businessId/enquiries', authenticateBuyer, EnquiryController.create);
```
In `tickets.route.ts` (below the `dualAuth` wall; guard with the permission middleware used elsewhere, e.g. `requireTicketsPermission(TicketsPermission.MANAGE_ENQUIRIES)`):
```ts
router.get('/services/enquiries', requireTicketsPermission(TicketsPermission.MANAGE_ENQUIRIES), EnquiryController.list);
router.patch('/services/enquiries/:id/status', requireTicketsPermission(TicketsPermission.MANAGE_ENQUIRIES), EnquiryController.setStatus);
```
> Use whatever the repo's permission-guard middleware is actually named (grep `MANAGE_ACCESS`/`VIEW_EVENTS` route guards in `tickets.route.ts` and copy that exact wrapper).

- [ ] **Step 5: Run it, expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add src/controllers/enquiry.controller.ts src/routes/public.route.ts src/routes/tickets.route.ts src/routes/__tests__/enquiry.route.test.ts
git commit -m "feat(enquiries): create (buyer) + inbox/status (business) routes"
```

### Task D3: `EnquiryModal` + wire Enquire Now

**Files:**
- Create: `landing/src/components/services/EnquiryModal.tsx`
- Modify: `landing/src/pages/BusinessProfilePage.tsx` (open modal from Enquire Now)
- Test: `landing/src/components/services/__tests__/EnquiryModal.test.tsx`

- [ ] **Step 1: Write the failing test** — anonymous: clicking Enquire Now shows the inline `BuyerAuthPanel` (auth gate). Authenticated buyer: fill message/date/type → submit → `servicesApi.submitEnquiry(id, body)` called → success state shown.

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement `EnquiryModal.tsx`** — a portal'd modal (follow the repo's feed-overlay portal rule — `createPortal` to `document.body`) with fields: message (required), event date, event type, contact (prefilled from session). If not authenticated, render `<BuyerAuthPanel />` first; after auth, show the form. On submit call `servicesApi.submitEnquiry`. Wire the Enquire Now button in `BusinessProfilePage` to open it (removes the C3 stub/TODO).

- [ ] **Step 4: Run it, expect PASS + `npm run build`.**

- [ ] **Step 5: Commit**
```bash
git add landing/src/components/services/EnquiryModal.tsx landing/src/pages/BusinessProfilePage.tsx landing/src/components/services/__tests__/EnquiryModal.test.tsx
git commit -m "feat(enquiries): EnquiryModal wired to Enquire Now"
```

### Task D4: `EnquiriesPage` (business inbox)

**Files:**
- Create: `landing/src/pages/EnquiriesPage.tsx`
- Modify: `landing/src/App.tsx` (route `/services/inbox`, vendor-only), `landing/src/pages/BusinessProfilePage.tsx` (owner-only "Enquiries" link when viewing own profile)
- Test: `landing/src/pages/__tests__/EnquiriesPage.test.tsx`

- [ ] **Step 1: Write the failing test** — mock `getMyEnquiries` → two enquiries; render `/services/inbox`; assert both render with enquirer name + message; click "Mark read" → `updateEnquiryStatus(id,'read')` called.

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement `EnquiriesPage.tsx`** — list rows (enquirer, event date/type, message, status badge) with status controls. Add `<Route path="/services/inbox" element={<EnquiriesPage />} />`. On `BusinessProfilePage`, when the signed-in vendor id === profile id, show an owner-only "Enquiries" button → `/services/inbox`.

- [ ] **Step 4: Run it, expect PASS + `npm run build`.**

- [ ] **Step 5: Commit**
```bash
git add landing/src/pages/EnquiriesPage.tsx landing/src/App.tsx landing/src/pages/BusinessProfilePage.tsx landing/src/pages/__tests__/EnquiriesPage.test.tsx
git commit -m "feat(enquiries): business Enquiries inbox page"
```

---

## Task Group E — Reviews for service businesses (api + landing)

### Task E1: `Review.eventId` optional + partial-unique indexes + migration

**Files:**
- Modify: `src/models/review.model.ts` (eventId optional, index rework)
- Create: `src/scripts/migrate-review-indexes.ts`
- Test: `src/models/__tests__/review.serviceReview.test.ts`

**Interfaces:**
- Produces: a `Review` doc with `eventId` absent (service review); one service review per `{vendorId, buyerId}`.

- [ ] **Step 1: Write the failing test** `src/models/__tests__/review.serviceReview.test.ts` — after `Review.syncIndexes()`: two service reviews (`eventId` absent) from the SAME buyer to DIFFERENT vendors both succeed; a SECOND service review from the same buyer to the SAME vendor throws `11000`; an event review still requires `eventId` uniqueness per `{eventId, buyerId}`.

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Edit `src/models/review.model.ts`** — make `eventId` optional in the interface and schema (`required: false`); replace the indexes:
```ts
reviewSchema.index({ eventId: 1, buyerId: 1 }, { unique: true, partialFilterExpression: { eventId: { $exists: true } } });
reviewSchema.index({ vendorId: 1, buyerId: 1 }, { unique: true, partialFilterExpression: { eventId: { $exists: false } } });
reviewSchema.index({ vendorId: 1, createdAt: -1 });
reviewSchema.index({ eventId: 1, createdAt: -1 });
```
Have the test call `await Review.syncIndexes()` in `beforeAll`.

- [ ] **Step 4: Run it, expect PASS.**

- [ ] **Step 5: Write the prod/dev migration script** `src/scripts/migrate-review-indexes.ts` — connect (reuse the repo's mongoose connect helper), `db.collection('reviews').dropIndex('eventId_1_buyerId_1')` inside a try/catch (ignore "index not found"), then `await Review.syncIndexes()`, log the resulting indexes, exit. Add an npm script `"migrate:review-indexes": "ts-node src/scripts/migrate-review-indexes.ts"`.

- [ ] **Step 6: Commit**
```bash
git add src/models/review.model.ts src/scripts/migrate-review-indexes.ts package.json src/models/__tests__/review.serviceReview.test.ts
git commit -m "feat(reviews): allow event-less service reviews (partial unique indexes + migration)"
```

### Task E2: Enquiry-gated service reviews (service + routes)

**Files:**
- Modify: `src/services/review.service.ts` (`submitServiceReview`, `listBusinessReviews`)
- Modify: `src/controllers/services.controller.ts` (`reviews`, `submitReview`) or `src/controllers/review.controller.ts`
- Modify: `src/routes/public.route.ts` (`GET`/`POST /services/:businessId/reviews`)
- Test: `src/services/__tests__/review.serviceGate.test.ts`

**Interfaces:**
- Consumes: `EnquiryService.hasEnquired`.
- Produces: `ReviewService.submitServiceReview(businessId, buyer, { rating, text? })` (403 unless the buyer has enquired; 409 on a second); `ReviewService.listBusinessReviews(businessId, opts)`.

- [ ] **Step 1: Write the failing test** — a verified services vendor + buyer; `submitServiceReview` WITHOUT a prior enquiry → 403; after `EnquiryService.create`, it succeeds and creates a `Review` with `vendorId` set and `eventId` absent; a second call → 409; `listBusinessReviews` returns it.

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement** in `review.service.ts`:
```ts
static async submitServiceReview(businessId: string, buyer: IBuyer, input: { rating: number; text?: string }): Promise<IReview> {
  assertNotSuspended(buyer);
  const biz = await Vendor.findOne({ _id: businessId, operatorType: OperatorType.SERVICES, verificationStatus: VerificationStatus.VERIFIED, isActive: true }).select('_id');
  if (!biz) throw new HttpError(404, 'Business not found');
  if (!(await EnquiryService.hasEnquired(String(buyer._id), businessId))) {
    throw new HttpError(403, 'Only customers who have enquired can review this business');
  }
  try {
    return await Review.create({ vendorId: biz._id, buyerId: buyer._id, rating: input.rating, text: input.text || undefined, verified: true });
  } catch (err: any) {
    if (err?.code === 11000) throw new HttpError(409, 'You have already reviewed this business');
    throw err;
  }
}

static async listBusinessReviews(businessId: string, opts: { before?: string; limit?: number } = {}): Promise<ReviewView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
  const query: Record<string, unknown> = { vendorId: businessId, eventId: { $exists: false } };
  if (opts.before) query['_id'] = { $lt: opts.before };
  const docs = await Review.find(query).sort({ _id: -1 }).limit(limit).populate('buyerId', 'username name avatarUrl');
  return docs.map((d) => (ReviewService as any).toView(d));
}
```
Add imports for `Vendor`, `OperatorType`, `VerificationStatus`, `EnquiryService`. (`toView` is private — either make it `static` internal-accessible or add a thin public `viewOf`.)

- [ ] **Step 4:** Add `GET /api/public/services/:businessId/reviews` (public) + `POST` (buyer-auth) to `public.route.ts`, delegating to controller methods that call the two service functions.

- [ ] **Step 5: Run it, expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add src/services/review.service.ts src/controllers/services.controller.ts src/routes/public.route.ts src/services/__tests__/review.serviceGate.test.ts
git commit -m "feat(reviews): enquiry-gated service reviews + public list"
```

### Task E3: Reviews tab write path (landing)

**Files:**
- Modify: `landing/src/pages/BusinessProfilePage.tsx` (Reviews tab: list + "Write a review" when eligible)
- Create: `landing/src/components/services/ReviewComposer.tsx` (star + text)
- Test: `landing/src/pages/__tests__/BusinessProfileReviews.test.tsx`

- [ ] **Step 1: Write the failing test** — Reviews tab lists reviews from `getBusinessReviews`; a buyer who has enquired sees "Write a review"; submitting calls `servicesApi.submitReview`; a 403 response surfaces an inline error ("Only customers who have enquired can review").

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement** the Reviews tab to render the list + empty state, and a `ReviewComposer` (reuse an existing star-input if one exists under `src/components/reviews/`). Show it when the viewer is a signed-in buyer; on submit call `servicesApi.submitReview` and surface API errors (no silent fallback).

- [ ] **Step 4: Run it, expect PASS + `npm run build`.**

- [ ] **Step 5: Commit**
```bash
git add landing/src/pages/BusinessProfilePage.tsx landing/src/components/services/ReviewComposer.tsx landing/src/pages/__tests__/BusinessProfileReviews.test.tsx
git commit -m "feat(reviews): Reviews tab + enquiry-gated composer on business profile"
```

---

## Deployment (after all groups pass)

1. **api:** run `npm run migrate:review-indexes` against **dev** then **prod** (drops the old `{eventId,buyerId}` unique, creates the two partial indexes). Then deploy: `gcloud run deploy carrot-tickets-api --source .` (env preserved — see the `carrot-api-deploy-source-mechanism` memory). The realtime service shares the image; re-point it too.
2. **landing:** `cd landing && npm run build` then deploy the CF Pages build (prod branch `main` for the website).
3. **Verify live:** sign up a Business → land on its profile; it is absent from `/services` until an admin verifies it via the existing dashboard Organizers tab; after verify it appears and is filterable; enquire → business inbox receives it + notification; review is blocked until an enquiry exists.

---

## Self-Review Checklist (run before executing)

- **Spec coverage:** account model (A1) · permissions/no-tickets (A2) · OTP signup (A3/A4) · directory verified-only (B1/B2/C5) · profile with category/price/contact (B1/C3) · Enquire form→inbox (D1–D4) · enquiry-gated reviews + index migration (E1–E3) · lands on profile (C4) · dashboard/pos untouched (no tasks there). ✔
- **Placeholder scan:** the only deferred pointers are explicit "read the existing file and match its exact wrapper" notes for repo-specific middleware/return-shapes I could not fully enumerate from the spec; each names the exact file + symbol to copy. No `TODO`/`TBD` logic.
- **Type consistency:** `ServiceCard`/`BusinessProfile` identical across api (B1) and landing (C1); `EnquiryService.hasEnquired` produced in D1, consumed in E2; `registerBusiness` params match `businessRegisterSchema` (A3); `MANAGE_ENQUIRIES` defined A2, used D2.
