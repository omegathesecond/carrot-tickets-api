# Venue Trading — Phase 1 (Venue Account) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bar/restaurant/lounge can sign up through a Venue option on the website, a Carrot super-admin can switch venue trading on (or suspend it) for any vendor, and the vendor's dashboard shows a Venue section reflecting that state.

**Architecture:** A new `Venue` document (one per vendor, unique `vendorId`) is created only by a super-admin route. The vendor reads it through `GET /api/tickets/venue`, which returns `{ venue, eligible }` — one source of truth shared by the dashboard Sidebar and the Venue page. Venue sign-up reuses the existing organizer OTP register with `businessType: 'venue'`; no new auth endpoint. A new `tickets:manage_venue` permission gates the dashboard section.

**Tech Stack:** API — Express + Mongoose + Joi, Jest + supertest + mongodb-memory-server. Website — React + Vite + Vitest + Testing Library. Dashboard — React + Vite + TanStack Query + Radix + Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-venue-trading-design.md` (§ Architecture → `Venue`; § Phase 1). Read it before starting.

## Repos, branches, worktrees

Three repos. NEVER work in the `api/`, `landing/` or `dashboard/` checkouts — `api/` holds someone's uncommitted work.

| Repo | Worktree | Branch | Base | Prod branch |
|---|---|---|---|---|
| API | `carrot-tickets/api-venue-wt` (exists) | `feat/venue-trading` | `origin/main` | `main` |
| Website | `carrot-tickets/landing-venue-wt` | `feat/venue-signup` | `origin/master` | `master` |
| Dashboard | `carrot-tickets/dashboard-venue-wt` | `feat/venue-section` | `origin/main` | `main` |

Create the two missing worktrees before Task 5 / Task 7:

```bash
cd ~/Documents/omevision/contracts/carrot-tickets/landing && git fetch origin master && git worktree add -b feat/venue-signup ../landing-venue-wt origin/master && cd ../landing-venue-wt && npm ci
cd ~/Documents/omevision/contracts/carrot-tickets/dashboard && git fetch origin main && git worktree add -b feat/venue-section ../dashboard-venue-wt origin/main && cd ../dashboard-venue-wt && npm ci
```

The API worktree needs `npm ci` once if `node_modules` is missing.

## Global Constraints

- `Venue.currency` is exactly `'SZL' | 'ZAR'`; `Venue.status` is exactly `'active' | 'suspended'`.
- One venue per vendor: unique index on `Venue.vendorId`; a second switch-on answers **409**.
- Permission string is exactly `tickets:manage_venue`; it lives in `EVENT_PERMISSIONS`, is in the OWNER default set, and in NO other role's default set.
- Fail loudly: no fallback data that mimics success. API errors are 4xx/5xx with a message; dashboard/website show them (toast, error card, inline feedback).
- No backward-compatibility shims.
- Copy, verbatim: Venue card title `Venue`; sign-up description `Bar, restaurant or lounge`; log-in description `Venue account`; menu item `Run a venue` / `Bars, restaurants & lounges`; not-on card `Venue trading isn't on yet` + `Carrot switches it on after a quick check.`; suspended card `Venue trading is suspended` + `Contact Carrot.`
- API tests: run targeted files with `npx jest <path> --runInBand` and READ the pass/fail counts — an exit code alone is not evidence (a V8 crash once exited 0).
- Do not push, merge or deploy. The user decides when.
- POS app (Flutter) is not touched in Phase 1.

## Review Focus

1. **The venue lookup fails (500 / offline).** The Venue nav item must stay visible and the Venue page must show the error with a Try-again button — never fall through to "Venue trading isn't on yet". Pinned in Task 8 (Sidebar + VenuePage error tests).
2. **"Forgot password?" on the Venue (or Business) login.** Must reset the VENDOR account via `/api/tickets/auth/forgot-password` + `/reset-password`, not the buyer endpoints (which answer "no account"). Pinned in Task 5.
3. **A signed-in vendor follows "Run a venue".** Must not be shown a second sign-up form; gets the already-signed-in card. Pinned in Task 6.
4. **Double switch-on (double click, two admins).** Exactly one `Venue` survives; the second request gets 409 and the dashboard toasts the message. Pinned in Task 3 (API) and Task 9 (toast).
5. **The platform super-admin account / a non-ObjectId `vendorId` (`admin-vendor-id` in tests).** `GET /venue` returns `{ venue: null, eligible: false }` (never a 500 CastError), and a super-admin vendor can never be switched on. Pinned in Tasks 2 and 4.

---

## Task 1: `tickets:manage_venue` permission + venue sign-up contract (API)

**Files:**
- Modify: `api-venue-wt/src/interfaces/ticketsPermission.interface.ts` (enum after `ISSUE_TAGS`; `EVENT_PERMISSIONS` list end)
- Create: `api-venue-wt/src/interfaces/__tests__/ticketsPermission.venue.test.ts`
- Modify: `api-venue-wt/src/services/__tests__/ticketsAuth.register.test.ts` (append a describe block)

**Interfaces:**
- Produces: `TicketsPermission.MANAGE_VENUE = 'tickets:manage_venue'`.

- [ ] **Step 1: Write the failing permission test**

`src/interfaces/__tests__/ticketsPermission.venue.test.ts`:

```ts
import {
  TicketsPermission,
  TicketsRole,
  TICKETS_ROLE_PERMISSIONS,
  EVENT_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
  SERVICES_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';
import { scopePermissionsToType } from '@utils/permissions.util';
import { OperatorType } from '@interfaces/vendor.interface';

describe('MANAGE_VENUE permission', () => {
  it('is defined in the tickets namespace', () => {
    expect(TicketsPermission.MANAGE_VENUE).toBe('tickets:manage_venue');
  });

  it('is an events-vertical permission', () => {
    expect(EVENT_PERMISSIONS).toContain(TicketsPermission.MANAGE_VENUE);
    expect(TRANSPORT_PERMISSIONS).not.toContain(TicketsPermission.MANAGE_VENUE);
    expect(SERVICES_PERMISSIONS).not.toContain(TicketsPermission.MANAGE_VENUE);
  });

  it('is in the OWNER default set only', () => {
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.MANAGE_VENUE);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]).not.toContain(TicketsPermission.MANAGE_VENUE);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SALES]).not.toContain(TicketsPermission.MANAGE_VENUE);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SCANNER]).not.toContain(TicketsPermission.MANAGE_VENUE);
  });

  it('survives scoping for a self-signup owner (operatorType events)', () => {
    const owner = scopePermissionsToType(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER], OperatorType.EVENTS);
    expect(owner).toContain(TicketsPermission.MANAGE_VENUE);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd ~/Documents/omevision/contracts/carrot-tickets/api-venue-wt && npx jest src/interfaces/__tests__/ticketsPermission.venue.test.ts --runInBand`
Expected: FAIL — `expect(received).toBe(expected)` with `undefined` for `MANAGE_VENUE`.

- [ ] **Step 3: Add the permission**

In `src/interfaces/ticketsPermission.interface.ts`, add to the enum directly after `ISSUE_TAGS = 'tickets:issue_tags',`:

```ts
  // Venue trading (venue trading spec) — the vendor's OWN day-to-day venue:
  // its stalls, staff and settings. Events-vertical (a bus operator runs no
  // bar), so it lives in EVENT_PERMISSIONS below. OWNER holds it by default;
  // a sub-user gets it only by explicit grant.
  MANAGE_VENUE = 'tickets:manage_venue',
```

and append to `EVENT_PERMISSIONS` after `TicketsPermission.ISSUE_TAGS,`:

```ts
  TicketsPermission.MANAGE_VENUE,
```

Do NOT add it to `MANAGER`.

- [ ] **Step 4: Run it and the partition test — expect PASS**

Run: `npx jest src/interfaces/__tests__/ticketsPermission.venue.test.ts src/utils/__tests__/permissions.util.test.ts --runInBand`
Expected: PASS, both suites (the partition test stays green because the new permission is in exactly one group).

- [ ] **Step 5: Pin the venue sign-up contract**

Append to `src/services/__tests__/ticketsAuth.register.test.ts` (reuses that file's `lastEmailCode` helper and mocks):

```ts
describe('TicketsAuthService venue signup', () => {
  it('the organizer register creates a venue-type Vendor (events operator) — the path the website Venue form uses', async () => {
    await TicketsAuthService.requestRegistrationOtp({ email: 'bar@x.com' });
    await TicketsAuthService.register({
      businessName: 'Kwa-Linda Lounge',
      email: 'bar@x.com',
      password: 'newpass1',
      businessType: 'venue',
      code: lastEmailCode(),
    });
    const v = await Vendor.findOne({ email: 'bar@x.com' }).lean();
    expect(v?.businessType).toBe('venue');
    expect(v?.operatorType).toBe('events');
  });
});
```

- [ ] **Step 6: Run it — expect PASS (pins existing behaviour)**

Run: `npx jest src/services/__tests__/ticketsAuth.register.test.ts --runInBand`
Expected: PASS, all tests in the file. If it fails, STOP — the website Venue form (Task 5) depends on this path.

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/ticketsPermission.interface.ts src/interfaces/__tests__/ticketsPermission.venue.test.ts src/services/__tests__/ticketsAuth.register.test.ts
git commit -m "feat(venue): tickets:manage_venue permission + pin venue signup via organizer register"
```

---

## Task 2: `Venue` model + `VenueService` (API)

**Files:**
- Create: `api-venue-wt/src/interfaces/venue.interface.ts`
- Create: `api-venue-wt/src/models/venue.model.ts`
- Create: `api-venue-wt/src/services/venue.service.ts`
- Test: `api-venue-wt/src/services/__tests__/venue.service.test.ts`

**Interfaces:**
- Produces:
  - `type VenueStatus = 'active' | 'suspended'`, `type VenueCurrency = 'SZL' | 'ZAR'`
  - `interface VenueSummary { id: string; name: string; currency: VenueCurrency; status: VenueStatus; activatedAt: Date }`
  - `Venue` model
  - `toVenueSummary(v): VenueSummary`
  - `VenueService.activate({ vendorId, name, currency, activatedBy }): Promise<IVenue>`
  - `VenueService.setStatus(venueId, status): Promise<IVenue>`
  - `VenueService.forVendor(vendorId): Promise<{ venue: VenueSummary | null; eligible: boolean }>`
  - `VenueService.summariesFor(vendorIds: Types.ObjectId[]): Promise<Map<string, VenueSummary>>`
  - Errors: `VenueAlreadyExistsError`, `VenueVendorNotFoundError`, `VenueNotFoundError`

- [ ] **Step 1: Write the failing service tests**

`src/services/__tests__/venue.service.test.ts`:

```ts
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import {
  VenueService,
  VenueAlreadyExistsError,
  VenueVendorNotFoundError,
  VenueNotFoundError,
} from '@services/venue.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

let seq = 0;
async function makeVendor(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return Vendor.create({
    businessName: `Venue Biz ${seq}`,
    email: `venue${seq}@x.co`,
    password: 'secret1',
    businessType: 'venue',
    ...overrides,
  });
}

describe('VenueService.activate', () => {
  it('creates an active venue stamped with who switched it on', async () => {
    const v = await makeVendor();
    const venue = await VenueService.activate({ vendorId: String(v._id), name: 'Kwa-Linda Lounge', currency: 'SZL', activatedBy: 'admin-1' });
    expect(venue.status).toBe('active');
    expect(venue.currency).toBe('SZL');
    expect(venue.activatedBy).toBe('admin-1');
    expect(venue.activatedAt).toBeInstanceOf(Date);
  });

  it('refuses a second venue for the same vendor, leaving exactly one', async () => {
    const v = await makeVendor();
    await VenueService.activate({ vendorId: String(v._id), name: 'A', currency: 'SZL', activatedBy: 'admin-1' });
    await expect(
      VenueService.activate({ vendorId: String(v._id), name: 'B', currency: 'ZAR', activatedBy: 'admin-1' }),
    ).rejects.toBeInstanceOf(VenueAlreadyExistsError);
    expect(await Venue.countDocuments({ vendorId: v._id })).toBe(1);
  });

  it('refuses an unknown vendor, a malformed id, and the platform super-admin account', async () => {
    const admin = await makeVendor({ isSuperAdmin: true });
    for (const vendorId of [new mongoose.Types.ObjectId().toHexString(), 'not-an-id', String(admin._id)]) {
      await expect(
        VenueService.activate({ vendorId, name: 'X', currency: 'SZL', activatedBy: 'admin-1' }),
      ).rejects.toBeInstanceOf(VenueVendorNotFoundError);
    }
    expect(await Venue.countDocuments({})).toBe(0);
  });
});

describe('VenueService.setStatus', () => {
  it('suspends and reactivates', async () => {
    const v = await makeVendor();
    const venue = await VenueService.activate({ vendorId: String(v._id), name: 'A', currency: 'SZL', activatedBy: 'admin-1' });
    expect((await VenueService.setStatus(String(venue._id), 'suspended')).status).toBe('suspended');
    expect((await VenueService.setStatus(String(venue._id), 'active')).status).toBe('active');
  });

  it('refuses an unknown or malformed venue id', async () => {
    await expect(VenueService.setStatus(new mongoose.Types.ObjectId().toHexString(), 'suspended')).rejects.toBeInstanceOf(VenueNotFoundError);
    await expect(VenueService.setStatus('nope', 'suspended')).rejects.toBeInstanceOf(VenueNotFoundError);
  });
});

describe('VenueService.forVendor', () => {
  it('a venue-type vendor with no venue yet is eligible with venue null', async () => {
    const v = await makeVendor();
    expect(await VenueService.forVendor(String(v._id))).toEqual({ venue: null, eligible: true });
  });

  it('an event organizer with no venue is not eligible', async () => {
    const v = await makeVendor({ businessType: 'event_organizer' });
    expect(await VenueService.forVendor(String(v._id))).toEqual({ venue: null, eligible: false });
  });

  it('any vendor with a venue is eligible and gets the summary', async () => {
    const v = await makeVendor({ businessType: 'event_organizer' });
    const venue = await VenueService.activate({ vendorId: String(v._id), name: 'Rooftop', currency: 'ZAR', activatedBy: 'admin-1' });
    const out = await VenueService.forVendor(String(v._id));
    expect(out.eligible).toBe(true);
    expect(out.venue).toEqual({ id: String(venue._id), name: 'Rooftop', currency: 'ZAR', status: 'active', activatedAt: venue.activatedAt });
  });

  it('a non-ObjectId vendor id is simply not a venue — never a CastError', async () => {
    expect(await VenueService.forVendor('admin-vendor-id')).toEqual({ venue: null, eligible: false });
  });
});

describe('VenueService.summariesFor', () => {
  it('maps vendorId -> summary for vendors that have a venue only', async () => {
    const a = await makeVendor();
    const b = await makeVendor();
    await VenueService.activate({ vendorId: String(a._id), name: 'A', currency: 'SZL', activatedBy: 'admin-1' });
    const map = await VenueService.summariesFor([a._id as mongoose.Types.ObjectId, b._id as mongoose.Types.ObjectId]);
    expect(map.get(String(a._id))?.name).toBe('A');
    expect(map.has(String(b._id))).toBe(false);
  });

  it('returns an empty map for no ids without querying', async () => {
    expect((await VenueService.summariesFor([])).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/services/__tests__/venue.service.test.ts --runInBand`
Expected: FAIL — `Cannot find module '@models/venue.model'`.

- [ ] **Step 3: Write the interface**

`src/interfaces/venue.interface.ts`:

```ts
import { Document, Types } from 'mongoose';

export type VenueStatus = 'active' | 'suspended';
export type VenueCurrency = 'SZL' | 'ZAR';

/**
 * A vendor's day-to-day trading premises (venue trading spec). Created ONLY by
 * a super-admin switching venue trading on — there is no self-serve path,
 * because Carrot bills venues off-platform and the switch is the commercial
 * gate. One per vendor in v1 (unique vendorId); a second location later is a
 * second Venue, not a schema change.
 *
 * Deliberately NOT fields on Vendor: the Vendor is the social actor (posts,
 * follows, DMs); trading settings belong to the premises.
 */
export interface IVenue extends Document {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  name: string;
  currency: VenueCurrency;
  status: VenueStatus;
  activatedAt: Date;
  /** The super-admin's vendorId from their token, kept as a string. */
  activatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What the dashboard (own venue) and the admin Organizers list are told. */
export interface VenueSummary {
  id: string;
  name: string;
  currency: VenueCurrency;
  status: VenueStatus;
  activatedAt: Date;
}
```

- [ ] **Step 4: Write the model**

`src/models/venue.model.ts`:

```ts
import mongoose, { Schema } from 'mongoose';
import { IVenue } from '@interfaces/venue.interface';

const venueSchema = new Schema<IVenue>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  currency: { type: String, enum: ['SZL', 'ZAR'], required: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true, index: true },
  activatedAt: { type: Date, required: true, default: Date.now },
  activatedBy: { type: String, required: true, trim: true },
}, { timestamps: true });

// One location per venue account (v1). UNIQUE rather than a find-then-insert
// check: two admins (or one double click) switching on at the same moment
// race past any pre-check, and only the index makes the loser an E11000 that
// VenueService turns into a 409 instead of a second Venue.
venueSchema.index({ vendorId: 1 }, { unique: true });

export const Venue = mongoose.model<IVenue>('Venue', venueSchema);
```

- [ ] **Step 5: Write the service**

`src/services/venue.service.ts`:

```ts
import mongoose from 'mongoose';
import { Venue } from '@models/venue.model';
import { Vendor } from '@models/vendor.model';
import { IVenue, VenueCurrency, VenueStatus, VenueSummary } from '@interfaces/venue.interface';

/** A second switch-on for a vendor that already has a venue. Mapped to 409. */
export class VenueAlreadyExistsError extends Error {
  constructor() {
    super('This vendor already has a venue');
    this.name = 'VenueAlreadyExistsError';
  }
}

/** No such vendor — or the platform super-admin account, which is never a venue. Mapped to 404. */
export class VenueVendorNotFoundError extends Error {
  constructor() {
    super('Vendor not found');
    this.name = 'VenueVendorNotFoundError';
  }
}

/** No such venue. Mapped to 404. */
export class VenueNotFoundError extends Error {
  constructor() {
    super('Venue not found');
    this.name = 'VenueNotFoundError';
  }
}

export function toVenueSummary(
  v: Pick<IVenue, '_id' | 'name' | 'currency' | 'status' | 'activatedAt'>,
): VenueSummary {
  return { id: String(v._id), name: v.name, currency: v.currency, status: v.status, activatedAt: v.activatedAt };
}

export class VenueService {
  static async activate(params: {
    vendorId: string;
    name: string;
    currency: VenueCurrency;
    activatedBy: string;
  }): Promise<IVenue> {
    if (!mongoose.isValidObjectId(params.vendorId)) throw new VenueVendorNotFoundError();
    const vendor = await Vendor.findOne({ _id: params.vendorId, isSuperAdmin: { $ne: true } }).select('_id').lean();
    if (!vendor) throw new VenueVendorNotFoundError();
    try {
      return await Venue.create({
        vendorId: vendor._id,
        name: params.name,
        currency: params.currency,
        status: 'active',
        activatedAt: new Date(),
        activatedBy: params.activatedBy,
      });
    } catch (e) {
      // The unique vendorId index is the ONLY guard against a concurrent
      // second switch-on — see venue.model.ts.
      if ((e as { code?: number })?.code === 11000) throw new VenueAlreadyExistsError();
      throw e;
    }
  }

  static async setStatus(venueId: string, status: VenueStatus): Promise<IVenue> {
    if (!mongoose.isValidObjectId(venueId)) throw new VenueNotFoundError();
    const venue = await Venue.findByIdAndUpdate(venueId, { $set: { status } }, { new: true });
    if (!venue) throw new VenueNotFoundError();
    return venue;
  }

  /**
   * The signed-in vendor's venue, and whether the dashboard's Venue section
   * applies at all: a venue-type account (waiting to be switched on), or ANY
   * account that has a venue (an admin may switch one on for an organizer).
   *
   * A vendorId that is not an ObjectId cannot own a venue — answered as "no
   * venue", which is the truth, rather than letting the cast throw a 500.
   */
  static async forVendor(vendorId: string): Promise<{ venue: VenueSummary | null; eligible: boolean }> {
    if (!mongoose.isValidObjectId(vendorId)) return { venue: null, eligible: false };
    const [venue, vendor] = await Promise.all([
      Venue.findOne({ vendorId }).lean<IVenue | null>(),
      Vendor.findById(vendorId).select('businessType').lean<{ businessType?: string } | null>(),
    ]);
    return {
      venue: venue ? toVenueSummary(venue) : null,
      eligible: !!venue || vendor?.businessType === 'venue',
    };
  }

  /** Venue summaries for a page of vendors, keyed by vendorId string. */
  static async summariesFor(vendorIds: mongoose.Types.ObjectId[]): Promise<Map<string, VenueSummary>> {
    if (!vendorIds.length) return new Map();
    const venues = await Venue.find({ vendorId: { $in: vendorIds } }).lean<IVenue[]>();
    return new Map(venues.map((v) => [String(v.vendorId), toVenueSummary(v)]));
  }
}
```

- [ ] **Step 6: Run the tests — expect PASS**

Run: `npx jest src/services/__tests__/venue.service.test.ts --runInBand`
Expected: PASS — 11 tests.

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/venue.interface.ts src/models/venue.model.ts src/services/venue.service.ts src/services/__tests__/venue.service.test.ts
git commit -m "feat(venue): Venue model (one per vendor) + VenueService activate/setStatus/forVendor"
```

---

## Task 3: Super-admin venue switch routes (API)

**Files:**
- Create: `api-venue-wt/src/controllers/adminVenues.controller.ts`
- Modify: `api-venue-wt/src/routes/tickets.route.ts` (imports at top; two routes directly after the `/admin/organizers/:id/verification` line, ~line 101)
- Test: `api-venue-wt/src/routes/__tests__/adminVenues.route.test.ts`

**Interfaces:**
- Consumes: `VenueService.activate`, `VenueService.setStatus`, `toVenueSummary`, the three error classes (Task 2).
- Produces:
  - `POST /api/tickets/admin/venues` `{ vendorId, name, currency }` → `201 { data: VenueSummary }` | 400 | 403 | 404 | 409
  - `PATCH /api/tickets/admin/venues/:id` `{ status }` → `200 { data: VenueSummary }` | 400 | 403 | 404

- [ ] **Step 1: Write the failing route tests**

`src/routes/__tests__/adminVenues.route.test.ts`:

```ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const admin = () => `Bearer ${signSuperAdminToken()}`;
let seq = 0;
async function makeVendor() {
  seq += 1;
  return Vendor.create({ businessName: `Lounge ${seq}`, email: `lounge${seq}@x.co`, password: 'secret1', businessType: 'venue' });
}

describe('POST /api/tickets/admin/venues', () => {
  it('switches venue trading on: 201 with the summary, stamped with the admin', async () => {
    const v = await makeVendor();
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', admin())
      .send({ vendorId: String(v._id), name: 'Kwa-Linda Lounge', currency: 'SZL' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Kwa-Linda Lounge', currency: 'SZL', status: 'active' });
    expect(res.body.data.id).toMatch(/^[0-9a-f]{24}$/);
    const stored = await Venue.findOne({ vendorId: v._id }).lean();
    expect(stored?.activatedBy).toBe('admin-vendor-id');
  });

  it('409s a second switch-on and keeps exactly one venue', async () => {
    const v = await makeVendor();
    const body = { vendorId: String(v._id), name: 'A', currency: 'SZL' };
    expect((await request(app).post('/api/tickets/admin/venues').set('Authorization', admin()).send(body)).status).toBe(201);
    const second = await request(app).post('/api/tickets/admin/venues').set('Authorization', admin()).send(body);
    expect(second.status).toBe(409);
    expect(second.body.message).toBe('This vendor already has a venue');
    expect(await Venue.countDocuments({ vendorId: v._id })).toBe(1);
  });

  it('404s an unknown vendor', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', admin())
      .send({ vendorId: new mongoose.Types.ObjectId().toHexString(), name: 'A', currency: 'SZL' });
    expect(res.status).toBe(404);
  });

  it('400s a currency outside SZL/ZAR and a blank name', async () => {
    const v = await makeVendor();
    for (const body of [
      { vendorId: String(v._id), name: 'A', currency: 'USD' },
      { vendorId: String(v._id), name: '  ', currency: 'SZL' },
    ]) {
      const res = await request(app).post('/api/tickets/admin/venues').set('Authorization', admin()).send(body);
      expect(res.status).toBe(400);
    }
    expect(await Venue.countDocuments({})).toBe(0);
  });

  it('403s a non-super-admin', async () => {
    const v = await makeVendor();
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', `Bearer ${signVendorToken(String(v._id))}`)
      .send({ vendorId: String(v._id), name: 'A', currency: 'SZL' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/tickets/admin/venues/:id', () => {
  async function activeVenue() {
    const v = await makeVendor();
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', admin())
      .send({ vendorId: String(v._id), name: 'A', currency: 'ZAR' });
    return res.body.data.id as string;
  }

  it('suspends and reactivates', async () => {
    const id = await activeVenue();
    const off = await request(app).patch(`/api/tickets/admin/venues/${id}`).set('Authorization', admin()).send({ status: 'suspended' });
    expect(off.status).toBe(200);
    expect(off.body.data.status).toBe('suspended');
    const on = await request(app).patch(`/api/tickets/admin/venues/${id}`).set('Authorization', admin()).send({ status: 'active' });
    expect(on.body.data.status).toBe('active');
  });

  it('404s an unknown venue and 400s an unknown status', async () => {
    const missing = await request(app)
      .patch(`/api/tickets/admin/venues/${new mongoose.Types.ObjectId().toHexString()}`)
      .set('Authorization', admin())
      .send({ status: 'suspended' });
    expect(missing.status).toBe(404);
    const id = await activeVenue();
    const bad = await request(app).patch(`/api/tickets/admin/venues/${id}`).set('Authorization', admin()).send({ status: 'closed' });
    expect(bad.status).toBe(400);
  });

  it('403s a non-super-admin', async () => {
    const id = await activeVenue();
    const res = await request(app)
      .patch(`/api/tickets/admin/venues/${id}`)
      .set('Authorization', `Bearer ${signVendorToken(new mongoose.Types.ObjectId().toHexString())}`)
      .send({ status: 'suspended' });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx jest src/routes/__tests__/adminVenues.route.test.ts --runInBand`
Expected: FAIL — 404s where 201/200 expected (routes not mounted).

- [ ] **Step 3: Write the controller**

`src/controllers/adminVenues.controller.ts`:

```ts
import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import {
  VenueService,
  VenueAlreadyExistsError,
  VenueVendorNotFoundError,
  VenueNotFoundError,
  toVenueSummary,
} from '@services/venue.service';

const activateSchema = Joi.object({
  vendorId: Joi.string().hex().length(24).required(),
  name: Joi.string().trim().min(1).max(120).required(),
  currency: Joi.string().valid('SZL', 'ZAR').required(),
});

const statusSchema = Joi.object({
  status: Joi.string().valid('active', 'suspended').required(),
});

/**
 * Venue trading switch (venue trading spec, Phase 1). Super-admin only (gated
 * in the route). Switching on is the commercial gate — Carrot bills venues
 * off-platform — so there is no vendor-side path to create a Venue.
 */
export class AdminVenuesController {
  /** POST /api/tickets/admin/venues { vendorId, name, currency } */
  static async activate(req: Request, res: Response): Promise<any> {
    const { error, value } = activateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const venue = await VenueService.activate({
        ...value,
        activatedBy: String((req as any).ticketsUser.vendorId),
      });
      return ApiResponseUtil.success(res, toVenueSummary(venue), 'Venue trading switched on', 201);
    } catch (e: any) {
      if (e instanceof VenueAlreadyExistsError) return ApiResponseUtil.error(res, e.message, 409);
      if (e instanceof VenueVendorNotFoundError) return ApiResponseUtil.notFound(res, e.message);
      console.error('Activate venue error:', e);
      return ApiResponseUtil.error(res, e.message || 'Failed to switch venue trading on', 500);
    }
  }

  /** PATCH /api/tickets/admin/venues/:id { status: 'active' | 'suspended' } */
  static async updateStatus(req: Request, res: Response): Promise<any> {
    const { error, value } = statusSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const venue = await VenueService.setStatus(String(req.params['id']), value.status);
      return ApiResponseUtil.success(res, toVenueSummary(venue));
    } catch (e: any) {
      if (e instanceof VenueNotFoundError) return ApiResponseUtil.notFound(res, e.message);
      console.error('Update venue status error:', e);
      return ApiResponseUtil.error(res, e.message || 'Failed to update venue', 500);
    }
  }
}
```

- [ ] **Step 4: Mount the routes**

In `src/routes/tickets.route.ts`, add with the other controller imports:

```ts
import { AdminVenuesController } from '@controllers/adminVenues.controller';
```

and directly after `router.patch('/admin/organizers/:id/verification', ...)`:

```ts
/**
 * Venue trading switch — super-admin creates a vendor's Venue (one per
 * vendor; a second is a 409) and suspends / reactivates it.
 */
router.post('/admin/venues', requireSuperAdmin, AdminVenuesController.activate);
router.patch('/admin/venues/:id', requireSuperAdmin, AdminVenuesController.updateStatus);
```

- [ ] **Step 5: Run the tests — expect PASS**

Run: `npx jest src/routes/__tests__/adminVenues.route.test.ts --runInBand`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/adminVenues.controller.ts src/routes/tickets.route.ts src/routes/__tests__/adminVenues.route.test.ts
git commit -m "feat(venue): super-admin switch-on / suspend routes for venue trading"
```

---

## Task 4: `GET /api/tickets/venue` + venue on the admin Organizers list (API)

**Files:**
- Create: `api-venue-wt/src/controllers/venue.controller.ts`
- Modify: `api-venue-wt/src/routes/tickets.route.ts` (import; route directly after `router.get('/auth/me', TicketsController.getMe);`)
- Modify: `api-venue-wt/src/controllers/adminOrganizers.controller.ts` (`listOrganizers`)
- Test: `api-venue-wt/src/routes/__tests__/venueMine.route.test.ts`
- Test: `api-venue-wt/src/routes/__tests__/adminListOrganizers.venue.route.test.ts`

**Interfaces:**
- Consumes: `VenueService.forVendor`, `VenueService.summariesFor`, `Venue` (Task 2), `POST /admin/venues` (Task 3, used in tests via the model directly).
- Produces:
  - `GET /api/tickets/venue` → `200 { data: { venue: VenueSummary | null, eligible: boolean } }` | 401. Authenticated vendor OR sub-user (resolved by the token's `vendorId`); deliberately NOT gated on `MANAGE_VENUE` — it is a read of the account's own summary, and gating it would 403 every owner whose token was minted before this deploy. The dashboard gates the UI on the permission.
  - Each row of `GET /api/tickets/admin/organizers` gains `venue: VenueSummary | null`.

- [ ] **Step 1: Write the failing tests**

`src/routes/__tests__/venueMine.route.test.ts`:

```ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

let seq = 0;
async function makeVendor(businessType: string) {
  seq += 1;
  return Vendor.create({ businessName: `Biz ${seq}`, email: `biz${seq}@x.co`, password: 'secret1', businessType });
}

describe('GET /api/tickets/venue', () => {
  it('a venue-type vendor not yet switched on: eligible, venue null', async () => {
    const v = await makeVendor('venue');
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${signVendorToken(String(v._id))}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ venue: null, eligible: true });
  });

  it('a suspended venue comes back suspended', async () => {
    const v = await makeVendor('venue');
    await Venue.create({ vendorId: v._id, name: 'Lounge', currency: 'SZL', status: 'suspended', activatedBy: 'admin' });
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${signVendorToken(String(v._id))}`);
    expect(res.body.data.eligible).toBe(true);
    expect(res.body.data.venue).toMatchObject({ name: 'Lounge', currency: 'SZL', status: 'suspended' });
  });

  it('an event organizer with no venue is not eligible', async () => {
    const v = await makeVendor('event_organizer');
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${signVendorToken(String(v._id))}`);
    expect(res.body.data).toEqual({ venue: null, eligible: false });
  });

  it("a sub-user sees their vendor's venue", async () => {
    const v = await makeVendor('venue');
    await Venue.create({ vendorId: v._id, name: 'Lounge', currency: 'ZAR', activatedBy: 'admin' });
    const token = signVendorToken(String(v._id), {
      userType: 'sub-user', userId: '65f000000000000000000001', role: 'tickets_manager', permissions: ['tickets:view_events'],
    });
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.venue).toMatchObject({ name: 'Lounge', status: 'active' });
  });

  it('the platform super-admin (non-ObjectId vendorId in tests) is simply not a venue — 200, not a 500', async () => {
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${signSuperAdminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ venue: null, eligible: false });
  });

  it('401s without a token', async () => {
    const res = await request(app).get('/api/tickets/venue');
    expect(res.status).toBe(401);
  });
});
```

`src/routes/__tests__/adminListOrganizers.venue.route.test.ts`:

```ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('GET /api/tickets/admin/organizers — venue', () => {
  it('each organizer row carries its venue summary, or null', async () => {
    const withVenue = await Vendor.create({ businessName: 'Rooftop', email: 'roof@x.co', password: 'secret1', businessType: 'venue' });
    const without = await Vendor.create({ businessName: 'Gigs Co', email: 'gigs@x.co', password: 'secret1' });
    await Venue.create({ vendorId: withVenue._id, name: 'Rooftop', currency: 'ZAR', activatedBy: 'admin' });

    const res = await request(app).get('/api/tickets/admin/organizers').set('Authorization', `Bearer ${signSuperAdminToken()}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.organizers as Array<{ id: string; venue: unknown }>;
    expect(rows.find((r) => r.id === String(withVenue._id))?.venue).toMatchObject({ name: 'Rooftop', currency: 'ZAR', status: 'active' });
    expect(rows.find((r) => r.id === String(without._id))?.venue).toBeNull();
  });
});
```

- [ ] **Step 2: Run them — expect FAIL**

Run: `npx jest src/routes/__tests__/venueMine.route.test.ts src/routes/__tests__/adminListOrganizers.venue.route.test.ts --runInBand`
Expected: FAIL — `/venue` 404s; organizer rows have no `venue` key (`undefined`, not `null`).

- [ ] **Step 3: Write the vendor-facing controller**

`src/controllers/venue.controller.ts`:

```ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { VenueService } from '@services/venue.service';

/** The signed-in vendor's own venue (venue trading spec, Phase 1). */
export class VenueController {
  /**
   * GET /api/tickets/venue → { venue: VenueSummary | null, eligible }
   * Resolved by the token's vendorId, so a sub-user sees their vendor's venue.
   */
  static async mine(req: Request, res: Response): Promise<any> {
    const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
    if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor session required');
    try {
      return ApiResponseUtil.success(res, await VenueService.forVendor(String(vendorId)));
    } catch (e: any) {
      console.error('Get my venue error:', e);
      return ApiResponseUtil.error(res, e.message || 'Failed to load venue', 500);
    }
  }
}
```

- [ ] **Step 4: Mount it**

In `src/routes/tickets.route.ts` add the import:

```ts
import { VenueController } from '@controllers/venue.controller';
```

and directly after `router.get('/auth/me', TicketsController.getMe);`:

```ts
// The signed-in vendor's own venue (or null) and whether the dashboard Venue
// section applies. Auth only — see VenueController.mine.
router.get('/venue', VenueController.mine);
```

- [ ] **Step 5: Add venue to the organizers list**

In `src/controllers/adminOrganizers.controller.ts` add the import:

```ts
import { VenueService } from '@services/venue.service';
```

After the `const salesByVendor = ...` line add:

```ts
      const venuesByVendor = await VenueService.summariesFor(vendorIds);
```

and in the row object, after `revenue: s?.revenue ?? 0,`:

```ts
          venue: venuesByVendor.get(id) ?? null,
```

- [ ] **Step 6: Run the tests — expect PASS**

Run: `npx jest src/routes/__tests__/venueMine.route.test.ts src/routes/__tests__/adminListOrganizers.venue.route.test.ts src/routes/__tests__/adminListOrganizers.route.test.ts --runInBand`
Expected: PASS — all three suites (the existing list suite stays green).

If the 401 test fails because `dualAuth` answers differently for a missing token, read `src/middleware/serviceAuth.middleware.ts` and assert the status it actually returns for an unauthenticated request — do not weaken the controller.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

```bash
git add src/controllers/venue.controller.ts src/routes/tickets.route.ts src/controllers/adminOrganizers.controller.ts src/routes/__tests__/venueMine.route.test.ts src/routes/__tests__/adminListOrganizers.venue.route.test.ts
git commit -m "feat(venue): GET /venue for the signed-in vendor + venue on the admin organizers list"
```

---

## Task 5: Venue mode in the website auth panel

**Files (in `landing-venue-wt`):**
- Modify: `src/services/servicesApi.ts` (three calls after `businessLogin`)
- Modify: `src/components/BuyerAuthPanel.tsx`
- Modify: `src/components/__tests__/BuyerAuthPanel.business.test.tsx` (two `toHaveBeenCalledWith` objects gain `accountType: 'business'`)
- Create: `src/components/__tests__/BuyerAuthPanel.venue.test.tsx`

**Interfaces:**
- Consumes: `POST /api/tickets/auth/register/request-otp` (via existing `servicesApi.businessRequestOtp`), `POST /api/tickets/auth/register`, `POST /api/tickets/auth/login` (via existing `servicesApi.businessLogin`), `POST /api/tickets/auth/forgot-password`, `POST /api/tickets/auth/reset-password` — all exist on the API today.
- Produces:
  - `servicesApi.venueRegister(body: { businessName: string; email?: string; phoneNumber?: string; password: string; code: string }): Promise<{ accessToken; refreshToken; user }>`
  - `servicesApi.vendorRequestPasswordReset(identifier: string): Promise<{ channel: 'sms' | 'email'; identifier: string }>`
  - `servicesApi.vendorResetPassword(identifier: string, code: string, newPassword: string): Promise<{ accessToken; refreshToken; user }>`
  - `BuyerAuthPanel` `Mode = 'user' | 'business' | 'venue'`; `onBusinessAuthenticated` result gains `accountType: 'business' | 'venue'`.

- [ ] **Step 1: Write the failing panel tests**

`src/components/__tests__/BuyerAuthPanel.venue.test.tsx`:

```tsx
import { vi, describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BuyerAuthPanel } from '@/components/BuyerAuthPanel';
import { servicesApi } from '@/services/servicesApi';
import { api } from '@/services/api';

afterEach(() => vi.restoreAllMocks());

const session = { accessToken: 'vendor.jwt', refreshToken: 'vendor.refresh', user: { _id: 'venue123', businessName: 'Kwa-Linda Lounge' } };

describe('BuyerAuthPanel — venue mode', () => {
  it('offers a Venue option beside User and Business', () => {
    render(<BuyerAuthPanel onAuthenticated={vi.fn()} defaultTab="signup" allowBusiness />);
    expect(screen.getByRole('button', { name: /^venue$/i })).toBeInTheDocument();
    expect(screen.getByText('Bar, restaurant or lounge')).toBeInTheDocument();
  });

  it('the Venue form asks for business name, email/phone and password — no service category', async () => {
    render(<BuyerAuthPanel onAuthenticated={vi.fn()} defaultTab="signup" allowBusiness defaultMode="venue" restrictToMode />);
    expect(await screen.findByLabelText(/business name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email or phone number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.queryByText('Service category')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^business$/i })).not.toBeInTheDocument();
  });

  it('a full venue signup: organizer OTP, register as venue, vendor session handed to the host', async () => {
    const otp = vi.spyOn(servicesApi, 'businessRequestOtp').mockResolvedValue({ channel: 'email', identifier: 'bar@x.com' });
    const reg = vi.spyOn(servicesApi, 'venueRegister').mockResolvedValue(session);
    const onBusinessAuthenticated = vi.fn();
    render(
      <BuyerAuthPanel onAuthenticated={vi.fn()} defaultTab="signup" allowBusiness defaultMode="venue" restrictToMode
        onBusinessAuthenticated={onBusinessAuthenticated} />,
    );
    fireEvent.change(await screen.findByLabelText(/business name/i), { target: { value: 'Kwa-Linda Lounge' } });
    fireEvent.change(screen.getByLabelText(/email or phone number/i), { target: { value: 'bar@x.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'secret1' } });
    fireEvent.click(screen.getByRole('button', { name: /create venue account/i }));

    await waitFor(() => expect(otp).toHaveBeenCalledWith({ email: 'bar@x.com' }));
    fireEvent.change(await screen.findByLabelText(/verification code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() =>
      expect(reg).toHaveBeenCalledWith({ businessName: 'Kwa-Linda Lounge', email: 'bar@x.com', password: 'secret1', code: '123456' }),
    );
    expect(onBusinessAuthenticated).toHaveBeenCalledWith({
      accessToken: 'vendor.jwt', refreshToken: 'vendor.refresh', businessId: 'venue123', isLogin: false, accountType: 'venue',
    });
  });

  it('venue login uses the vendor login and reports accountType venue', async () => {
    const login = vi.spyOn(servicesApi, 'businessLogin').mockResolvedValue(session);
    const onBusinessAuthenticated = vi.fn();
    render(
      <BuyerAuthPanel onAuthenticated={vi.fn()} defaultTab="login" allowBusiness defaultMode="venue" restrictToMode
        onBusinessAuthenticated={onBusinessAuthenticated} />,
    );
    expect(screen.getByText('Venue account')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/email or phone number/i), { target: { value: 'bar@x.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'secret1' } });
    fireEvent.click(screen.getByRole('button', { name: /^log in$/i }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('bar@x.com', 'secret1'));
    expect(onBusinessAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'venue123', isLogin: true, accountType: 'venue' }));
  });

  it('"Forgot password?" in venue mode resets the VENDOR account, never the buyer one', async () => {
    const buyerReset = vi.spyOn(api, 'requestPasswordResetOtp');
    const req = vi.spyOn(servicesApi, 'vendorRequestPasswordReset').mockResolvedValue({ channel: 'email', identifier: 'bar@x.com' });
    const reset = vi.spyOn(servicesApi, 'vendorResetPassword').mockResolvedValue(session);
    const onAuthenticated = vi.fn();
    const onBusinessAuthenticated = vi.fn();
    render(
      <BuyerAuthPanel onAuthenticated={onAuthenticated} defaultTab="login" allowBusiness defaultMode="venue" restrictToMode
        onBusinessAuthenticated={onBusinessAuthenticated} />,
    );
    fireEvent.change(screen.getByLabelText(/email or phone number/i), { target: { value: 'bar@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));
    fireEvent.click(await screen.findByRole('button', { name: /send reset code/i }));
    await waitFor(() => expect(req).toHaveBeenCalledWith('bar@x.com'));
    expect(buyerReset).not.toHaveBeenCalled();

    fireEvent.change(await screen.findByLabelText(/verification code/i), { target: { value: '654321' } });
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: 'newpass1' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password|set new password|save/i }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith('bar@x.com', '654321', 'newpass1'));
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(onBusinessAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'venue123', isLogin: true, accountType: 'venue' }));
  });
});
```

Before Step 2, open `BuyerAuthPanel.tsx` and confirm the exact labels used in the reset step 2 form (code label, new-password label, submit text) and the verify-step submit text; adjust ONLY the label/button regexes in this test file to match them. The assertions on which API is called must not change.

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd ~/Documents/omevision/contracts/carrot-tickets/landing-venue-wt && npx vitest run src/components/__tests__/BuyerAuthPanel.venue.test.tsx`
Expected: FAIL — no `Venue` button; `servicesApi.venueRegister` is not a function.

- [ ] **Step 3: Add the three API calls**

In `src/services/servicesApi.ts`, directly after the `businessLogin` entry:

```ts
  // POST /api/tickets/auth/register — the ORGANIZER register (verify-first,
  // same OTP as businessRequestOtp above) with businessType:'venue'. NOT
  // businessRegister: that endpoint creates a SERVICES vendor.
  venueRegister: (body: { businessName: string; email?: string; phoneNumber?: string; password: string; code: string }) =>
    fetchApi<ApiResponse<{ accessToken: string; refreshToken: string; user: unknown }>>('/api/tickets/auth/register', {
      method: 'POST',
      body: JSON.stringify({ ...body, businessType: 'venue' }),
    }).then((r) => r.data),

  // POST /api/tickets/auth/forgot-password + /reset-password — the VENDOR
  // password reset. The panel's buyer reset (api.requestPasswordResetOtp) only
  // knows Buyer accounts, so a business or venue "Forgot password?" must use
  // these or it is told the account does not exist.
  vendorRequestPasswordReset: (identifier: string) =>
    fetchApi<ApiResponse<{ channel: 'sms' | 'email'; identifier: string }>>('/api/tickets/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ identifier }),
    }).then((r) => r.data),

  vendorResetPassword: (identifier: string, code: string, newPassword: string) =>
    fetchApi<ApiResponse<{ accessToken: string; refreshToken: string; user: unknown }>>('/api/tickets/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ identifier, code, newPassword }),
    }).then((r) => r.data),
```

- [ ] **Step 4: Teach the panel the venue mode**

All edits in `src/components/BuyerAuthPanel.tsx`:

(a) Imports — add `Store` to the lucide import list.

(b) Types — replace `type Mode = 'user' | 'business';` and its comment with:

```ts
// Which account the panel is for. Only meaningful when `allowBusiness` is set
// — otherwise the panel never shows the toggle and every signup is a 'user'
// one. 'business' and 'venue' are both VENDOR accounts (vendor login, vendor
// password reset); they differ only in which signup endpoint creates them.
type Mode = 'user' | 'business' | 'venue';
type VendorAccountType = Exclude<Mode, 'user'>;
```

(c) Props — change the `onBusinessAuthenticated` type to:

```ts
  onBusinessAuthenticated?: (result: {
    accessToken: string;
    refreshToken: string;
    businessId: string;
    isLogin: boolean;
    accountType: VendorAccountType;
  }) => void;
```

and append to its doc comment: `accountType tells the host which vendor card the visitor used — a venue lands on the feed, a fresh services signup on its storefront.`

(d) Helpers — add after `identifierPayload`:

```ts
// The vendor id inside a login/register/reset `user` payload, '' if absent.
const businessIdOf = (user: unknown): string => {
  const u = user as { _id?: unknown; id?: unknown } | undefined;
  return String(u?._id ?? u?.id ?? '');
};
```

Replace the two existing inline extractions (in `handleBusinessLogin` and `handleBusinessVerify`: the `const user = result.user as ...` + `const businessId = String(...)` pairs) with `const businessId = businessIdOf(result.user);`.

(e) Inside the component, after the `useState` block:

```ts
  const isVendorMode = mode !== 'user';
  const vendorAccountType: VendorAccountType = mode === 'venue' ? 'venue' : 'business';
```

In `handleBusinessLogin` and `handleBusinessVerify`, add `accountType: vendorAccountType` to the `onBusinessAuthenticated?.({...})` object.

(f) New handlers, after `handleBusinessVerify`:

```ts
  // Sign up — a VENUE (bar, restaurant, lounge). The organizer register with
  // businessType 'venue' — same verify-first OTP endpoint the Business form
  // uses, so handleResend needs no venue branch of its own.
  const handleVenueSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim()) return setFeedback({ kind: 'error', text: 'Enter your venue name' });
    if (!identifier.trim()) return setFeedback({ kind: 'error', text: 'Enter your email or phone number' });
    if (password.length < MIN_PASSWORD)
      return setFeedback({ kind: 'error', text: `Choose a password of at least ${MIN_PASSWORD} characters` });

    setIsLoading(true);
    setFeedback(null);
    try {
      const result = await servicesApi.businessRequestOtp(identifierPayload(identifier.trim()));
      setChannel(result.channel);
      setStep('verify');
      startResendCooldown();
    } catch (err) {
      setFeedback({ kind: 'error', text: message(err, 'Could not start sign up. Please try again.') });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVenueVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setFeedback({ kind: 'error', text: 'Enter the 6-digit code we sent you' });

    setIsLoading(true);
    setFeedback(null);
    try {
      const result = await servicesApi.venueRegister({
        businessName: businessName.trim(),
        ...identifierPayload(identifier.trim()),
        password,
        code,
      });
      const businessId = businessIdOf(result.user);
      if (!businessId) {
        // Same reasoning as handleBusinessVerify: the account WAS created.
        setFeedback({ kind: 'error', text: 'Your venue account was created, but we could not load it. Please log in.' });
        return;
      }
      onBusinessAuthenticated?.({ accessToken: result.accessToken, refreshToken: result.refreshToken, businessId, isLogin: false, accountType: 'venue' });
    } catch (err) {
      setFeedback({ kind: 'error', text: message(err, 'Could not verify the code. Please try again.') });
    } finally {
      setIsLoading(false);
    }
  };
```

(g) `handleResend` — replace the `mode === 'business'` condition with `isVendorMode`, and the reset branch with:

```ts
      const result = resetStep
        ? isVendorMode
          ? await servicesApi.vendorRequestPasswordReset(identifier.trim())
          : await api.requestPasswordResetOtp(identifier.trim())
        : isVendorMode
          ? await servicesApi.businessRequestOtp(identifierPayload(identifier.trim()))
          : await api.requestRegistrationOtp(identifier.trim());
```

(h) `handleResetRequest` — replace `await api.requestPasswordResetOtp(identifier.trim())` with:

```ts
      const result = isVendorMode
        ? await servicesApi.vendorRequestPasswordReset(identifier.trim())
        : await api.requestPasswordResetOtp(identifier.trim());
```

(i) `handleResetVerify` — replace the `try` body with:

```ts
      if (isVendorMode) {
        const result = await servicesApi.vendorResetPassword(identifier.trim(), code, password);
        const businessId = businessIdOf(result.user);
        if (!businessId) {
          setFeedback({ kind: 'error', text: 'Your password was changed, but we could not load your account. Please log in.' });
          return;
        }
        onBusinessAuthenticated?.({ accessToken: result.accessToken, refreshToken: result.refreshToken, businessId, isLogin: true, accountType: vendorAccountType });
      } else {
        const result = await api.resetPassword(identifier.trim(), code, password);
        onAuthenticated(result.accessToken, result.identity);
      }
```

(j) Verify-step form — change `onSubmit={mode === 'business' ? handleBusinessVerify : handleVerify}` to:

```tsx
onSubmit={mode === 'business' ? handleBusinessVerify : mode === 'venue' ? handleVenueVerify : handleVerify}
```

(k) Mode cards — change the grid class to `restrictToMode ? 'grid-cols-1' : 'grid-cols-3'` and add a third entry to the array:

```ts
              { key: 'venue', title: 'Venue', description: tab === 'login' ? 'Venue account' : 'Bar, restaurant or lounge' },
```

Update the comment above the cards from "User | Business" to "User | Business | Venue".

(l) Login form — change `onSubmit={mode === 'business' ? handleBusinessLogin : handleLogin}` to `onSubmit={isVendorMode ? handleBusinessLogin : handleLogin}`.

(m) Sign-up branch — change `) : mode === 'business' ? (` so a venue form comes first:

```tsx
        ) : mode === 'venue' ? (
          <motion.form
            key="signup-venue"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.15 }}
            onSubmit={handleVenueSignup}
            className="space-y-4 rounded-xl border bg-card p-4"
          >
            <div className="space-y-2">
              <Label htmlFor="venue-name">Business name</Label>
              <div className="relative">
                <Store className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="venue-name"
                  placeholder="e.g. Kwa-Linda Lounge"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className="pl-9"
                  maxLength={100}
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="venue-identifier">Email or phone number</Label>
              <Input
                id="venue-identifier"
                placeholder="you@example.com or +268 7612 3456"
                className="placeholder:text-xs"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="venue-password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="venue-password"
                  type="password"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-9"
                  minLength={MIN_PASSWORD}
                  required
                />
              </div>
            </div>
            {feedbackEl}
            {submitBtn('Create venue account')}
            <p className="text-center text-xs text-muted-foreground">
              We'll text or email a 6-digit code to confirm it's you. Carrot switches on venue trading after a quick check.
            </p>
          </motion.form>
        ) : mode === 'business' ? (
```

- [ ] **Step 5: Update the two business assertions**

In `src/components/__tests__/BuyerAuthPanel.business.test.tsx`, add `accountType: 'business',` to the object in both `expect(onBusinessAuthenticated).toHaveBeenCalledWith({ ... })` calls (around lines 129 and 289).

- [ ] **Step 6: Run the panel suites — expect PASS**

Run: `npx vitest run src/components/__tests__/BuyerAuthPanel.venue.test.tsx src/components/__tests__/BuyerAuthPanel.business.test.tsx src/components/__tests__/BuyerAuthPanel.test.tsx`
Expected: PASS — all three files.

- [ ] **Step 7: Commit**

```bash
git add src/services/servicesApi.ts src/components/BuyerAuthPanel.tsx src/components/__tests__/BuyerAuthPanel.venue.test.tsx src/components/__tests__/BuyerAuthPanel.business.test.tsx
git commit -m "feat(venue): Venue option in the auth panel; vendor modes reset via the vendor endpoints"
```

---

## Task 6: `?as=venue` entry, signed-in guard and the "Run a venue" menu item (website)

**Files (in `landing-venue-wt`):**
- Modify: `src/pages/MyTicketsLoginPage.tsx`
- Modify: `src/components/layout/SignupMenu.tsx`
- Create: `src/pages/__tests__/MyTicketsLoginPage.venue.test.tsx`
- Create: `src/components/layout/__tests__/SignupMenu.test.tsx`

**Interfaces:**
- Consumes: `BuyerAuthPanel` `defaultMode="venue"`, `onBusinessAuthenticated({ ..., accountType })` (Task 5).
- Produces: `/my-tickets/login?as=venue` opens Sign up → Venue; a venue auth (signup or login) lands on `/`.

- [ ] **Step 1: Read the existing page tests for their mocking pattern**

Open `src/pages/__tests__/MyTicketsLoginPage.businessLoginNav.test.tsx` and `MyTicketsLoginPage.vendor.test.tsx`. Reuse exactly how they stub `useSession`, `useBuyerAuth`, the router (`MemoryRouter` + `initialEntries`) and (in businessLoginNav) the `BuyerAuthPanel` stub that captures props.

- [ ] **Step 2: Write the failing page tests**

`src/pages/__tests__/MyTicketsLoginPage.venue.test.tsx` — built on the businessLoginNav stub pattern (a `BuyerAuthPanel` mock that records its props and exposes buttons calling `onBusinessAuthenticated`):

```tsx
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const session = { signInVendor: vi.fn(), type: null as null | 'vendor' | 'buyer', operatorType: undefined as string | undefined, vendorId: undefined as string | undefined, brandName: undefined as string | undefined };
vi.mock('@/contexts/SessionContext', () => ({ useSession: () => session }));
vi.mock('@/contexts/BuyerAuthContext', () => ({ useBuyerAuth: () => ({ signIn: vi.fn() }) }));

const panelProps: Record<string, unknown>[] = [];
vi.mock('@/components/BuyerAuthPanel', () => ({
  BuyerAuthPanel: (props: Record<string, unknown> & {
    onBusinessAuthenticated: (r: { accessToken: string; refreshToken: string; businessId: string; isLogin: boolean; accountType: 'business' | 'venue' }) => void;
  }) => {
    panelProps.push(props);
    return (
      <button onClick={() => props.onBusinessAuthenticated({ accessToken: 'a', refreshToken: 'r', businessId: 'venue123', isLogin: false, accountType: 'venue' })}>
        finish venue signup
      </button>
    );
  },
}));

import { MyTicketsLoginPage } from '@/pages/MyTicketsLoginPage';

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/my-tickets/login" element={<MyTicketsLoginPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  panelProps.length = 0;
  session.type = null;
  session.brandName = undefined;
  vi.clearAllMocks();
});

describe('MyTicketsLoginPage — ?as=venue', () => {
  it('opens the panel on Sign up → Venue, restricted to that mode', () => {
    renderAt('/my-tickets/login?as=venue');
    expect(panelProps.at(-1)).toMatchObject({ defaultTab: 'signup', defaultMode: 'venue', restrictToMode: true, allowBusiness: true });
  });

  it('a fresh venue signup signs the vendor in and lands on the feed, not a /services storefront', () => {
    renderAt('/my-tickets/login?as=venue');
    fireEvent.click(screen.getByRole('button', { name: /finish venue signup/i }));
    expect(session.signInVendor).toHaveBeenCalledWith('a', 'r');
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('a signed-in vendor following "Run a venue" is never shown a second signup', () => {
    session.type = 'vendor';
    session.brandName = 'Kwa-Linda Lounge';
    renderAt('/my-tickets/login?as=venue');
    expect(screen.getByText(/you.re already signed in/i)).toBeInTheDocument();
    expect(screen.getByText(/venue trading/i)).toBeInTheDocument();
    expect(panelProps).toHaveLength(0);
  });
});
```

`src/components/layout/__tests__/SignupMenu.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SignupMenu } from '@/components/layout/SignupMenu';

describe('SignupMenu', () => {
  it('offers "Run a venue", linking to the venue signup', () => {
    render(<MemoryRouter><SignupMenu /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /login/i }));
    const item = screen.getByRole('menuitem', { name: /run a venue/i });
    expect(item.getAttribute('href')).toBe('/my-tickets/login?as=venue');
    expect(screen.getByText('Bars, restaurants & lounges')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run them — expect FAIL**

Run: `npx vitest run src/pages/__tests__/MyTicketsLoginPage.venue.test.tsx src/components/layout/__tests__/SignupMenu.test.tsx`
Expected: FAIL — panel opened with `defaultMode: 'user'`; no "Run a venue" item.

- [ ] **Step 4: Derive the intent from `?as=` in `MyTicketsLoginPage.tsx`**

Replace `const wantsBusiness = searchParams.get('as') === 'business';` with:

```ts
  // ?as=business → services signup, ?as=venue → venue signup; anything else
  // (or nothing) keeps the buyer default.
  const asParam = searchParams.get('as');
  const intent: 'user' | 'business' | 'venue' =
    asParam === 'business' ? 'business' : asParam === 'venue' ? 'venue' : 'user';
```

Update the comment above it to mention the `?as=venue` entry ("Run a venue" in SignupMenu).

- [ ] **Step 5: Generalise the signed-in vendor guard**

Change `if (wantsBusiness && type === 'vendor') {` to `if (intent !== 'user' && type === 'vendor') {`. Inside the card, replace the paragraph sentence `Offering a service uses this same Carrot business account — you don't need a separate login.` with:

```tsx
                {intent === 'venue'
                  ? <>Running a venue uses this same Carrot business account — Carrot switches venue trading on for it, so you don&apos;t need a second sign-up.</>
                  : <>Offering a service uses this same Carrot business account — you don&apos;t need a separate login.</>}
```

and make the service-listing button depend on intent: change `{hasServiceListing ? (` to `{intent === 'business' && hasServiceListing ? (`. For `intent === 'venue'`, the existing else-branch's "Adding a service to your account is coming soon." line must NOT show; wrap that `<p>` in `{intent === 'business' && ( ... )}` so a venue sees only the "Back to Carrot" button.

- [ ] **Step 6: Point the panel at the intent**

In the `<BuyerAuthPanel ...>` props:

```tsx
              key={intent}
              defaultTab={intent === 'user' ? 'login' : 'signup'}
              defaultMode={intent}
```

and replace the `onBusinessAuthenticated` handler body with:

```tsx
              onBusinessAuthenticated={({ accessToken, refreshToken, businessId, isLogin, accountType }) => {
                signInVendor(accessToken, refreshToken);
                // A venue (signup or login) and any returning login start on the
                // home feed — the organizer landing, with the switch-to-dashboard
                // bar. Only a fresh SERVICES signup lands on its storefront.
                navigate(isLogin || accountType === 'venue' ? '/' : `/services/${businessId}`, { replace: true });
              }}
```

Update the `key=` comment to say it keys on the derived intent (user / business / venue).

- [ ] **Step 7: Add the menu item**

In `src/components/layout/SignupMenu.tsx`: add `Store` to the lucide import; update the doc comment ("all three entry points" → "all four entry points … — and Run a venue (bar, restaurant, lounge)"); add after the "List your service" `<Link>`:

```tsx
          <Link
            to="/my-tickets/login?as=venue"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={itemCls}
          >
            <Store className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0">
              <span className="block font-medium">Run a venue</span>
              <span className="block text-xs text-muted-foreground">Bars, restaurants &amp; lounges</span>
            </span>
          </Link>
```

- [ ] **Step 8: Run the page + menu suites — expect PASS**

Run: `npx vitest run src/pages/__tests__/ src/components/layout/__tests__/SignupMenu.test.tsx`
Expected: PASS — the new venue tests and every existing MyTicketsLoginPage test.

- [ ] **Step 9: Build (catches Pages-only failures) and commit**

Run: `npm run build`
Expected: build succeeds (tsc + vite). `npm run build` is the only check that matches the Cloudflare Pages build.

```bash
git add src/pages/MyTicketsLoginPage.tsx src/components/layout/SignupMenu.tsx src/pages/__tests__/MyTicketsLoginPage.venue.test.tsx src/components/layout/__tests__/SignupMenu.test.tsx
git commit -m "feat(venue): ?as=venue signup entry, signed-in guard, and Run a venue menu item"
```

---

## Task 7: Dashboard venue types, API client, permission and `useMyVenue`

**Files (in `dashboard-venue-wt`):**
- Modify: `src/types/index.ts` (venue types near the Organizers block, ~line 812; `venue` on `Organizer`)
- Modify: `src/lib/api.ts` (type import list at the top; a `venue` block before `// Organizers admin endpoints`; two calls inside `organizers`)
- Modify: `src/lib/permissions.ts` (`MANAGE_VENUE`, `canManageVenue`)
- Create: `src/hooks/useMyVenue.ts`
- Test: `src/hooks/__tests__/useMyVenue.test.tsx`

**Interfaces:**
- Consumes: `GET /api/tickets/venue`, `POST /api/tickets/admin/venues`, `PATCH /api/tickets/admin/venues/:id` (Tasks 3–4).
- Produces:
  - Types `VenueStatus`, `VenueCurrency`, `VenueSummary { id; name; currency; status; activatedAt: string }`, `MyVenueResponse { venue: VenueSummary | null; eligible: boolean }`; `Organizer.venue?: VenueSummary | null`
  - `apiClient.venue.mine(): Promise<MyVenueResponse>`
  - `apiClient.organizers.activateVenue({ vendorId, name, currency }): Promise<VenueSummary>`
  - `apiClient.organizers.setVenueStatus(venueId, status): Promise<VenueSummary>`
  - `TicketsPermission.MANAGE_VENUE`, `canManageVenue(user): boolean`
  - `useMyVenue()` — TanStack query `['my-venue']`, enabled only for a non-super-admin with `MANAGE_VENUE`

- [ ] **Step 1: Write the failing hook test**

`src/hooks/__tests__/useMyVenue.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AuthUser } from '@/types';

let currentUser: AuthUser | null = null;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: currentUser }) }));
vi.mock('@/lib/api', () => ({ apiClient: { venue: { mine: vi.fn() } } }));

import { apiClient } from '@/lib/api';
import { useMyVenue } from '@/hooks/useMyVenue';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  (apiClient.venue.mine as any).mockResolvedValue({ venue: null, eligible: true });
});

describe('useMyVenue', () => {
  it('fetches for an owner (no permissions array = full access)', async () => {
    currentUser = { _id: 'v1' } as AuthUser;
    const { result } = renderHook(() => useMyVenue(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ venue: null, eligible: true }));
  });

  it('never fetches for a super-admin or a user without MANAGE_VENUE', async () => {
    for (const u of [{ isSuperAdmin: true }, { permissions: ['tickets:view_sales'] }]) {
      currentUser = u as unknown as AuthUser;
      renderHook(() => useMyVenue(), { wrapper });
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(apiClient.venue.mine).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd ~/Documents/omevision/contracts/carrot-tickets/dashboard-venue-wt && npx vitest run src/hooks/__tests__/useMyVenue.test.tsx`
Expected: FAIL — cannot resolve `@/hooks/useMyVenue`.

- [ ] **Step 3: Add the types**

In `src/types/index.ts`, directly above `// Organizers (vendors) — admin Organizers tab`:

```ts
// Venue trading (venue trading spec) — a vendor's day-to-day premises.
export type VenueStatus = 'active' | 'suspended';
export type VenueCurrency = 'SZL' | 'ZAR';

export interface VenueSummary {
  id: string;
  name: string;
  currency: VenueCurrency;
  status: VenueStatus;
  activatedAt: string;
}

// GET /api/tickets/venue. `eligible` decides whether the Venue section applies
// at all: a venue-type account (waiting to be switched on) or any account
// that has a venue.
export interface MyVenueResponse {
  venue: VenueSummary | null;
  eligible: boolean;
}
```

and add to `interface Organizer`, after `revenue: number;`:

```ts
  venue?: VenueSummary | null;
```

- [ ] **Step 4: Add the client calls**

In `src/lib/api.ts`, add `MyVenueResponse`, `VenueCurrency`, `VenueStatus`, `VenueSummary` to the `import type { ... } from '@/types'` list at the top. Directly above `// Organizers admin endpoints (super-admin only)`:

```ts
  // Venue trading — the signed-in vendor's own venue.
  venue = {
    mine: async (): Promise<MyVenueResponse> => this.request<MyVenueResponse>(`/tickets/venue`),
  };
```

Inside `organizers = { ... }`, after `create`:

```ts
    // Venue trading switch (super-admin). One venue per vendor — a second
    // switch-on is a 409 whose message the caller toasts.
    activateVenue: async (data: { vendorId: string; name: string; currency: VenueCurrency }): Promise<VenueSummary> =>
      this.request<VenueSummary>(`/tickets/admin/venues`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    setVenueStatus: async (venueId: string, status: VenueStatus): Promise<VenueSummary> =>
      this.request<VenueSummary>(`/tickets/admin/venues/${venueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
```

- [ ] **Step 5: Add the permission helper**

In `src/lib/permissions.ts`, add `MANAGE_VENUE: 'tickets:manage_venue',` after `ISSUE_TAGS` in `TicketsPermission`, and append:

```ts
/** Venue trading section — the vendor's own venue (stalls, staff, settings). */
export function canManageVenue(user: AuthUser | null | undefined): boolean {
  return hasPermission(user, TicketsPermission.MANAGE_VENUE);
}
```

- [ ] **Step 6: Write the hook**

`src/hooks/useMyVenue.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { canManageVenue } from '@/lib/permissions';

/**
 * The signed-in vendor's venue — ONE cached answer shared by the Sidebar (is
 * there a Venue section?) and VenuePage (which state to show). Never fetched
 * for a super-admin (the platform account is never a venue) or for a user
 * without MANAGE_VENUE (the section is not theirs).
 */
export function useMyVenue() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-venue'],
    queryFn: () => apiClient.venue.mine(),
    enabled: !!user && !user.isSuperAdmin && canManageVenue(user),
    staleTime: 60_000,
  });
}
```

- [ ] **Step 7: Run the test — expect PASS; typecheck**

Run: `npx vitest run src/hooks/__tests__/useMyVenue.test.tsx && npx tsc --noEmit -p .`
Expected: PASS (2 tests); no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/types/index.ts src/lib/api.ts src/lib/permissions.ts src/hooks/useMyVenue.ts src/hooks/__tests__/useMyVenue.test.tsx
git commit -m "feat(venue): dashboard venue types, API client calls, MANAGE_VENUE and useMyVenue"
```

---

## Task 8: Venue page + Sidebar entry (dashboard)

**Files (in `dashboard-venue-wt`):**
- Create: `src/pages/VenuePage.tsx`
- Modify: `src/App.tsx` (import; `<Route path="venue" ...>` beside `get-pos-app`)
- Modify: `src/components/layout/Sidebar.tsx`
- Test: `src/pages/__tests__/VenuePage.test.tsx`
- Test: `src/components/layout/__tests__/Sidebar.venue.test.tsx`

**Interfaces:**
- Consumes: `useMyVenue()`, `canManageVenue`, `VenueCurrency` (Task 7).
- Produces: `VenuePage` at `/venue`; Sidebar item `Venue`.

- [ ] **Step 1: Write the failing page tests**

`src/pages/__tests__/VenuePage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthUser } from '@/types';

let currentUser: AuthUser | null = { _id: 'v1' } as AuthUser;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: currentUser }) }));
vi.mock('@/lib/api', () => ({ apiClient: { venue: { mine: vi.fn() } } }));

import { apiClient } from '@/lib/api';
import { VenuePage } from '@/pages/VenuePage';

const mine = () => apiClient.venue.mine as any;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><VenuePage /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { _id: 'v1' } as AuthUser;
});
afterEach(cleanup);

describe('VenuePage', () => {
  it('active venue: name, Active, currency and switch-on date', async () => {
    mine().mockResolvedValue({
      eligible: true,
      venue: { id: 'ven1', name: 'Kwa-Linda Lounge', currency: 'SZL', status: 'active', activatedAt: '2026-10-01T08:00:00.000Z' },
    });
    renderPage();
    expect(await screen.findByText('Kwa-Linda Lounge')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Lilangeni (E)')).toBeInTheDocument();
    expect(screen.getByText('01 Oct 2026')).toBeInTheDocument();
  });

  it('venue account not switched on yet', async () => {
    mine().mockResolvedValue({ eligible: true, venue: null });
    renderPage();
    expect(await screen.findByText("Venue trading isn't on yet")).toBeInTheDocument();
    expect(screen.getByText('Carrot switches it on after a quick check.')).toBeInTheDocument();
  });

  it('suspended venue', async () => {
    mine().mockResolvedValue({
      eligible: true,
      venue: { id: 'ven1', name: 'X', currency: 'ZAR', status: 'suspended', activatedAt: '2026-10-01T08:00:00.000Z' },
    });
    renderPage();
    expect(await screen.findByText('Venue trading is suspended')).toBeInTheDocument();
    expect(screen.getByText('Contact Carrot.')).toBeInTheDocument();
  });

  it('a failed lookup shows the error with Try again — never the not-on-yet card', async () => {
    mine().mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce({ eligible: true, venue: null });
    renderPage();
    expect(await screen.findByText('Network down')).toBeInTheDocument();
    expect(screen.queryByText("Venue trading isn't on yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(mine()).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Venue trading isn't on yet")).toBeInTheDocument();
  });

  it('a user without MANAGE_VENUE gets no-access and no lookup', async () => {
    currentUser = { permissions: ['tickets:view_sales'] } as unknown as AuthUser;
    renderPage();
    expect(await screen.findByText("You don't have access to the venue")).toBeInTheDocument();
    expect(mine()).not.toHaveBeenCalled();
  });

  it('an account that does not use venue trading', async () => {
    mine().mockResolvedValue({ eligible: false, venue: null });
    renderPage();
    expect(await screen.findByText("This account doesn't use venue trading")).toBeInTheDocument();
  });
});
```

`src/components/layout/__tests__/Sidebar.venue.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthUser } from '@/types';

let currentUser: AuthUser | null = { _id: 'v1' } as AuthUser;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: currentUser }) }));
vi.mock('@/lib/api', () => ({ apiClient: { venue: { mine: vi.fn() } } }));
vi.mock('@/lib/socialFeed', () => ({ SOCIAL_LOGIN_URL: 'https://x', mintSocialFeedUrl: vi.fn() }));

import { apiClient } from '@/lib/api';
import { Sidebar } from '@/components/layout/Sidebar';

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Sidebar open onClose={() => {}} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { _id: 'v1' } as AuthUser;
});
afterEach(cleanup);

describe('Sidebar — Venue', () => {
  it('shows Venue for an eligible account', async () => {
    (apiClient.venue.mine as any).mockResolvedValue({ eligible: true, venue: null });
    renderSidebar();
    expect(await screen.findByRole('link', { name: /^venue$/i })).toHaveAttribute('href', '/venue');
  });

  it('hides Venue for an account that does not use venue trading', async () => {
    (apiClient.venue.mine as any).mockResolvedValue({ eligible: false, venue: null });
    renderSidebar();
    await waitFor(() => expect(apiClient.venue.mine).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: /^venue$/i })).not.toBeInTheDocument();
  });

  it('keeps Venue reachable when the lookup fails, so the page can show the error', async () => {
    (apiClient.venue.mine as any).mockRejectedValue(new Error('Network down'));
    renderSidebar();
    expect(await screen.findByRole('link', { name: /^venue$/i })).toBeInTheDocument();
  });

  it('never looks up a venue for a super-admin', async () => {
    currentUser = { isSuperAdmin: true } as unknown as AuthUser;
    renderSidebar();
    await new Promise((r) => setTimeout(r, 20));
    expect(apiClient.venue.mine).not.toHaveBeenCalled();
  });
});
```

If `Sidebar` imports other modules that need stubbing in jsdom (check its import list), add `vi.mock` lines for them in this file only — do not change `Sidebar` to accommodate the test.

- [ ] **Step 2: Run them — expect FAIL**

Run: `npx vitest run src/pages/__tests__/VenuePage.test.tsx src/components/layout/__tests__/Sidebar.venue.test.tsx`
Expected: FAIL — cannot resolve `@/pages/VenuePage`; no Venue link.

- [ ] **Step 3: Write the page**

`src/pages/VenuePage.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Store } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { canManageVenue } from '@/lib/permissions';
import { useMyVenue } from '@/hooks/useMyVenue';
import type { VenueCurrency } from '@/types';

const CURRENCY_LABEL: Record<VenueCurrency, string> = { SZL: 'Lilangeni (E)', ZAR: 'Rand (R)' };

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function Notice({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

/**
 * The vendor's venue (venue trading spec, Phase 1). Shows which state venue
 * trading is in; later phases add stalls, stock, staff and trading days here.
 * A failed lookup is shown as a failure with Try again — never as "not on yet".
 */
export function VenuePage() {
  const { user } = useAuth();
  const { data, isLoading, isError, error, refetch, isFetching } = useMyVenue();

  let body: ReactNode;
  if (!canManageVenue(user)) {
    body = <Notice title="You don't have access to the venue" description="Ask the account owner to give you venue access." />;
  } else if (isLoading) {
    body = <p className="text-slate-500">Loading venue…</p>;
  } else if (isError) {
    body = (
      <Card>
        <CardHeader>
          <CardTitle>Couldn't load your venue</CardTitle>
          <CardDescription>{error instanceof Error ? error.message : 'Something went wrong.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => refetch()} disabled={isFetching}>Try again</Button>
        </CardContent>
      </Card>
    );
  } else if (!data?.venue) {
    body = data?.eligible
      ? <Notice title="Venue trading isn't on yet" description="Carrot switches it on after a quick check." />
      : <Notice title="This account doesn't use venue trading" description="Venue trading is for bars, restaurants and lounges." />;
  } else if (data.venue.status === 'suspended') {
    body = <Notice title="Venue trading is suspended" description="Contact Carrot." />;
  } else {
    const v = data.venue;
    body = (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="flex items-center gap-3">
            <Store className="h-6 w-6 text-orange-600" />
            <CardTitle>{v.name}</CardTitle>
          </div>
          <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200">Active</Badge>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-slate-500">Currency</dt>
              <dd className="font-medium">{CURRENCY_LABEL[v.currency]}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Switched on</dt>
              <dd className="font-medium">{formatDate(v.activatedAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Venue</h1>
      {body}
    </div>
  );
}
```

- [ ] **Step 4: Route it**

In `src/App.tsx` add `import { VenuePage } from '@/pages/VenuePage';` with the other page imports, and next to `<Route path="get-pos-app" element={<GetPosAppPage />} />`:

```tsx
                  <Route path="venue" element={<VenuePage />} />
```

- [ ] **Step 5: Add the Sidebar item**

In `src/components/layout/Sidebar.tsx`: add `Store` to the lucide import; add `import { useMyVenue } from '@/hooks/useMyVenue';`; inside `Sidebar` after `const homePath = ...`:

```ts
  // Shown for an eligible account — and also when the lookup FAILED, so the
  // Venue page stays reachable to show that failure instead of the section
  // silently vanishing.
  const myVenue = useMyVenue();
```

and add to `navigation` directly after the `Updates` entry:

```ts
    {
      name: 'Venue',
      href: '/venue',
      icon: Store,
      show: !!myVenue.data?.eligible || myVenue.isError,
    },
```

- [ ] **Step 6: Run the tests — expect PASS; typecheck**

Run: `npx vitest run src/pages/__tests__/VenuePage.test.tsx src/components/layout/__tests__/Sidebar.venue.test.tsx && npx tsc --noEmit -p .`
Expected: PASS (6 + 4 tests); no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/VenuePage.tsx src/App.tsx src/components/layout/Sidebar.tsx src/pages/__tests__/VenuePage.test.tsx src/components/layout/__tests__/Sidebar.venue.test.tsx
git commit -m "feat(venue): dashboard Venue page (active / not-on / suspended / error) + sidebar entry"
```

---

## Task 9: Venue switch in the admin Organizers tab (dashboard)

**Files (in `dashboard-venue-wt`):**
- Modify: `src/pages/OrganizersPage.tsx`
- Test: `src/pages/__tests__/OrganizersPage.venue.test.tsx`

**Interfaces:**
- Consumes: `apiClient.organizers.activateVenue`, `apiClient.organizers.setVenueStatus`, `Organizer.venue`, `VenueCurrency` (Task 7).
- Produces: per-row venue badge; Actions items "Switch on venue trading" / "Suspend venue trading" / "Reactivate venue trading"; a switch-on dialog.

- [ ] **Step 1: Write the failing tests**

`src/pages/__tests__/OrganizersPage.venue.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { OrganizersPage } from '@/pages/OrganizersPage';
import { apiClient } from '@/lib/api';
import type { Organizer } from '@/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => ({
  apiClient: {
    organizers: {
      list: vi.fn(),
      updateVerification: vi.fn(),
      create: vi.fn(),
      activateVenue: vi.fn(),
      setVenueStatus: vi.fn(),
    },
  },
}));

const base: Organizer = {
  id: 'org-1', businessName: 'Kwa-Linda Lounge', email: 'bar@x.com', phoneNumber: null, primaryContact: null,
  businessType: 'venue', operatorType: 'events', verificationStatus: 'verified', verifiedAt: null, rejectionReason: null,
  isActive: true, createdAt: '2026-09-01T00:00:00.000Z', eventCount: 0, ticketsSold: 0, revenue: 0, venue: null,
};

function list(organizers: Organizer[]) {
  (apiClient.organizers.list as any).mockResolvedValue({
    organizers, statusCounts: {}, pagination: { page: 1, limit: 25, total: organizers.length, totalPages: 1 },
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OrganizersPage /></QueryClientProvider>);
}

function openActions() {
  const trigger = screen.getByRole('button', { name: /actions/i });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('OrganizersPage — venue trading switch', () => {
  it('switches venue trading on with a name (prefilled) and a currency', async () => {
    list([base]);
    (apiClient.organizers.activateVenue as any).mockResolvedValue({ id: 'ven1', name: 'Kwa-Linda Lounge', currency: 'ZAR', status: 'active', activatedAt: '2026-10-01T00:00:00.000Z' });
    renderPage();
    await screen.findByText('Kwa-Linda Lounge');
    openActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch on venue trading/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/venue name/i)).toHaveValue('Kwa-Linda Lounge');
    fireEvent.change(within(dialog).getByLabelText(/currency/i), { target: { value: 'ZAR' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /switch on/i }));

    await waitFor(() =>
      expect(apiClient.organizers.activateVenue).toHaveBeenCalledWith({ vendorId: 'org-1', name: 'Kwa-Linda Lounge', currency: 'ZAR' }),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('a refused switch-on (409) is toasted with the API message', async () => {
    list([base]);
    (apiClient.organizers.activateVenue as any).mockRejectedValue(new Error('This vendor already has a venue'));
    renderPage();
    await screen.findByText('Kwa-Linda Lounge');
    openActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch on venue trading/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /switch on/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This vendor already has a venue'));
  });

  it('an active venue shows its badge and can be suspended', async () => {
    list([{ ...base, venue: { id: 'ven1', name: 'Kwa-Linda Lounge', currency: 'SZL', status: 'active', activatedAt: '2026-10-01T00:00:00.000Z' } }]);
    (apiClient.organizers.setVenueStatus as any).mockResolvedValue({});
    renderPage();
    expect(await screen.findByText('Venue · on')).toBeInTheDocument();
    openActions();
    expect(screen.queryByRole('menuitem', { name: /switch on venue trading/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: /suspend venue trading/i }));
    await waitFor(() => expect(apiClient.organizers.setVenueStatus).toHaveBeenCalledWith('ven1', 'suspended'));
  });

  it('a suspended venue can be reactivated', async () => {
    list([{ ...base, venue: { id: 'ven1', name: 'Kwa-Linda Lounge', currency: 'SZL', status: 'suspended', activatedAt: '2026-10-01T00:00:00.000Z' } }]);
    (apiClient.organizers.setVenueStatus as any).mockResolvedValue({});
    renderPage();
    expect(await screen.findByText('Venue · suspended')).toBeInTheDocument();
    openActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: /reactivate venue trading/i }));
    await waitFor(() => expect(apiClient.organizers.setVenueStatus).toHaveBeenCalledWith('ven1', 'active'));
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/pages/__tests__/OrganizersPage.venue.test.tsx`
Expected: FAIL — no "Switch on venue trading" menu item.

- [ ] **Step 3: Add state + mutations**

In `src/pages/OrganizersPage.tsx`: add `VenueCurrency, VenueStatus` to the `@/types` import. After the create-dialog state:

```ts
  // "Switch on venue trading" dialog state.
  const [venueTarget, setVenueTarget] = useState<Organizer | null>(null);
  const [venueName, setVenueName] = useState('');
  const [venueCurrency, setVenueCurrency] = useState<VenueCurrency>('SZL');
```

After the `createOrganizer` mutation:

```ts
  const activateVenue = useMutation({
    mutationFn: (p: { vendorId: string; name: string; currency: VenueCurrency }) => apiClient.organizers.activateVenue(p),
    onSuccess: (_d, p) => {
      qc.invalidateQueries({ queryKey: ['organizers'] });
      toast.success(`Venue trading switched on for ${p.name}`);
      setVenueTarget(null);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Switch-on failed'),
  });

  const setVenueStatus = useMutation({
    mutationFn: (p: { venueId: string; status: VenueStatus }) => apiClient.organizers.setVenueStatus(p.venueId, p.status),
    onSuccess: (_d, p) => {
      qc.invalidateQueries({ queryKey: ['organizers'] });
      toast.success(p.status === 'suspended' ? 'Venue trading suspended' : 'Venue trading reactivated');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });

  const openVenueSwitch = (o: Organizer) => {
    setVenueTarget(o);
    setVenueName(o.businessName);
    setVenueCurrency('SZL');
  };
```

- [ ] **Step 4: Badge + menu items**

In the Business cell, after the `operatorType === 'services' ? ... : ...` block:

```tsx
                        {o.venue && (
                          <Badge
                            variant="outline"
                            className={`mt-1 ${o.venue.status === 'active' ? 'bg-orange-100 text-orange-800 border-orange-200' : 'bg-slate-100 text-slate-700 border-slate-200'}`}
                          >
                            Venue · {o.venue.status === 'active' ? 'on' : 'suspended'}
                          </Badge>
                        )}
```

Change the Actions trigger's `disabled` to `disabled={verification.isPending || setVenueStatus.isPending}`. At the END of `<DropdownMenuContent>` add (import `DropdownMenuSeparator` from `@/components/ui/dropdown-menu` alongside the existing dropdown imports):

```tsx
                            <DropdownMenuSeparator />
                            {!o.venue ? (
                              <DropdownMenuItem onClick={() => openVenueSwitch(o)}>Switch on venue trading</DropdownMenuItem>
                            ) : o.venue.status === 'active' ? (
                              <DropdownMenuItem
                                className="text-red-600 focus:text-red-600"
                                onClick={() => setVenueStatus.mutate({ venueId: o.venue!.id, status: 'suspended' })}
                              >
                                Suspend venue trading
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => setVenueStatus.mutate({ venueId: o.venue!.id, status: 'active' })}>
                                Reactivate venue trading
                              </DropdownMenuItem>
                            )}
```

If `src/components/ui/dropdown-menu.tsx` does not export `DropdownMenuSeparator`, omit the separator line rather than adding a primitive.

- [ ] **Step 5: The switch-on dialog**

After the reject/suspend reason `</Dialog>`:

```tsx
      {/* Switch on venue trading */}
      <Dialog open={!!venueTarget} onOpenChange={(open) => !open && setVenueTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch on venue trading</DialogTitle>
            <DialogDescription>
              {venueTarget?.businessName} gets a Venue section in their dashboard. One venue per account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="venue-name">Venue name</Label>
              <Input id="venue-name" value={venueName} onChange={(e) => setVenueName(e.target.value)} maxLength={120} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="venue-currency">Currency</Label>
              <select
                id="venue-currency"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={venueCurrency}
                onChange={(e) => setVenueCurrency(e.target.value as VenueCurrency)}
              >
                <option value="SZL">Lilangeni (E) — SZL</option>
                <option value="ZAR">Rand (R) — ZAR</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVenueTarget(null)} disabled={activateVenue.isPending}>
              Cancel
            </Button>
            <Button
              disabled={activateVenue.isPending || !venueName.trim()}
              onClick={() =>
                venueTarget &&
                activateVenue.mutate({ vendorId: venueTarget.id, name: venueName.trim(), currency: venueCurrency })
              }
            >
              Switch on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

(`Input`, `Label`, `Dialog*` and `Button` are already imported by this page — confirm, and add any that are not.)

- [ ] **Step 6: Run the Organizers suites — expect PASS; typecheck**

Run: `npx vitest run src/pages/__tests__/OrganizersPage.venue.test.tsx src/pages/__tests__/OrganizersPage.test.tsx && npx tsc --noEmit -p .`
Expected: PASS — new venue tests and the existing Organizers tests; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/OrganizersPage.tsx src/pages/__tests__/OrganizersPage.venue.test.tsx
git commit -m "feat(venue): super-admin venue trading switch in the Organizers tab"
```

---

## Task 10: Whole-phase verification

No new code. Every command's OUTPUT is the evidence — read the counts.

- [ ] **Step 1: API — new + neighbouring suites**

```bash
cd ~/Documents/omevision/contracts/carrot-tickets/api-venue-wt
npx jest src/interfaces/__tests__ src/utils/__tests__/permissions.util.test.ts src/services/__tests__/venue.service.test.ts src/services/__tests__/ticketsAuth.register.test.ts src/routes/__tests__/adminVenues.route.test.ts src/routes/__tests__/venueMine.route.test.ts src/routes/__tests__/adminListOrganizers.route.test.ts src/routes/__tests__/adminListOrganizers.venue.route.test.ts src/routes/__tests__/adminCreateOrganizer.route.test.ts src/controllers/__tests__/vendorSocial.me.test.ts --runInBand
npx tsc --noEmit -p .
```

Expected: every listed suite passes; tsc clean. `main` has three known pre-existing failures elsewhere (photo-gate 403s) — they are not in this list; if a full run is attempted, compare failures against `main` before calling anything a regression.

- [ ] **Step 2: Website — full test run + build**

```bash
cd ~/Documents/omevision/contracts/carrot-tickets/landing-venue-wt && npx vitest run && npm run build
```

Expected: all test files pass; build succeeds.

- [ ] **Step 3: Dashboard — full test run + build**

```bash
cd ~/Documents/omevision/contracts/carrot-tickets/dashboard-venue-wt && npx vitest run && npm run build
```

Expected: all test files pass; build succeeds.

- [ ] **Step 4: Report, do not deploy**

Report the three branches, commit lists and test counts to the user. Deploy order when they approve: API first (merge `feat/venue-trading` → `main`; trigger `carrot-tickets-api-main-deploy`; wait for the new Cloud Run revision at 100%), THEN dashboard (`main`) and website (`master`).
