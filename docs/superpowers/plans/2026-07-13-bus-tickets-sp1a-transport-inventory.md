# Bus Tickets — SP1a: Transport Inventory Foundation (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the bus/shuttle inventory domain to `carrot-tickets-api` — vehicle types, routes, trips (with per-scheme seat generation), seat reservations, and availability — so a Vendor can set up sellable bus trips. NO selling/payment yet (that is SP1b).

**Architecture:** Port the Keshless Travels inventory model to Mongoose as new collections under `src/models/transport/`. A bus operator is an existing Carrot **Vendor**; a **Trip** is the sellable inventory (buses' answer to an Event). Business logic lives in `static async` service classes; thin controllers under the existing `/api/tickets/transport` vendor mount (dualAuth + `requireTicketsPermission`). All the money/scan/booking wiring is deferred to SP1b.

**Tech Stack:** TypeScript, Express, Mongoose 8, Joi validators, Jest + ts-jest + mongodb-memory-server. TS path aliases (`@models/*`, `@interfaces/*`, `@services/*`, `@utils/*`, `@middleware/*`, `@validators/*`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-13-bus-tickets-transport-vertical-design.md` (Phase 1, inventory half). Read it before starting.
- **DRY / no reinvention:** reuse the existing `Vendor` model, `HttpError` + `failWithHttpError`, `ApiResponseUtil`, `dualAuth`, `requireTicketsPermission`. Do NOT touch `Event`/`Ticket`/`TicketSale`/`TicketScan`.
- **Fail loudly, never silent-fallback** (repo rule): unknown seat / capacity conflict / scheme mismatch must throw an `HttpError` with a real status, never return a fabricated "ok".
- **Model house style:** interface `extends Document` with `_id: Types.ObjectId` in `src/interfaces/*.interface.ts`; enums as string enums referenced via `enum: Object.values(Enum)`; `{ timestamps: true }`; `toJSON`/`toObject` transform stripping `__v`; explicit `.index(...)` calls; `export const Name = mongoose.model<IName>('Name', schema)` (no barrel file); refs use the registered model-name string.
- **Service house style:** exported `interface XxxParams` input types; `export class XxxService` with all `static async` methods; throw `new HttpError(status, message)`; never trust client-supplied owner ids — always scope by the `vendorId` from the verified JWT.
- **Money unit:** `farePerSeat` is a plain number in the same unit as `Event.ticketTypes[].price` (whole Emalangeni) — match existing price fields, do not introduce cents.
- **Test harness:** put tests in `src/**/__tests__/*.test.ts`; import `{ connectTestDb, clearTestDb, disconnectTestDb }` from the correct relative depth to `src/__tests__/helpers/mongo`; wire `beforeAll(connectTestDb)` / `afterEach(clearTestDb)` / `afterAll(disconnectTestDb)`. Run a single file with `npx jest <path>` from the `api/` dir.
- **Branch:** all SP1a work happens on the dedicated `feat/bus-tickets-transport` branch (created at execution time), NOT on `feat/vendor-social-graph` or `main`.

---

## File Structure

**Create:**
- `src/interfaces/transport.interface.ts` — enums (`SeatScheme`, `TripStatus`) + `IVehicleType`, `IRoute`, `ITrip`, `ISeat`.
- `src/models/transport/vehicleType.model.ts`, `route.model.ts`, `trip.model.ts`, `seat.model.ts`.
- `src/services/transport/vehicleType.service.ts`, `route.service.ts`, `trip.service.ts`.
- `src/validators/transport.validator.ts` — Joi schemas.
- `src/controllers/transport.controller.ts` — vendor transport controller.
- `src/routes/transport.route.ts` — vendor transport router.
- Tests under `src/models/transport/__tests__/` and `src/services/transport/__tests__/`.

**Modify:**
- `src/interfaces/ticketsPermission.interface.ts` — add `VIEW_TRANSPORT`, `MANAGE_TRANSPORT` + grant to MANAGER.
- `src/app.ts` — import + mount `transportRoutes` at `/api/tickets/transport` BEFORE `/api/tickets`.

---

### Task 1: Transport interfaces + `VehicleType` model

**Files:**
- Create: `src/interfaces/transport.interface.ts`
- Create: `src/models/transport/vehicleType.model.ts`
- Test: `src/models/transport/__tests__/vehicleType.model.test.ts`

**Interfaces:**
- Produces: `SeatScheme` (`sequential`|`row_letter`|`passenger_count`), `TripStatus` (`scheduled`|`boarding`|`departed`|`completed`|`cancelled`), `IVehicleType`, `IRoute`, `ITrip`, `ISeat` (all in `@interfaces/transport.interface`); `VehicleType` model (`@models/transport/vehicleType.model`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/transport/__tests__/vehicleType.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { VehicleType } from '@models/transport/vehicleType.model';
import { SeatScheme } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('VehicleType model', () => {
  it('defaults seatScheme to SEQUENTIAL, isActive true, registrations []', async () => {
    const vt = await VehicleType.create({
      vendorId: new mongoose.Types.ObjectId(),
      name: '60-seater coach',
      totalSeats: 60,
    });
    expect(vt.seatScheme).toBe(SeatScheme.SEQUENTIAL);
    expect(vt.isActive).toBe(true);
    expect(vt.registrations).toEqual([]);
    expect((vt.toJSON() as any).__v).toBeUndefined();
  });

  it('enforces unique (vendorId, name)', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    await VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 15 });
    await expect(
      VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 15 }),
    ).rejects.toThrow();
  });

  it('rejects totalSeats < 1', async () => {
    await expect(
      VehicleType.create({ vendorId: new mongoose.Types.ObjectId(), name: 'Bad', totalSeats: 0 }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/transport/__tests__/vehicleType.model.test.ts`
Expected: FAIL — cannot find module `@models/transport/vehicleType.model` / `@interfaces/transport.interface`.

- [ ] **Step 3: Create the interfaces file**

```typescript
// src/interfaces/transport.interface.ts
import { Document, Types } from 'mongoose';

export enum SeatScheme {
  SEQUENTIAL = 'sequential',
  ROW_LETTER = 'row_letter',
  PASSENGER_COUNT = 'passenger_count',
}

export enum TripStatus {
  SCHEDULED = 'scheduled',
  BOARDING = 'boarding',
  DEPARTED = 'departed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/** For ROW_LETTER vehicles: seat labels are generated A1..A{seatsPerRow}, B1.. */
export interface SeatLayout {
  rows: number;
  seatsPerRow: number;
}

export interface IVehicleType extends Document {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  name: string;
  totalSeats: number;
  seatScheme: SeatScheme;
  layoutJson?: SeatLayout | null;
  registrations: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IRoute extends Document {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  name: string;
  originCity: string;
  destinationCity: string;
  stops?: string[];
  farePerSeat: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITrip extends Document {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  routeId: Types.ObjectId;
  vehicleTypeId: Types.ObjectId;
  departureTime: Date;
  arrivalTime?: Date;
  vehicleReg?: string;
  totalSeats: number;
  soldCount: number;
  reservedCount: number;
  status: TripStatus;
  reminderSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISeat extends Document {
  _id: Types.ObjectId;
  tripId: Types.ObjectId;
  seatNumber: string;
  isBooked: boolean;
  bookingId?: Types.ObjectId; // ref 'Booking' — Booking model arrives in SP1b
  isReserved: boolean;
  reservedNote?: string;
  reservedBy?: Types.ObjectId;
  reservedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 4: Create the VehicleType model**

```typescript
// src/models/transport/vehicleType.model.ts
import mongoose, { Schema } from 'mongoose';
import { IVehicleType, SeatScheme } from '@interfaces/transport.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const vehicleTypeSchema = new Schema<IVehicleType>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  name: { type: String, required: [true, 'Vehicle type name is required'], trim: true },
  totalSeats: { type: Number, required: [true, 'Total seats is required'], min: [1, 'A vehicle must have at least 1 seat'] },
  seatScheme: { type: String, enum: Object.values(SeatScheme), default: SeatScheme.SEQUENTIAL },
  layoutJson: { type: Schema.Types.Mixed, default: null },
  registrations: { type: [String], default: [] },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

vehicleTypeSchema.index({ vendorId: 1, name: 1 }, { unique: true });
vehicleTypeSchema.index({ vendorId: 1, isActive: 1 });

export const VehicleType = mongoose.model<IVehicleType>('VehicleType', vehicleTypeSchema);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/models/transport/__tests__/vehicleType.model.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/transport.interface.ts src/models/transport/vehicleType.model.ts src/models/transport/__tests__/vehicleType.model.test.ts
git commit -m "feat(transport): VehicleType model + transport interfaces"
```

---

### Task 2: `Route` model

**Files:**
- Create: `src/models/transport/route.model.ts`
- Test: `src/models/transport/__tests__/route.model.test.ts`

**Interfaces:**
- Consumes: `IRoute` from `@interfaces/transport.interface`.
- Produces: `Route` model (`@models/transport/route.model`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/transport/__tests__/route.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { Route } from '@models/transport/route.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('Route model', () => {
  it('creates a route with fare and defaults isActive true', async () => {
    const route = await Route.create({
      vendorId: new mongoose.Types.ObjectId(),
      name: 'Manzini → Mbabane',
      originCity: 'Manzini',
      destinationCity: 'Mbabane',
      farePerSeat: 35,
    });
    expect(route.isActive).toBe(true);
    expect(route.farePerSeat).toBe(35);
    expect(route.stops).toBeUndefined();
  });

  it('requires originCity, destinationCity and farePerSeat', async () => {
    await expect(
      Route.create({ vendorId: new mongoose.Types.ObjectId(), name: 'X' } as any),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/transport/__tests__/route.model.test.ts`
Expected: FAIL — cannot find module `@models/transport/route.model`.

- [ ] **Step 3: Create the Route model**

```typescript
// src/models/transport/route.model.ts
import mongoose, { Schema } from 'mongoose';
import { IRoute } from '@interfaces/transport.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const routeSchema = new Schema<IRoute>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  name: { type: String, required: [true, 'Route name is required'], trim: true },
  originCity: { type: String, required: [true, 'Origin city is required'], trim: true },
  destinationCity: { type: String, required: [true, 'Destination city is required'], trim: true },
  stops: { type: [String] },
  farePerSeat: { type: Number, required: [true, 'Fare per seat is required'], min: [0, 'Fare cannot be negative'] },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

routeSchema.index({ vendorId: 1, isActive: 1 });
routeSchema.index({ originCity: 1, destinationCity: 1 });

export const Route = mongoose.model<IRoute>('Route', routeSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/models/transport/__tests__/route.model.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/models/transport/route.model.ts src/models/transport/__tests__/route.model.test.ts
git commit -m "feat(transport): Route model"
```

---

### Task 3: `Trip` model

**Files:**
- Create: `src/models/transport/trip.model.ts`
- Test: `src/models/transport/__tests__/trip.model.test.ts`

**Interfaces:**
- Consumes: `ITrip`, `TripStatus` from `@interfaces/transport.interface`.
- Produces: `Trip` model (`@models/transport/trip.model`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/transport/__tests__/trip.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { Trip } from '@models/transport/trip.model';
import { TripStatus } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('Trip model', () => {
  it('defaults status SCHEDULED, soldCount 0, reservedCount 0', async () => {
    const trip = await Trip.create({
      vendorId: new mongoose.Types.ObjectId(),
      routeId: new mongoose.Types.ObjectId(),
      vehicleTypeId: new mongoose.Types.ObjectId(),
      departureTime: new Date(Date.now() + 86400000),
      totalSeats: 15,
    });
    expect(trip.status).toBe(TripStatus.SCHEDULED);
    expect(trip.soldCount).toBe(0);
    expect(trip.reservedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/transport/__tests__/trip.model.test.ts`
Expected: FAIL — cannot find module `@models/transport/trip.model`.

- [ ] **Step 3: Create the Trip model**

```typescript
// src/models/transport/trip.model.ts
import mongoose, { Schema } from 'mongoose';
import { ITrip, TripStatus } from '@interfaces/transport.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const tripSchema = new Schema<ITrip>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route', required: true, index: true },
  vehicleTypeId: { type: Schema.Types.ObjectId, ref: 'VehicleType', required: true },
  departureTime: { type: Date, required: [true, 'Departure time is required'] },
  arrivalTime: { type: Date },
  vehicleReg: { type: String, trim: true },
  totalSeats: { type: Number, required: true, min: [1, 'A trip must have at least 1 seat'] },
  soldCount: { type: Number, default: 0, min: 0 },
  reservedCount: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: Object.values(TripStatus), default: TripStatus.SCHEDULED, index: true },
  reminderSentAt: { type: Date },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

tripSchema.index({ routeId: 1, departureTime: 1 });
tripSchema.index({ vendorId: 1, departureTime: 1 });
tripSchema.index({ status: 1, departureTime: 1 });

export const Trip = mongoose.model<ITrip>('Trip', tripSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/models/transport/__tests__/trip.model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/transport/trip.model.ts src/models/transport/__tests__/trip.model.test.ts
git commit -m "feat(transport): Trip model"
```

---

### Task 4: `Seat` model

**Files:**
- Create: `src/models/transport/seat.model.ts`
- Test: `src/models/transport/__tests__/seat.model.test.ts`

**Interfaces:**
- Consumes: `ISeat` from `@interfaces/transport.interface`.
- Produces: `Seat` model (`@models/transport/seat.model`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/transport/__tests__/seat.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { Seat } from '@models/transport/seat.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('Seat model', () => {
  it('defaults isBooked/isReserved false', async () => {
    const seat = await Seat.create({ tripId: new mongoose.Types.ObjectId(), seatNumber: 'A1' });
    expect(seat.isBooked).toBe(false);
    expect(seat.isReserved).toBe(false);
  });

  it('enforces unique (tripId, seatNumber)', async () => {
    const tripId = new mongoose.Types.ObjectId();
    await Seat.create({ tripId, seatNumber: 'A1' });
    await expect(Seat.create({ tripId, seatNumber: 'A1' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/transport/__tests__/seat.model.test.ts`
Expected: FAIL — cannot find module `@models/transport/seat.model`.

- [ ] **Step 3: Create the Seat model**

```typescript
// src/models/transport/seat.model.ts
import mongoose, { Schema } from 'mongoose';
import { ISeat } from '@interfaces/transport.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const seatSchema = new Schema<ISeat>({
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  seatNumber: { type: String, required: true, trim: true },
  isBooked: { type: Boolean, default: false },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', unique: true, sparse: true },
  isReserved: { type: Boolean, default: false },
  reservedNote: { type: String, trim: true },
  reservedBy: { type: Schema.Types.ObjectId },
  reservedAt: { type: Date },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

seatSchema.index({ tripId: 1, seatNumber: 1 }, { unique: true });
seatSchema.index({ tripId: 1, isBooked: 1 });
seatSchema.index({ tripId: 1, isReserved: 1 });

export const Seat = mongoose.model<ISeat>('Seat', seatSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/models/transport/__tests__/seat.model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/transport/seat.model.ts src/models/transport/__tests__/seat.model.test.ts
git commit -m "feat(transport): Seat model"
```

---

### Task 5: `VehicleTypeService` (vendor-scoped CRUD)

**Files:**
- Create: `src/services/transport/vehicleType.service.ts`
- Test: `src/services/transport/__tests__/vehicleType.service.test.ts`

**Interfaces:**
- Consumes: `VehicleType` model, `SeatScheme`, `HttpError`.
- Produces: `VehicleTypeService.create(params)`, `.list(vendorId)`, `.update(vendorId, id, patch)`, `.deactivate(vendorId, id)`. `CreateVehicleTypeParams { vendorId, name, totalSeats, seatScheme?, layoutJson?, registrations? }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/transport/__tests__/vehicleType.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { VehicleTypeService } from '@services/transport/vehicleType.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { SeatScheme } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const vendorId = () => new mongoose.Types.ObjectId().toString();

describe('VehicleTypeService', () => {
  it('creates and lists vehicle types scoped to the vendor', async () => {
    const v1 = vendorId();
    const v2 = vendorId();
    await VehicleTypeService.create({ vendorId: v1, name: 'Kombi', totalSeats: 15 });
    await VehicleTypeService.create({ vendorId: v2, name: 'Coach', totalSeats: 60, seatScheme: SeatScheme.SEQUENTIAL });
    const list = await VehicleTypeService.list(v1);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Kombi');
  });

  it('rejects a ROW_LETTER type without layoutJson', async () => {
    await expect(
      VehicleTypeService.create({ vendorId: vendorId(), name: 'RowBus', totalSeats: 8, seatScheme: SeatScheme.ROW_LETTER }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('update only touches the caller-owned doc (404 across vendors)', async () => {
    const owner = vendorId();
    const vt = await VehicleTypeService.create({ vendorId: owner, name: 'Kombi', totalSeats: 15 });
    await expect(
      VehicleTypeService.update(vendorId(), vt._id.toString(), { totalSeats: 20 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const updated = await VehicleTypeService.update(owner, vt._id.toString(), { totalSeats: 20 });
    expect(updated.totalSeats).toBe(20);
  });

  it('deactivate flips isActive to false', async () => {
    const owner = vendorId();
    const vt = await VehicleTypeService.create({ vendorId: owner, name: 'Kombi', totalSeats: 15 });
    await VehicleTypeService.deactivate(owner, vt._id.toString());
    const fresh = await VehicleType.findById(vt._id);
    expect(fresh!.isActive).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/vehicleType.service.test.ts`
Expected: FAIL — cannot find module `@services/transport/vehicleType.service`.

- [ ] **Step 3: Write the service**

```typescript
// src/services/transport/vehicleType.service.ts
import { VehicleType } from '@models/transport/vehicleType.model';
import { IVehicleType, SeatScheme, SeatLayout } from '@interfaces/transport.interface';
import { HttpError } from '@utils/httpError.util';

export interface CreateVehicleTypeParams {
  vendorId: string;
  name: string;
  totalSeats: number;
  seatScheme?: SeatScheme;
  layoutJson?: SeatLayout | null;
  registrations?: string[];
}

export interface UpdateVehicleTypeParams {
  name?: string;
  totalSeats?: number;
  seatScheme?: SeatScheme;
  layoutJson?: SeatLayout | null;
  registrations?: string[];
  isActive?: boolean;
}

export class VehicleTypeService {
  static async create(p: CreateVehicleTypeParams): Promise<IVehicleType> {
    const scheme = p.seatScheme ?? SeatScheme.SEQUENTIAL;
    if (scheme === SeatScheme.ROW_LETTER && (!p.layoutJson || !p.layoutJson.rows || !p.layoutJson.seatsPerRow)) {
      throw new HttpError(400, 'ROW_LETTER vehicle type requires layoutJson { rows, seatsPerRow }');
    }
    try {
      return await VehicleType.create({
        vendorId: p.vendorId,
        name: p.name,
        totalSeats: p.totalSeats,
        seatScheme: scheme,
        layoutJson: p.layoutJson ?? null,
        registrations: p.registrations ?? [],
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'A vehicle type with that name already exists');
      throw err;
    }
  }

  static async list(vendorId: string): Promise<IVehicleType[]> {
    return VehicleType.find({ vendorId, isActive: true }).sort({ createdAt: -1 });
  }

  static async update(vendorId: string, id: string, patch: UpdateVehicleTypeParams): Promise<IVehicleType> {
    const vt = await VehicleType.findOne({ _id: id, vendorId });
    if (!vt) throw new HttpError(404, 'Vehicle type not found');
    const nextScheme = patch.seatScheme ?? vt.seatScheme;
    const nextLayout = patch.layoutJson ?? vt.layoutJson;
    if (nextScheme === SeatScheme.ROW_LETTER && (!nextLayout || !nextLayout.rows || !nextLayout.seatsPerRow)) {
      throw new HttpError(400, 'ROW_LETTER vehicle type requires layoutJson { rows, seatsPerRow }');
    }
    Object.assign(vt, patch);
    try {
      return await vt.save();
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'A vehicle type with that name already exists');
      throw err;
    }
  }

  static async deactivate(vendorId: string, id: string): Promise<void> {
    const res = await VehicleType.updateOne({ _id: id, vendorId }, { $set: { isActive: false } });
    if (res.matchedCount === 0) throw new HttpError(404, 'Vehicle type not found');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/vehicleType.service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/vehicleType.service.ts src/services/transport/__tests__/vehicleType.service.test.ts
git commit -m "feat(transport): VehicleTypeService CRUD"
```

---

### Task 6: `RouteService` (vendor-scoped CRUD)

**Files:**
- Create: `src/services/transport/route.service.ts`
- Test: `src/services/transport/__tests__/route.service.test.ts`

**Interfaces:**
- Consumes: `Route` model, `HttpError`.
- Produces: `RouteService.create(params)`, `.list(vendorId)`, `.update(vendorId, id, patch)`, `.deactivate(vendorId, id)`. `CreateRouteParams { vendorId, name, originCity, destinationCity, stops?, farePerSeat }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/transport/__tests__/route.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { RouteService } from '@services/transport/route.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const vendorId = () => new mongoose.Types.ObjectId().toString();

describe('RouteService', () => {
  it('creates + lists routes scoped to the vendor', async () => {
    const v1 = vendorId();
    await RouteService.create({ vendorId: v1, name: 'MZ→MB', originCity: 'Manzini', destinationCity: 'Mbabane', farePerSeat: 35 });
    await RouteService.create({ vendorId: vendorId(), name: 'Other', originCity: 'A', destinationCity: 'B', farePerSeat: 10 });
    const list = await RouteService.list(v1);
    expect(list).toHaveLength(1);
    expect(list[0]!.farePerSeat).toBe(35);
  });

  it('update is vendor-scoped (404 for a non-owner)', async () => {
    const owner = vendorId();
    const r = await RouteService.create({ vendorId: owner, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 20 });
    await expect(
      RouteService.update(vendorId(), r._id.toString(), { farePerSeat: 25 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/route.service.test.ts`
Expected: FAIL — cannot find module `@services/transport/route.service`.

- [ ] **Step 3: Write the service**

```typescript
// src/services/transport/route.service.ts
import { Route } from '@models/transport/route.model';
import { IRoute } from '@interfaces/transport.interface';
import { HttpError } from '@utils/httpError.util';

export interface CreateRouteParams {
  vendorId: string;
  name: string;
  originCity: string;
  destinationCity: string;
  stops?: string[];
  farePerSeat: number;
}

export interface UpdateRouteParams {
  name?: string;
  originCity?: string;
  destinationCity?: string;
  stops?: string[];
  farePerSeat?: number;
  isActive?: boolean;
}

export class RouteService {
  static async create(p: CreateRouteParams): Promise<IRoute> {
    return Route.create({
      vendorId: p.vendorId,
      name: p.name,
      originCity: p.originCity,
      destinationCity: p.destinationCity,
      stops: p.stops,
      farePerSeat: p.farePerSeat,
    });
  }

  static async list(vendorId: string): Promise<IRoute[]> {
    return Route.find({ vendorId, isActive: true }).sort({ createdAt: -1 });
  }

  static async update(vendorId: string, id: string, patch: UpdateRouteParams): Promise<IRoute> {
    const route = await Route.findOneAndUpdate({ _id: id, vendorId }, { $set: patch }, { new: true });
    if (!route) throw new HttpError(404, 'Route not found');
    return route;
  }

  static async deactivate(vendorId: string, id: string): Promise<void> {
    const res = await Route.updateOne({ _id: id, vendorId }, { $set: { isActive: false } });
    if (res.matchedCount === 0) throw new HttpError(404, 'Route not found');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/route.service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/route.service.ts src/services/transport/__tests__/route.service.test.ts
git commit -m "feat(transport): RouteService CRUD"
```

---

### Task 7: `TripService.createTrip` + per-scheme seat generation

**Files:**
- Create: `src/services/transport/trip.service.ts`
- Test: `src/services/transport/__tests__/trip.create.test.ts`

**Interfaces:**
- Consumes: `Trip`, `Seat`, `Route`, `VehicleType` models; `SeatScheme`, `TripStatus`, `ITrip`, `SeatLayout`, `HttpError`.
- Produces: `generateSeatNumbers(scheme, totalSeats, layoutJson?)`, `TripService.createTrip(params)`. `CreateTripParams { vendorId, routeId, vehicleTypeId, departureTime, arrivalTime?, vehicleReg?, reservedSeatNumbers?, reservedCount?, reservedNote? }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/transport/__tests__/trip.create.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { TripService, generateSeatNumbers } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Seat } from '@models/transport/seat.model';
import { SeatScheme } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedRouteAndVehicle(vendorId: string, scheme: SeatScheme, totalSeats: number, layoutJson?: any) {
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 30 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${scheme}`, totalSeats, seatScheme: scheme, layoutJson: layoutJson ?? null });
  return { routeId: route._id.toString(), vehicleTypeId: vt._id.toString() };
}

describe('generateSeatNumbers', () => {
  it('SEQUENTIAL → "1".."N"', () => {
    expect(generateSeatNumbers(SeatScheme.SEQUENTIAL, 3)).toEqual(['1', '2', '3']);
  });
  it('PASSENGER_COUNT → []', () => {
    expect(generateSeatNumbers(SeatScheme.PASSENGER_COUNT, 40)).toEqual([]);
  });
  it('ROW_LETTER → A1..A{spr}, B1.. capped at totalSeats', () => {
    expect(generateSeatNumbers(SeatScheme.ROW_LETTER, 5, { rows: 3, seatsPerRow: 2 })).toEqual(['A1', 'A2', 'B1', 'B2', 'C1']);
  });
});

describe('TripService.createTrip', () => {
  it('SEQUENTIAL: creates a trip and N seat rows', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.SEQUENTIAL, 4);
    const trip = await TripService.createTrip({ vendorId, routeId, vehicleTypeId, departureTime: new Date(Date.now() + 86400000) });
    expect(trip.totalSeats).toBe(4);
    const seats = await Seat.find({ tripId: trip._id }).sort({ seatNumber: 1 });
    expect(seats.map((s) => s.seatNumber)).toEqual(['1', '2', '3', '4']);
  });

  it('PASSENGER_COUNT: creates a trip and NO seat rows, honoring reservedCount', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.PASSENGER_COUNT, 40);
    const trip = await TripService.createTrip({ vendorId, routeId, vehicleTypeId, departureTime: new Date(Date.now() + 86400000), reservedCount: 3 });
    expect(trip.reservedCount).toBe(3);
    expect(await Seat.countDocuments({ tripId: trip._id })).toBe(0);
  });

  it('SEQUENTIAL: reservedSeatNumbers mark those seats isReserved', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.SEQUENTIAL, 4);
    const trip = await TripService.createTrip({ vendorId, routeId, vehicleTypeId, departureTime: new Date(Date.now() + 86400000), reservedSeatNumbers: ['2'], reservedNote: 'regulars' });
    const s2 = await Seat.findOne({ tripId: trip._id, seatNumber: '2' });
    expect(s2!.isReserved).toBe(true);
    expect(s2!.reservedNote).toBe('regulars');
  });

  it('rejects reservedCount on a seat-mapped vehicle', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.SEQUENTIAL, 4);
    await expect(
      TripService.createTrip({ vendorId, routeId, vehicleTypeId, departureTime: new Date(Date.now() + 86400000), reservedCount: 2 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404 when the route or vehicle type belongs to another vendor', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.SEQUENTIAL, 4);
    await expect(
      TripService.createTrip({ vendorId: new mongoose.Types.ObjectId().toString(), routeId, vehicleTypeId, departureTime: new Date(Date.now() + 86400000) }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/trip.create.test.ts`
Expected: FAIL — cannot find module `@services/transport/trip.service`.

- [ ] **Step 3: Write the service (createTrip + generateSeatNumbers)**

```typescript
// src/services/transport/trip.service.ts
import { Trip } from '@models/transport/trip.model';
import { Seat } from '@models/transport/seat.model';
import { Route } from '@models/transport/route.model';
import { VehicleType } from '@models/transport/vehicleType.model';
import { ITrip, SeatScheme, SeatLayout, TripStatus } from '@interfaces/transport.interface';
import { HttpError } from '@utils/httpError.util';

const ROW_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // skip I, L, O for legibility

/** Deterministic seat labels for a scheme. PASSENGER_COUNT has no seat rows. */
export function generateSeatNumbers(scheme: SeatScheme, totalSeats: number, layoutJson?: SeatLayout | null): string[] {
  if (scheme === SeatScheme.PASSENGER_COUNT) return [];
  if (scheme === SeatScheme.SEQUENTIAL) {
    return Array.from({ length: totalSeats }, (_, i) => String(i + 1));
  }
  // ROW_LETTER
  if (!layoutJson || !layoutJson.rows || !layoutJson.seatsPerRow) {
    throw new HttpError(400, 'ROW_LETTER vehicle type requires layoutJson { rows, seatsPerRow }');
  }
  if (layoutJson.rows > ROW_LETTERS.length) {
    throw new HttpError(400, `ROW_LETTER supports at most ${ROW_LETTERS.length} rows`);
  }
  const out: string[] = [];
  for (let r = 0; r < layoutJson.rows; r++) {
    for (let c = 1; c <= layoutJson.seatsPerRow; c++) {
      out.push(`${ROW_LETTERS[r]}${c}`);
    }
  }
  return out.slice(0, totalSeats);
}

export interface CreateTripParams {
  vendorId: string;
  routeId: string;
  vehicleTypeId: string;
  departureTime: Date;
  arrivalTime?: Date;
  vehicleReg?: string;
  reservedSeatNumbers?: string[];
  reservedCount?: number;
  reservedNote?: string;
}

export class TripService {
  static async createTrip(p: CreateTripParams): Promise<ITrip> {
    const route = await Route.findOne({ _id: p.routeId, vendorId: p.vendorId });
    if (!route) throw new HttpError(404, 'Route not found');
    const vt = await VehicleType.findOne({ _id: p.vehicleTypeId, vendorId: p.vendorId });
    if (!vt) throw new HttpError(404, 'Vehicle type not found');

    const seatNumbers = generateSeatNumbers(vt.seatScheme, vt.totalSeats, vt.layoutJson);
    const isSeatMapped = vt.seatScheme !== SeatScheme.PASSENGER_COUNT;

    if (isSeatMapped && p.reservedCount) {
      throw new HttpError(400, 'reservedCount is only valid for passenger-count vehicles; use reservedSeatNumbers');
    }
    if (!isSeatMapped && p.reservedSeatNumbers?.length) {
      throw new HttpError(400, 'reservedSeatNumbers is only valid for seat-mapped vehicles; use reservedCount');
    }
    const reservedCount = !isSeatMapped ? (p.reservedCount ?? 0) : 0;
    if (reservedCount < 0 || reservedCount > vt.totalSeats) {
      throw new HttpError(400, 'reservedCount out of range');
    }
    const reservedSet = new Set(p.reservedSeatNumbers ?? []);
    for (const sn of reservedSet) {
      if (!seatNumbers.includes(sn)) throw new HttpError(400, `Unknown seat ${sn} for this vehicle type`);
    }

    const trip = await Trip.create({
      vendorId: p.vendorId,
      routeId: p.routeId,
      vehicleTypeId: p.vehicleTypeId,
      departureTime: p.departureTime,
      arrivalTime: p.arrivalTime,
      vehicleReg: p.vehicleReg,
      totalSeats: vt.totalSeats,
      soldCount: 0,
      reservedCount,
      status: TripStatus.SCHEDULED,
    });

    if (seatNumbers.length) {
      try {
        await Seat.insertMany(
          seatNumbers.map((sn) => ({
            tripId: trip._id,
            seatNumber: sn,
            isReserved: reservedSet.has(sn),
            reservedNote: reservedSet.has(sn) ? p.reservedNote : undefined,
            reservedAt: reservedSet.has(sn) ? new Date() : undefined,
          })),
        );
      } catch (err) {
        // No multi-doc txn: if seat creation fails, remove the orphan trip and fail loudly.
        await Trip.deleteOne({ _id: trip._id });
        throw err;
      }
    }
    return trip;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/trip.create.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/trip.service.ts src/services/transport/__tests__/trip.create.test.ts
git commit -m "feat(transport): TripService.createTrip + seat generation"
```

---

### Task 8: `TripService` — availability, listing, seat reservation

**Files:**
- Modify: `src/services/transport/trip.service.ts`
- Test: `src/services/transport/__tests__/trip.availability.test.ts`

**Interfaces:**
- Consumes: everything from Task 7.
- Produces (added to `TripService`): `listSellable({ vendorId?, routeId?, now? })`, `getWithAvailability(vendorId, tripId, isSuperAdmin?)` → `{ trip, availableSeats, seats }`, `reserveSeat(vendorId, tripId, seatNumber, note?, byUserId?)`, `releaseSeat(vendorId, tripId, seatNumber)`, `setReservedCount(vendorId, tripId, reservedCount)`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/transport/__tests__/trip.availability.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { TripService } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Seat } from '@models/transport/seat.model';
import { SeatScheme } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedTrip(vendorId: string, scheme: SeatScheme, totalSeats: number, reservedCount = 0, reservedSeatNumbers?: string[]) {
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 30 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${scheme}-${totalSeats}`, totalSeats, seatScheme: scheme });
  return TripService.createTrip({
    vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(),
    departureTime: new Date(Date.now() + 86400000),
    ...(scheme === SeatScheme.PASSENGER_COUNT ? { reservedCount } : { reservedSeatNumbers }),
  });
}

describe('TripService.getWithAvailability', () => {
  it('seat-mapped: availableSeats excludes reserved seats', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const trip = await seedTrip(vendorId, SeatScheme.SEQUENTIAL, 4, 0, ['2']);
    const { availableSeats, seats } = await TripService.getWithAvailability(vendorId, trip._id.toString());
    expect(availableSeats).toBe(3); // 4 seats − 1 reserved
    expect(seats).toHaveLength(4);
  });

  it('passenger-count: availableSeats = total − sold − reserved, no seat list', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const trip = await seedTrip(vendorId, SeatScheme.PASSENGER_COUNT, 40, 5);
    const { availableSeats, seats } = await TripService.getWithAvailability(vendorId, trip._id.toString());
    expect(availableSeats).toBe(35);
    expect(seats).toEqual([]);
  });
});

describe('TripService.reserveSeat / releaseSeat', () => {
  it('reserves a free seat and rejects a double reserve with 409', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const trip = await seedTrip(vendorId, SeatScheme.SEQUENTIAL, 4);
    await TripService.reserveSeat(vendorId, trip._id.toString(), '1', 'held');
    const s1 = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(s1!.isReserved).toBe(true);
    await expect(
      TripService.reserveSeat(vendorId, trip._id.toString(), '1'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('releaseSeat clears the reservation', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const trip = await seedTrip(vendorId, SeatScheme.SEQUENTIAL, 4);
    await TripService.reserveSeat(vendorId, trip._id.toString(), '1');
    await TripService.releaseSeat(vendorId, trip._id.toString(), '1');
    const s1 = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(s1!.isReserved).toBe(false);
  });
});

describe('TripService.setReservedCount', () => {
  it('rejects a reservedCount that exceeds capacity', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const trip = await seedTrip(vendorId, SeatScheme.PASSENGER_COUNT, 10, 0);
    await expect(
      TripService.setReservedCount(vendorId, trip._id.toString(), 11),
    ).rejects.toMatchObject({ statusCode: 400 });
    const updated = await TripService.setReservedCount(vendorId, trip._id.toString(), 4);
    expect(updated.reservedCount).toBe(4);
  });
});

describe('TripService.listSellable', () => {
  it('returns only scheduled/boarding future trips, optionally filtered by route', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const t = await seedTrip(vendorId, SeatScheme.SEQUENTIAL, 4);
    const list = await TripService.listSellable({ vendorId });
    expect(list.map((x) => x._id.toString())).toContain(t._id.toString());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/trip.availability.test.ts`
Expected: FAIL — `TripService.getWithAvailability is not a function`.

- [ ] **Step 3: Append the methods to `TripService`**

Add these imports at the top of `trip.service.ts` if not present: `Seat` is already imported. Add `import { FilterQuery } from 'mongoose';`. Then add inside the `TripService` class:

```typescript
  static async getWithAvailability(vendorId: string, tripId: string, isSuperAdmin = false): Promise<{ trip: ITrip; availableSeats: number; seats: any[] }> {
    const query: FilterQuery<ITrip> = isSuperAdmin ? { _id: tripId } : { _id: tripId, vendorId };
    const trip = await Trip.findOne(query)
      .populate('routeId', 'name originCity destinationCity farePerSeat')
      .populate('vehicleTypeId', 'name seatScheme totalSeats');
    if (!trip) throw new HttpError(404, 'Trip not found');

    const vt = trip.vehicleTypeId as any;
    if (vt?.seatScheme === SeatScheme.PASSENGER_COUNT) {
      const availableSeats = Math.max(0, trip.totalSeats - trip.soldCount - trip.reservedCount);
      return { trip, availableSeats, seats: [] };
    }
    const seats = await Seat.find({ tripId: trip._id }).sort({ seatNumber: 1 });
    const availableSeats = seats.filter((s) => !s.isBooked && !s.isReserved).length;
    return { trip, availableSeats, seats };
  }

  static async listSellable(p: { vendorId?: string; routeId?: string; now?: Date }): Promise<ITrip[]> {
    const now = p.now ?? new Date();
    const query: FilterQuery<ITrip> = {
      status: { $in: [TripStatus.SCHEDULED, TripStatus.BOARDING] },
      departureTime: { $gte: now },
    };
    if (p.vendorId) query.vendorId = p.vendorId;
    if (p.routeId) query.routeId = p.routeId;
    return Trip.find(query)
      .sort({ departureTime: 1 })
      .populate('routeId', 'name originCity destinationCity farePerSeat')
      .populate('vehicleTypeId', 'name seatScheme');
  }

  static async reserveSeat(vendorId: string, tripId: string, seatNumber: string, note?: string, byUserId?: string): Promise<void> {
    const trip = await Trip.findOne({ _id: tripId, vendorId });
    if (!trip) throw new HttpError(404, 'Trip not found');
    const seat = await Seat.findOneAndUpdate(
      { tripId, seatNumber, isBooked: false, isReserved: false },
      { $set: { isReserved: true, reservedNote: note, reservedBy: byUserId, reservedAt: new Date() } },
      { new: true },
    );
    if (!seat) throw new HttpError(409, 'Seat is already booked or reserved');
  }

  static async releaseSeat(vendorId: string, tripId: string, seatNumber: string): Promise<void> {
    const trip = await Trip.findOne({ _id: tripId, vendorId });
    if (!trip) throw new HttpError(404, 'Trip not found');
    const seat = await Seat.findOneAndUpdate(
      { tripId, seatNumber, isBooked: false, isReserved: true },
      { $set: { isReserved: false }, $unset: { reservedNote: '', reservedBy: '', reservedAt: '' } },
      { new: true },
    );
    if (!seat) throw new HttpError(409, 'Seat is not currently reserved (or is booked)');
  }

  static async setReservedCount(vendorId: string, tripId: string, reservedCount: number): Promise<ITrip> {
    const trip = await Trip.findOne({ _id: tripId, vendorId });
    if (!trip) throw new HttpError(404, 'Trip not found');
    if (reservedCount < 0 || reservedCount + trip.soldCount > trip.totalSeats) {
      throw new HttpError(400, 'reservedCount would exceed trip capacity');
    }
    trip.reservedCount = reservedCount;
    return trip.save();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/trip.availability.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/trip.service.ts src/services/transport/__tests__/trip.availability.test.ts
git commit -m "feat(transport): trip availability, listing, seat reservation"
```

---

### Task 9: Transport permissions

**Files:**
- Modify: `src/interfaces/ticketsPermission.interface.ts`
- Test: `src/interfaces/__tests__/transportPermissions.test.ts`

**Interfaces:**
- Produces: `TicketsPermission.VIEW_TRANSPORT` (`tickets:view_transport`), `TicketsPermission.MANAGE_TRANSPORT` (`tickets:manage_transport`). OWNER auto-includes both (it is `Object.values(...)` minus the 3 platform-staff-only perms); MANAGER gets both explicitly.

- [ ] **Step 1: Write the failing test**

```typescript
// src/interfaces/__tests__/transportPermissions.test.ts
import { TicketsPermission, TicketsRole, TICKETS_ROLE_PERMISSIONS } from '@interfaces/ticketsPermission.interface';

describe('transport permissions', () => {
  it('defines VIEW_TRANSPORT and MANAGE_TRANSPORT', () => {
    expect(TicketsPermission.VIEW_TRANSPORT).toBe('tickets:view_transport');
    expect(TicketsPermission.MANAGE_TRANSPORT).toBe('tickets:manage_transport');
  });
  it('OWNER has both (non-platform-staff perm)', () => {
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.MANAGE_TRANSPORT);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.VIEW_TRANSPORT);
  });
  it('MANAGER has both', () => {
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]).toContain(TicketsPermission.MANAGE_TRANSPORT);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]).toContain(TicketsPermission.VIEW_TRANSPORT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/interfaces/__tests__/transportPermissions.test.ts`
Expected: FAIL — `VIEW_TRANSPORT` is undefined.

- [ ] **Step 3: Add the enum members + MANAGER grant**

In `src/interfaces/ticketsPermission.interface.ts`, add to the `TicketsPermission` enum (right after the `SCAN_TICKETS`/`VIEW_SCANS` block, before Analytics):

```typescript
  // Transport (bus/shuttle) inventory management
  VIEW_TRANSPORT = 'tickets:view_transport',
  MANAGE_TRANSPORT = 'tickets:manage_transport',
```

Then, in the `TICKETS_ROLE_PERMISSIONS` map, add both to the `MANAGER` array (append after `TicketsPermission.VIEW_STATS`):

```typescript
    TicketsPermission.VIEW_TRANSPORT,
    TicketsPermission.MANAGE_TRANSPORT,
```

(OWNER needs no change — it is computed as every permission except the 3 platform-staff-only ones, so both new perms are automatically included.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/interfaces/__tests__/transportPermissions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/ticketsPermission.interface.ts src/interfaces/__tests__/transportPermissions.test.ts
git commit -m "feat(transport): VIEW_TRANSPORT + MANAGE_TRANSPORT permissions"
```

---

### Task 10: Vendor transport validators + controller + routes + mount

**Files:**
- Create: `src/validators/transport.validator.ts`
- Create: `src/controllers/transport.controller.ts`
- Create: `src/routes/transport.route.ts`
- Modify: `src/app.ts`
- Test: `src/services/transport/__tests__/trip.smoke.test.ts` (service-level end-to-end covering the flow the controller exposes) + a manual curl check.

**Interfaces:**
- Consumes: all services from Tasks 5–8; `authenticateTickets`, `requireTicketsPermission`, `TicketsPermission`; `ApiResponseUtil`, `failWithHttpError`.
- Produces: `transportRoutes` default export mounted at `/api/tickets/transport`.

- [ ] **Step 1: Write the failing end-to-end service test (the flow the controller drives)**

```typescript
// src/services/transport/__tests__/trip.smoke.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { VehicleTypeService } from '@services/transport/vehicleType.service';
import { RouteService } from '@services/transport/route.service';
import { TripService } from '@services/transport/trip.service';
import { SeatScheme } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('vendor can set up fleet → route → trip and read availability end to end', async () => {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const vt = await VehicleTypeService.create({ vendorId, name: 'Kombi', totalSeats: 15, seatScheme: SeatScheme.SEQUENTIAL });
  const route = await RouteService.create({ vendorId, name: 'MZ→MB', originCity: 'Manzini', destinationCity: 'Mbabane', farePerSeat: 35 });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  const sellable = await TripService.listSellable({ vendorId });
  expect(sellable.map((t) => t._id.toString())).toContain(trip._id.toString());
  const { availableSeats } = await TripService.getWithAvailability(vendorId, trip._id.toString());
  expect(availableSeats).toBe(15);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/trip.smoke.test.ts`
Expected: PASS already if Tasks 5–8 are done (this asserts the end-to-end wiring the controller will expose). If it fails, fix the service before writing the controller. (This test guards the contract the controller depends on.)

- [ ] **Step 3: Write the Joi validators**

```typescript
// src/validators/transport.validator.ts
import Joi from 'joi';
import { SeatScheme } from '@interfaces/transport.interface';

const HEX24 = /^[0-9a-fA-F]{24}$/;

const layoutJson = Joi.object({
  rows: Joi.number().integer().min(1).required(),
  seatsPerRow: Joi.number().integer().min(1).required(),
});

export const createVehicleTypeSchema = Joi.object({
  name: Joi.string().trim().max(100).required(),
  totalSeats: Joi.number().integer().min(1).max(200).required(),
  seatScheme: Joi.string().valid(...Object.values(SeatScheme)).default(SeatScheme.SEQUENTIAL),
  layoutJson: Joi.when('seatScheme', { is: SeatScheme.ROW_LETTER, then: layoutJson.required(), otherwise: Joi.any().strip() }),
  registrations: Joi.array().items(Joi.string().trim()).optional(),
});

export const updateVehicleTypeSchema = Joi.object({
  name: Joi.string().trim().max(100).optional(),
  totalSeats: Joi.number().integer().min(1).max(200).optional(),
  seatScheme: Joi.string().valid(...Object.values(SeatScheme)).optional(),
  layoutJson: layoutJson.optional(),
  registrations: Joi.array().items(Joi.string().trim()).optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export const createRouteSchema = Joi.object({
  name: Joi.string().trim().max(120).required(),
  originCity: Joi.string().trim().max(80).required(),
  destinationCity: Joi.string().trim().max(80).required(),
  stops: Joi.array().items(Joi.string().trim()).optional(),
  farePerSeat: Joi.number().min(0).required(),
});

export const updateRouteSchema = Joi.object({
  name: Joi.string().trim().max(120).optional(),
  originCity: Joi.string().trim().max(80).optional(),
  destinationCity: Joi.string().trim().max(80).optional(),
  stops: Joi.array().items(Joi.string().trim()).optional(),
  farePerSeat: Joi.number().min(0).optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export const createTripSchema = Joi.object({
  routeId: Joi.string().regex(HEX24).required(),
  vehicleTypeId: Joi.string().regex(HEX24).required(),
  departureTime: Joi.date().iso().greater('now').required(),
  arrivalTime: Joi.date().iso().greater(Joi.ref('departureTime')).optional(),
  vehicleReg: Joi.string().trim().max(20).optional(),
  reservedSeatNumbers: Joi.array().items(Joi.string().trim()).optional(),
  reservedCount: Joi.number().integer().min(0).optional(),
  reservedNote: Joi.string().trim().max(200).optional(),
});

export const reserveSeatSchema = Joi.object({ note: Joi.string().trim().max(200).optional() });
export const reservedCountSchema = Joi.object({ reservedCount: Joi.number().integer().min(0).required() });
export const listTripsQuerySchema = Joi.object({ routeId: Joi.string().regex(HEX24).optional() });
```

- [ ] **Step 4: Write the controller**

```typescript
// src/controllers/transport.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { VehicleTypeService } from '@services/transport/vehicleType.service';
import { RouteService } from '@services/transport/route.service';
import { TripService } from '@services/transport/trip.service';
import {
  createVehicleTypeSchema, updateVehicleTypeSchema,
  createRouteSchema, updateRouteSchema,
  createTripSchema, reserveSeatSchema, reservedCountSchema, listTripsQuerySchema,
} from '@validators/transport.validator';

function vendorId(req: Request): string | undefined {
  return (req as any).ticketsUser?.vendorId;
}

export class TransportController {
  // ── Vehicle types ──────────────────────────────────────────────
  static async createVehicleType(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = createVehicleTypeSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      const vt = await VehicleTypeService.create({ vendorId: vid, ...value });
      return ApiResponseUtil.created(res, vt, 'Vehicle type created');
    } catch (e) { return failWithHttpError(res, e, 'Failed to create vehicle type'); }
  }

  static async listVehicleTypes(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      return ApiResponseUtil.success(res, await VehicleTypeService.list(vid));
    } catch (e) { return failWithHttpError(res, e, 'Failed to list vehicle types'); }
  }

  static async updateVehicleType(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = updateVehicleTypeSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      const vt = await VehicleTypeService.update(vid, String(req.params['id']), value);
      return ApiResponseUtil.success(res, vt, 'Vehicle type updated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to update vehicle type'); }
  }

  static async deleteVehicleType(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      await VehicleTypeService.deactivate(vid, String(req.params['id']));
      return ApiResponseUtil.success(res, { deactivated: true }, 'Vehicle type deactivated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to deactivate vehicle type'); }
  }

  // ── Routes ─────────────────────────────────────────────────────
  static async createRoute(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = createRouteSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.created(res, await RouteService.create({ vendorId: vid, ...value }), 'Route created');
    } catch (e) { return failWithHttpError(res, e, 'Failed to create route'); }
  }

  static async listRoutes(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      return ApiResponseUtil.success(res, await RouteService.list(vid));
    } catch (e) { return failWithHttpError(res, e, 'Failed to list routes'); }
  }

  static async updateRoute(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = updateRouteSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.success(res, await RouteService.update(vid, String(req.params['id']), value), 'Route updated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to update route'); }
  }

  static async deleteRoute(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      await RouteService.deactivate(vid, String(req.params['id']));
      return ApiResponseUtil.success(res, { deactivated: true }, 'Route deactivated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to deactivate route'); }
  }

  // ── Trips ──────────────────────────────────────────────────────
  static async createTrip(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = createTripSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.created(res, await TripService.createTrip({ vendorId: vid, ...value }), 'Trip created');
    } catch (e) { return failWithHttpError(res, e, 'Failed to create trip'); }
  }

  static async listTrips(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = listTripsQuerySchema.validate(req.query);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.success(res, await TripService.listSellable({ vendorId: vid, routeId: value.routeId }));
    } catch (e) { return failWithHttpError(res, e, 'Failed to list trips'); }
  }

  static async getTrip(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      return ApiResponseUtil.success(res, await TripService.getWithAvailability(vid, String(req.params['id'])));
    } catch (e) { return failWithHttpError(res, e, 'Failed to load trip'); }
  }

  static async reserveSeat(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = reserveSeatSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      await TripService.reserveSeat(vid, String(req.params['id']), String(req.params['seatNumber']), value.note, (req as any).ticketsUser?.userId);
      return ApiResponseUtil.success(res, { reserved: true }, 'Seat reserved');
    } catch (e) { return failWithHttpError(res, e, 'Failed to reserve seat'); }
  }

  static async releaseSeat(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      await TripService.releaseSeat(vid, String(req.params['id']), String(req.params['seatNumber']));
      return ApiResponseUtil.success(res, { reserved: false }, 'Seat released');
    } catch (e) { return failWithHttpError(res, e, 'Failed to release seat'); }
  }

  static async setReservedCount(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = reservedCountSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.success(res, await TripService.setReservedCount(vid, String(req.params['id']), value.reservedCount), 'Reserved count updated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to set reserved count'); }
  }
}
```

- [ ] **Step 5: Write the router**

```typescript
// src/routes/transport.route.ts
import { Router } from 'express';
import { authenticateTickets, requireTicketsPermission } from '@middleware/ticketsAuth.middleware';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { TransportController } from '@controllers/transport.controller';

// Vendor (bus operator) transport inventory. Mounted at /api/tickets/transport
// — see src/app.ts, placed BEFORE the broader /api/tickets mount so these
// specific paths aren't shadowed.
const router = Router();

router.use(authenticateTickets);

const VIEW = requireTicketsPermission(TicketsPermission.VIEW_TRANSPORT);
const MANAGE = requireTicketsPermission(TicketsPermission.MANAGE_TRANSPORT);

// Vehicle types
router.post('/vehicle-types', MANAGE, TransportController.createVehicleType);
router.get('/vehicle-types', VIEW, TransportController.listVehicleTypes);
router.patch('/vehicle-types/:id', MANAGE, TransportController.updateVehicleType);
router.delete('/vehicle-types/:id', MANAGE, TransportController.deleteVehicleType);

// Routes
router.post('/routes', MANAGE, TransportController.createRoute);
router.get('/routes', VIEW, TransportController.listRoutes);
router.patch('/routes/:id', MANAGE, TransportController.updateRoute);
router.delete('/routes/:id', MANAGE, TransportController.deleteRoute);

// Trips
router.post('/trips', MANAGE, TransportController.createTrip);
router.get('/trips', VIEW, TransportController.listTrips);
router.get('/trips/:id', VIEW, TransportController.getTrip);
router.post('/trips/:id/seats/:seatNumber/reserve', MANAGE, TransportController.reserveSeat);
router.delete('/trips/:id/seats/:seatNumber/reserve', MANAGE, TransportController.releaseSeat);
router.patch('/trips/:id/reserved-count', MANAGE, TransportController.setReservedCount);

export default router;
```

- [ ] **Step 6: Mount in `app.ts`**

Add the import alongside the other `@routes/*` imports (near `import vendorSocialRoutes from '@routes/vendorSocial.route';`):

```typescript
import transportRoutes from '@routes/transport.route';
```

Add the mount in the `app.use(...)` block, BEFORE `app.use('/api/tickets', ticketsRoutes);` (same rule the `/api/tickets/social` mount follows):

```typescript
app.use('/api/tickets/transport', transportRoutes); // Vendor bus/shuttle inventory — before the broad /api/tickets
```

- [ ] **Step 7: Typecheck + run the transport suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx jest src/services/transport src/models/transport src/interfaces/__tests__/transportPermissions.test.ts`
Expected: all transport tests PASS.

- [ ] **Step 8: Manual smoke (optional but recommended)**

Start the dev server (`npm run dev`), obtain a vendor JWT with MANAGE_TRANSPORT (OWNER/MANAGER role), then:

```bash
# create a vehicle type
curl -sX POST http://localhost:PORT/api/tickets/transport/vehicle-types \
  -H "Authorization: Bearer $VENDOR_JWT" -H 'Content-Type: application/json' \
  -d '{"name":"Kombi","totalSeats":15}'
# create a route, then a trip using the returned ids, then GET /trips
```
Expected: 201s with the created docs; `GET /trips` lists the trip; `GET /trips/:id` returns `availableSeats: 15` and a 15-seat map.

- [ ] **Step 9: Commit**

```bash
git add src/validators/transport.validator.ts src/controllers/transport.controller.ts src/routes/transport.route.ts src/app.ts src/services/transport/__tests__/trip.smoke.test.ts
git commit -m "feat(transport): vendor transport routes, controller, validators, mount"
```

---

## Self-Review

**Spec coverage (SP1a = Phase-1 inventory half of the spec §5.1/§5.3/§5.4/§5.5):**
- VehicleType / Route / Trip / Seat models → Tasks 1–4. ✓
- Per-scheme seat generation (SEQUENTIAL / ROW_LETTER / PASSENGER_COUNT) → Task 7 (`generateSeatNumbers`). ✓
- `trip.service` create + listSellable + get-with-availability + reserve/release + setReservedCount → Tasks 7–8. ✓
- Vendor-scoped CRUD endpoints under the house-style `/api/tickets/transport` mount → Task 10. ✓
- `Vendor.businessType += 'transport'` — NOTE: the spec adds `'transport'` to the businessType enum. It is only needed when a vendor self-identifies as a bus operator in the dashboard (SP3). Not required for SP1a's API (routes are gated by permission, not businessType). **Deferred to SP3** to avoid an unused enum change now. (Logged so it isn't lost.)
- Booking / BookingSale / BoardingScan / payment / boarding / POS endpoints → **SP1b** (explicitly out of scope here).

**Placeholder scan:** no TBD/TODO; every step has real code or an exact command. ✓

**Type consistency:** `SeatScheme`/`TripStatus`/`SeatLayout`/`IVehicleType`/`IRoute`/`ITrip`/`ISeat` defined once in Task 1 and imported everywhere. Service method names used in Task 10's controller (`create`, `list`, `update`, `deactivate`, `createTrip`, `listSellable`, `getWithAvailability`, `reserveSeat`, `releaseSeat`, `setReservedCount`) all match Tasks 5–8. `Seat.bookingId` ref `'Booking'` is a forward reference resolved in SP1b — harmless until then (Mongoose refs are lazy strings). ✓

**Scope check:** SP1a is a single coherent subsystem (inventory) producing testable software (a vendor can build sellable trips). Selling is SP1b. ✓
