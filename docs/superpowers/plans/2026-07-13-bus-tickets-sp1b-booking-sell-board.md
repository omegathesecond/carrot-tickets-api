# Bus Tickets — SP1b: Booking, Sync Selling & Boarding (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of the SP1a inventory domain, add booking + boarding: a conductor sells a bus seat on the POS with **cash or Keshless wallet** (synchronous payment), gets a QR-coded ticket, and boards passengers by scanning. Async methods (MoMo, card) are SP1c.

**Architecture:** Dedicated `Booking`, `BookingSale`, `BoardingScan` collections (the user chose separate collections over overloading `TicketSale`/`TicketScan`). `BookingService.sellSeat` atomically claims a seat (or passenger-count capacity), charges via the **reused** `@services/payments` processor layer, computes the economic snapshot via the **reused** `computeSaleEconomics`, and writes a `Booking(CONFIRMED)` + `BookingSale(COMPLETED)`. Selling happens on the existing POS/reseller mount (`/api/reseller/transport`, `authenticateReseller`).

**Tech Stack:** TypeScript, Express, Mongoose 8, Joi, Jest + ts-jest + mongodb-memory-server. Reuses `getProcessor`, `computeSaleEconomics`, `generateTicketCode`, `PaymentConfigService`, and the SP1a models/services.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-13-bus-tickets-transport-vertical-design.md` (Phase 1 selling half, §5.1/§5.3/§5.5/§5.6). **Depends on SP1a** (`docs/superpowers/plans/2026-07-13-bus-tickets-sp1a-transport-inventory.md`) being merged — this plan imports `Trip`, `Seat`, `Route`, `TripService`, `SeatScheme`, `TripStatus`.
- **DRY / no reinvention:** reuse `getProcessor` (`@services/payments`), `computeSaleEconomics` (`@services/saleEconomics.service`), `serviceFeeFor`/`round2` (`@utils/serviceFee.util`), `PaymentConfigService`, `generateTicketCode` (`@utils/ticketCode.util`), `normalizePhone` (`@utils/phone.util`), `HttpError` + `failWithHttpError`, `ApiResponseUtil`, `authenticateReseller` + `requireResellerPermission`. Do NOT touch `Ticket`/`TicketSale`/`TicketScan`/`Event`.
- **Fail loudly, never silent-fallback:** a failed charge rolls back the seat claim and throws through the normal error channel — never a fabricated success or a canned booking.
- **Sync only:** SP1b accepts payment methods `cash` and `keshless_wallet` (the two synchronous processors). `mtn_momo` and `peach_card` are rejected with a clear 400 until SP1c wires their async finalizers.
- **Money invariant (mirror of events):** a bus booking is one seat → `quantity = 1`, `totalAmount = route.farePerSeat` (face). POS/reseller sales stay at face — `serviceFeeAmount = 0`, `amountCharged = totalAmount`. `computeSaleEconomics` runs off the face amount to produce `platformFeeAmount`/`organizerProceeds`/`fundsCustody`, spread onto the `BookingSale`.
- **Model house style:** interface `extends Document` (`_id: Types.ObjectId`) in `@interfaces/*`; enums via `enum: Object.values(Enum)`; `{ timestamps: true }`; `toJSON`/`toObject` transform stripping `__v`; explicit `.index(...)`; `export const Name = mongoose.model<IName>('Name', schema)`.
- **Reused enums:** `BookingSale` reuses `PaymentMethod`, `PaymentStatus`, `SalesChannel` from `@interfaces/ticket.interface` (do NOT duplicate them).
- **POS permission:** reuse `ResellerPermission.SELL_TICKETS` (sell a bus seat) and `ResellerPermission.VIEW_EVENTS` (browse trips). No new reseller permissions — the same conductor sells events and buses.
- **Test harness:** tests in `src/**/__tests__/*.test.ts`; import `{ connectTestDb, clearTestDb, disconnectTestDb }` from the correct relative depth to `src/__tests__/helpers/mongo`; `beforeAll(connectTestDb)` / `afterEach(clearTestDb)` / `afterAll(disconnectTestDb)`. Run one file with `npx jest <path>` from `api/`.
- **Branch:** continues on `feat/bus-tickets-transport`.

---

## File Structure

**Create:**
- `src/interfaces/booking.interface.ts` — `BookingStatus`, `BoardingScanResult` enums + `IBooking`, `IBookingSale`, `IBoardingScan`.
- `src/models/transport/booking.model.ts`, `bookingSale.model.ts`, `boardingScan.model.ts`.
- `src/services/transport/booking.service.ts` — `sellSeat`, `board`.
- `src/validators/transportPos.validator.ts` — POS Joi schemas.
- `src/controllers/transportPos.controller.ts` — POS controller.
- `src/routes/transportPos.route.ts` — POS router.
- Tests under `src/models/transport/__tests__/` and `src/services/transport/__tests__/`.

**Modify:**
- `src/app.ts` — mount `transportPosRoutes` at `/api/reseller/transport`.

---

### Task 1: `Booking` model (+ booking interfaces)

**Files:**
- Create: `src/interfaces/booking.interface.ts`
- Create: `src/models/transport/booking.model.ts`
- Test: `src/models/transport/__tests__/booking.model.test.ts`

**Interfaces:**
- Produces: `BookingStatus` (`pending`|`confirmed`|`cancelled`|`refunded`|`boarded`|`no_show`), `BoardingScanResult` (`success`|`already_boarded`|`wrong_trip`|`cancelled_booking`|`invalid`), `IBooking`, `IBookingSale`, `IBoardingScan` (all in `@interfaces/booking.interface`); `Booking` model.

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/transport/__tests__/booking.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { Booking } from '@models/transport/booking.model';
import { BookingStatus } from '@interfaces/booking.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('Booking model', () => {
  it('auto-generates a unique bookingRef + qrCode and defaults status PENDING', async () => {
    const b = await Booking.create({
      tripId: new mongoose.Types.ObjectId(),
      vendorId: new mongoose.Types.ObjectId(),
      passengerName: 'Thabo M.',
      passengerPhone: '+26876111111',
      seatNumber: 'A1',
      fareAmount: 35,
      platformFee: 0,
      totalAmount: 35,
    });
    expect(b.status).toBe(BookingStatus.PENDING);
    expect(b.bookingRef).toMatch(/^[A-Z0-9]{8}$/);
    expect(b.qrCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(b.bookingRef).not.toEqual(b.qrCode);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/transport/__tests__/booking.model.test.ts`
Expected: FAIL — cannot find module `@models/transport/booking.model`.

- [ ] **Step 3: Create the booking interfaces**

```typescript
// src/interfaces/booking.interface.ts
import { Document, Types } from 'mongoose';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

export enum BookingStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  BOARDED = 'boarded',
  NO_SHOW = 'no_show',
}

export enum BoardingScanResult {
  SUCCESS = 'success',
  ALREADY_BOARDED = 'already_boarded',
  WRONG_TRIP = 'wrong_trip',
  CANCELLED_BOOKING = 'cancelled_booking',
  INVALID = 'invalid',
}

export interface IBooking extends Document {
  _id: Types.ObjectId;
  bookingRef: string;
  qrCode: string;
  tripId: Types.ObjectId;
  vendorId: Types.ObjectId;
  passengerName: string;
  passengerPhone: string;
  seatNumber?: string; // null for PASSENGER_COUNT trips
  fareAmount: number;
  platformFee: number;
  totalAmount: number;
  saleId?: Types.ObjectId; // ref BookingSale
  purchasedBy?: Types.ObjectId;
  status: BookingStatus;
  boardedAt?: Date;
  boardedBy?: Types.ObjectId;
  cancelledAt?: Date;
  refundedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBookingSale extends Document {
  _id: Types.ObjectId;
  saleRef: string;
  tripId: Types.ObjectId;
  vendorId: Types.ObjectId;
  bookingIds: Types.ObjectId[];
  quantity: number;
  customerName?: string;
  customerPhone?: string;
  customerUserId?: Types.ObjectId;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  walletTransactionId?: string;
  momoReferenceId?: string;
  momoFailureReason?: string;
  peachPaymentId?: string;
  reservationExpiresAt?: Date;
  soldBy: Types.ObjectId;
  soldByType: 'Vendor' | 'VendorSubUser' | 'ResellerOperator';
  channel: SalesChannel;
  resellerId?: Types.ObjectId;
  hubId?: Types.ObjectId;
  faceAmount?: number;
  resellerCommissionPercent?: number;
  resellerCommissionAmount?: number;
  platformFeePercent?: number;
  platformFeeAmount?: number;
  serviceFeeAmount?: number;
  amountCharged?: number;
  organizerProceeds?: number;
  fundsCustody?: 'carrot' | 'reseller' | 'vendor';
  soldAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBoardingScan extends Document {
  _id: Types.ObjectId;
  bookingId?: Types.ObjectId;
  tripId: Types.ObjectId;
  vendorId: Types.ObjectId;
  scannedBy: Types.ObjectId;
  scannedByType: 'Vendor' | 'VendorSubUser' | 'ResellerOperator';
  result: BoardingScanResult;
  notes?: string;
  scannedAt: Date;
  createdAt: Date;
}
```

- [ ] **Step 4: Create the Booking model**

```typescript
// src/models/transport/booking.model.ts
import mongoose, { Schema } from 'mongoose';
import { IBooking, BookingStatus } from '@interfaces/booking.interface';
import { generateTicketCode } from '@utils/ticketCode.util';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const bookingSchema = new Schema<IBooking>({
  bookingRef: { type: String, unique: true, index: true },
  qrCode: { type: String, unique: true, index: true },
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  passengerName: { type: String, required: true, trim: true },
  passengerPhone: { type: String, required: true, trim: true },
  seatNumber: { type: String, trim: true },
  fareAmount: { type: Number, required: true, min: 0 },
  platformFee: { type: Number, required: true, min: 0, default: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  saleId: { type: Schema.Types.ObjectId, ref: 'BookingSale', index: true },
  purchasedBy: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
  status: { type: String, enum: Object.values(BookingStatus), default: BookingStatus.PENDING, index: true },
  boardedAt: { type: Date },
  boardedBy: { type: Schema.Types.ObjectId },
  cancelledAt: { type: Date },
  refundedAt: { type: Date },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

// Generate-and-check unique short codes for bookingRef + qrCode (mirror Ticket).
bookingSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const model = this.constructor as mongoose.Model<IBooking>;
  const uniqueCode = async (field: 'bookingRef' | 'qrCode'): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateTicketCode();
      const exists = await model.exists({ [field]: candidate });
      if (!exists) return candidate;
    }
    throw new Error(`Could not generate a unique booking ${field}`);
  };
  try {
    if (!this.bookingRef) this.bookingRef = await uniqueCode('bookingRef');
    if (!this.qrCode) {
      let qr = await uniqueCode('qrCode');
      while (qr === this.bookingRef) qr = await uniqueCode('qrCode');
      this.qrCode = qr;
    }
    next();
  } catch (err) { next(err as Error); }
});

bookingSchema.index({ tripId: 1, status: 1 });
bookingSchema.index({ vendorId: 1, createdAt: -1 });
bookingSchema.index({ status: 1, createdAt: -1 });

export const Booking = mongoose.model<IBooking>('Booking', bookingSchema);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/models/transport/__tests__/booking.model.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/booking.interface.ts src/models/transport/booking.model.ts src/models/transport/__tests__/booking.model.test.ts
git commit -m "feat(transport): Booking model + booking interfaces"
```

---

### Task 2: `BookingSale` model

**Files:**
- Create: `src/models/transport/bookingSale.model.ts`
- Test: `src/models/transport/__tests__/bookingSale.model.test.ts`

**Interfaces:**
- Consumes: `IBookingSale` from `@interfaces/booking.interface`; `PaymentMethod`, `PaymentStatus`, `SalesChannel` from `@interfaces/ticket.interface`.
- Produces: `BookingSale` model.

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/transport/__tests__/bookingSale.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { BookingSale } from '@models/transport/bookingSale.model';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('BookingSale model', () => {
  it('auto-generates saleRef and defaults paymentStatus PENDING', async () => {
    const sale = await BookingSale.create({
      tripId: new mongoose.Types.ObjectId(),
      vendorId: new mongoose.Types.ObjectId(),
      bookingIds: [new mongoose.Types.ObjectId()],
      quantity: 1,
      totalAmount: 35,
      paymentMethod: PaymentMethod.CASH,
      soldBy: new mongoose.Types.ObjectId(),
      soldByType: 'ResellerOperator',
      channel: SalesChannel.RESELLER_POS,
    });
    expect(sale.saleRef).toMatch(/^BSALE-/);
    expect(sale.paymentStatus).toBe(PaymentStatus.PENDING);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/transport/__tests__/bookingSale.model.test.ts`
Expected: FAIL — cannot find module `@models/transport/bookingSale.model`.

- [ ] **Step 3: Create the BookingSale model**

```typescript
// src/models/transport/bookingSale.model.ts
import mongoose, { Schema } from 'mongoose';
import { IBookingSale } from '@interfaces/booking.interface';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const bookingSaleSchema = new Schema<IBookingSale>({
  saleRef: { type: String, unique: true, index: true },
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  bookingIds: [{ type: Schema.Types.ObjectId, ref: 'Booking', required: true }],
  quantity: { type: Number, required: true, min: 1 },
  customerName: { type: String, trim: true },
  customerPhone: { type: String, trim: true },
  customerUserId: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
  totalAmount: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true, index: true },
  paymentStatus: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING, index: true },
  walletTransactionId: { type: String, trim: true, sparse: true },
  momoReferenceId: { type: String, trim: true, sparse: true, index: true },
  momoFailureReason: { type: String, trim: true },
  peachPaymentId: { type: String, trim: true, sparse: true, index: true },
  reservationExpiresAt: { type: Date, index: true },
  soldBy: { type: Schema.Types.ObjectId, required: true, refPath: 'soldByType' },
  soldByType: { type: String, required: true, enum: ['Vendor', 'VendorSubUser', 'ResellerOperator'], default: 'ResellerOperator' },
  channel: { type: String, enum: Object.values(SalesChannel), index: true },
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', index: true, sparse: true },
  hubId: { type: Schema.Types.ObjectId, ref: 'ResellerHub', index: true, sparse: true },
  faceAmount: { type: Number },
  resellerCommissionPercent: { type: Number, default: 0 },
  resellerCommissionAmount: { type: Number, default: 0 },
  platformFeePercent: { type: Number, default: 0 },
  platformFeeAmount: { type: Number, default: 0 },
  serviceFeeAmount: { type: Number, default: 0 },
  amountCharged: { type: Number },
  organizerProceeds: { type: Number },
  fundsCustody: { type: String, enum: ['carrot', 'reseller', 'vendor'] },
  soldAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

bookingSaleSchema.pre('save', function (next) {
  if (this.isNew && !this.saleRef) {
    const random = Math.random().toString(36).substring(2, 9).toUpperCase();
    this.saleRef = `BSALE-${Date.now()}-${random}`;
  }
  next();
});

bookingSaleSchema.index({ vendorId: 1, soldAt: -1 });
bookingSaleSchema.index({ tripId: 1, soldAt: -1 });

export const BookingSale = mongoose.model<IBookingSale>('BookingSale', bookingSaleSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/models/transport/__tests__/bookingSale.model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/transport/bookingSale.model.ts src/models/transport/__tests__/bookingSale.model.test.ts
git commit -m "feat(transport): BookingSale money record"
```

---

### Task 3: `BoardingScan` model

**Files:**
- Create: `src/models/transport/boardingScan.model.ts`
- Test: `src/models/transport/__tests__/boardingScan.model.test.ts`

**Interfaces:**
- Consumes: `IBoardingScan`, `BoardingScanResult`.
- Produces: `BoardingScan` model.

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/transport/__tests__/boardingScan.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { BoardingScan } from '@models/transport/boardingScan.model';
import { BoardingScanResult } from '@interfaces/booking.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('persists a boarding scan with a result', async () => {
  const scan = await BoardingScan.create({
    tripId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    scannedBy: new mongoose.Types.ObjectId(),
    scannedByType: 'ResellerOperator',
    result: BoardingScanResult.SUCCESS,
  });
  expect(scan.result).toBe(BoardingScanResult.SUCCESS);
  expect(scan.scannedAt).toBeInstanceOf(Date);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/transport/__tests__/boardingScan.model.test.ts`
Expected: FAIL — cannot find module `@models/transport/boardingScan.model`.

- [ ] **Step 3: Create the BoardingScan model**

```typescript
// src/models/transport/boardingScan.model.ts
import mongoose, { Schema } from 'mongoose';
import { IBoardingScan, BoardingScanResult } from '@interfaces/booking.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const boardingScanSchema = new Schema<IBoardingScan>({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', index: true },
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  scannedBy: { type: Schema.Types.ObjectId, required: true, refPath: 'scannedByType' },
  scannedByType: { type: String, required: true, enum: ['Vendor', 'VendorSubUser', 'ResellerOperator'] },
  result: { type: String, enum: Object.values(BoardingScanResult), required: true, index: true },
  notes: { type: String, trim: true, maxlength: 500 },
  scannedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

boardingScanSchema.index({ tripId: 1, scannedAt: -1 });
boardingScanSchema.index({ bookingId: 1, scannedAt: -1 });
boardingScanSchema.index({ scannedBy: 1, scannedAt: -1 });

export const BoardingScan = mongoose.model<IBoardingScan>('BoardingScan', boardingScanSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/models/transport/__tests__/boardingScan.model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/transport/boardingScan.model.ts src/models/transport/__tests__/boardingScan.model.test.ts
git commit -m "feat(transport): BoardingScan model"
```

---

### Task 4: `BookingService.sellSeat` (synchronous cash/wallet sale)

**Files:**
- Create: `src/services/transport/booking.service.ts`
- Test: `src/services/transport/__tests__/booking.sell.test.ts`

**Interfaces:**
- Consumes: `Trip`, `Seat` (SP1a); `Booking`, `BookingSale`; `getProcessor` (`@services/payments`); `computeSaleEconomics` (`@services/saleEconomics.service`); `PaymentConfigService`; `normalizePhone`; `round2` (`@utils/serviceFee.util`); `PaymentMethod`, `PaymentStatus`, `SalesChannel`; `SeatScheme`, `TripStatus`; `HttpError`.
- Produces: `BookingService.sellSeat(params)` → `{ booking, sale }`. `SellSeatParams { tripId, seatNumber?, passengerName, passengerPhone, paymentMethod, keshlessCardNumber?, keshlessPin?, soldBy, soldByType, resellerId?, hubId?, resellerCommissionPercent? }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/transport/__tests__/booking.sell.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Seat } from '@models/transport/seat.model';
import { Booking } from '@models/transport/booking.model';
import { SeatScheme } from '@interfaces/transport.interface';
import { BookingStatus } from '@interfaces/booking.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedTrip(scheme: SeatScheme, totalSeats: number) {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${scheme}-${totalSeats}`, totalSeats, seatScheme: scheme });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  return { vendorId, trip };
}

const sellArgs = (extra: any) => ({
  passengerName: 'Thabo M.', passengerPhone: '76707421',
  paymentMethod: PaymentMethod.CASH,
  soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator' as const,
  ...extra,
});

describe('BookingService.sellSeat — cash', () => {
  it('seat-mapped: claims the seat, creates a CONFIRMED booking + COMPLETED sale', async () => {
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    const { booking, sale } = await BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1' }));
    expect(booking.status).toBe(BookingStatus.CONFIRMED);
    expect(booking.seatNumber).toBe('1');
    expect(booking.totalAmount).toBe(35);
    expect(booking.qrCode).toBeTruthy();
    expect(sale.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale.fundsCustody).toBe('reseller'); // cash + ResellerOperator
    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(true);
    expect(seat!.bookingId!.toString()).toBe(booking._id.toString());
  });

  it('stores passengerPhone normalized so My-Tickets matching works', async () => {
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    const { booking } = await BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1' }));
    expect(booking.passengerPhone).toBe('+26876707421');
  });

  it('rejects a second sale of the same seat with 409', async () => {
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    await BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1' }));
    await expect(
      BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1' })),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await Booking.countDocuments({ tripId: trip._id })).toBe(1);
  });

  it('concurrent sales of the same seat: exactly one wins', async () => {
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    const results = await Promise.allSettled([
      BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1' })),
      BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1' })),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(await Booking.countDocuments({ tripId: trip._id })).toBe(1);
  });

  it('passenger-count: sells against capacity and rejects the N+1th with 409', async () => {
    const { trip } = await seedTrip(SeatScheme.PASSENGER_COUNT, 2);
    await BookingService.sellSeat(sellArgs({ tripId: trip._id.toString() }));
    await BookingService.sellSeat(sellArgs({ tripId: trip._id.toString() }));
    await expect(
      BookingService.sellSeat(sellArgs({ tripId: trip._id.toString() })),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an async method (mtn_momo) with 400 in SP1b', async () => {
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    await expect(
      BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1', paymentMethod: PaymentMethod.MTN_MOMO })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects selling a seat on a departed trip with 422', async () => {
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    const { Trip } = await import('@models/transport/trip.model');
    const { TripStatus } = await import('@interfaces/transport.interface');
    await Trip.updateOne({ _id: trip._id }, { $set: { status: TripStatus.DEPARTED } });
    await expect(
      BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1' })),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('BookingService.sellSeat — payment failure rollback', () => {
  it('releases the seat and throws when the processor returns failed', async () => {
    jest.resetModules();
    jest.doMock('@services/payments', () => ({
      getProcessor: () => ({ charge: async () => ({ status: 'failed', message: 'Insufficient balance' }) }),
    }));
    const { BookingService: BS } = await import('@services/transport/booking.service');
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    await expect(
      BS.sellSeat({ ...sellArgs({ tripId: trip._id.toString(), seatNumber: '1', paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: 'ABCD2345' }) }),
    ).rejects.toThrow(/Insufficient balance/);
    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(false);
    expect(await Booking.countDocuments({ tripId: trip._id })).toBe(0);
    jest.dontMock('@services/payments');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/booking.sell.test.ts`
Expected: FAIL — cannot find module `@services/transport/booking.service`.

- [ ] **Step 3: Write the service**

```typescript
// src/services/transport/booking.service.ts
import mongoose from 'mongoose';
import { Trip } from '@models/transport/trip.model';
import { Seat } from '@models/transport/seat.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { SeatScheme, TripStatus } from '@interfaces/transport.interface';
import { IBooking, IBookingSale, BookingStatus } from '@interfaces/booking.interface';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import { getProcessor } from '@services/payments';
import { computeSaleEconomics, SaleSoldByType } from '@services/saleEconomics.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { round2 } from '@utils/serviceFee.util';
import { normalizePhone } from '@utils/phone.util';
import { HttpError } from '@utils/httpError.util';

const SYNC_METHODS: PaymentMethod[] = [PaymentMethod.CASH, PaymentMethod.KESHLESS_WALLET];

const SOLD_BY_MAP: Record<'vendor' | 'sub-user' | 'reseller-operator', SaleSoldByType> = {
  vendor: 'Vendor',
  'sub-user': 'VendorSubUser',
  'reseller-operator': 'ResellerOperator',
};

export interface SellSeatParams {
  tripId: string;
  seatNumber?: string; // required for seat-mapped, omitted for PASSENGER_COUNT
  passengerName: string;
  passengerPhone: string;
  paymentMethod: PaymentMethod;
  keshlessCardNumber?: string;
  keshlessPin?: string;
  soldBy: string;
  soldByType: 'vendor' | 'sub-user' | 'reseller-operator';
  resellerId?: string;
  hubId?: string;
  resellerCommissionPercent?: number;
}

export class BookingService {
  static async sellSeat(p: SellSeatParams): Promise<{ booking: IBooking; sale: IBookingSale }> {
    if (!SYNC_METHODS.includes(p.paymentMethod)) {
      throw new HttpError(400, `Payment method ${p.paymentMethod} is not yet supported for bus bookings`);
    }

    const trip = await Trip.findById(p.tripId).populate('vehicleTypeId', 'seatScheme');
    if (!trip) throw new HttpError(404, 'Trip not found');
    if (![TripStatus.SCHEDULED, TripStatus.BOARDING].includes(trip.status)) {
      throw new HttpError(422, 'Trip is not open for sale');
    }
    const scheme = (trip.vehicleTypeId as any)?.seatScheme as SeatScheme;
    const isSeatMapped = scheme !== SeatScheme.PASSENGER_COUNT;

    const route = await Trip.db.model('Route').findById(trip.routeId).select('farePerSeat');
    if (!route) throw new HttpError(404, 'Route not found');
    const fare = (route as any).farePerSeat as number;

    // Pre-allocate the booking id so we can stamp it on the seat during the atomic claim.
    const booking = new Booking({
      tripId: trip._id,
      vendorId: trip.vendorId,
      passengerName: p.passengerName,
      passengerPhone: normalizePhone(p.passengerPhone),
      seatNumber: isSeatMapped ? p.seatNumber : undefined,
      fareAmount: fare,
      platformFee: 0,
      totalAmount: fare,
      status: BookingStatus.PENDING,
    });

    // ── Atomic capacity claim ─────────────────────────────────────
    if (isSeatMapped) {
      if (!p.seatNumber) throw new HttpError(400, 'seatNumber is required for this vehicle');
      const seat = await Seat.findOneAndUpdate(
        { tripId: trip._id, seatNumber: p.seatNumber, isBooked: false, isReserved: false },
        { $set: { isBooked: true, bookingId: booking._id } },
        { new: true },
      );
      if (!seat) throw new HttpError(409, 'Seat is already booked or reserved');
    } else {
      const claimed = await Trip.findOneAndUpdate(
        { _id: trip._id, $expr: { $lt: [{ $add: ['$soldCount', '$reservedCount'] }, '$totalSeats'] } },
        { $inc: { soldCount: 1 } },
        { new: true },
      );
      if (!claimed) throw new HttpError(409, 'Trip is fully booked');
    }

    const releaseClaim = async () => {
      if (isSeatMapped) {
        await Seat.updateOne({ tripId: trip._id, seatNumber: p.seatNumber, bookingId: booking._id }, { $set: { isBooked: false }, $unset: { bookingId: '' } });
      } else {
        await Trip.updateOne({ _id: trip._id }, { $inc: { soldCount: -1 } });
      }
    };

    // ── Charge (synchronous processors only) ──────────────────────
    let paymentStatus: PaymentStatus;
    let walletTransactionId: string | undefined;
    try {
      const charge = await getProcessor(p.paymentMethod).charge({
        method: p.paymentMethod,
        amount: fare, // POS stays at face; no service fee
        description: `Carrot Tickets bus - seat ${p.seatNumber ?? 'GA'}`,
        keshlessCardNumber: p.keshlessCardNumber,
        keshlessPin: p.keshlessPin,
      });
      if (charge.status !== 'completed') throw new HttpError(402, charge.message || 'Payment failed');
      walletTransactionId = charge.providerRef;
      paymentStatus = PaymentStatus.COMPLETED;
    } catch (err) {
      await releaseClaim();
      throw err;
    }

    // ── Economic snapshot (reused DRY helper) ─────────────────────
    const cfg = await PaymentConfigService.get();
    const mappedSoldByType = SOLD_BY_MAP[p.soldByType];
    const econ = computeSaleEconomics({
      faceAmount: fare,
      paymentMethod: p.paymentMethod as any,
      soldByType: mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent ?? cfg.defaultResellerCommissionPercent,
      platformFeePercent: cfg.platformFeePercent,
    });

    // ── Persist booking + sale ────────────────────────────────────
    booking.platformFee = econ.platformFeeAmount;
    booking.status = BookingStatus.CONFIRMED;
    await booking.save();

    const sale = await BookingSale.create({
      tripId: trip._id,
      vendorId: trip.vendorId,
      bookingIds: [booking._id],
      quantity: 1,
      customerName: p.passengerName,
      customerPhone: booking.passengerPhone,
      totalAmount: fare,
      paymentMethod: p.paymentMethod,
      paymentStatus,
      walletTransactionId,
      soldBy: p.soldBy,
      soldByType: mappedSoldByType,
      channel: SalesChannel.RESELLER_POS,
      ...(p.resellerId ? { resellerId: p.resellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
      faceAmount: fare,
      serviceFeeAmount: 0,
      amountCharged: fare,
      resellerCommissionPercent: econ.resellerCommissionPercent,
      resellerCommissionAmount: econ.resellerCommissionAmount,
      platformFeePercent: econ.platformFeePercent,
      platformFeeAmount: econ.platformFeeAmount,
      organizerProceeds: econ.organizerProceeds,
      fundsCustody: econ.fundsCustody,
      soldAt: new Date(),
    });

    booking.saleId = sale._id as mongoose.Types.ObjectId;
    await booking.save();

    return { booking, sale: sale as IBookingSale };
  }
}

// round2 imported to keep the money-rounding utility co-located with future fee logic.
void round2;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/booking.sell.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/booking.service.ts src/services/transport/__tests__/booking.sell.test.ts
git commit -m "feat(transport): BookingService.sellSeat (cash/wallet sync sale)"
```

---

### Task 5: `BookingService.board` (boarding scan)

**Files:**
- Modify: `src/services/transport/booking.service.ts`
- Test: `src/services/transport/__tests__/booking.board.test.ts`

**Interfaces:**
- Consumes: `Booking`, `BoardingScan`, `BoardingScanResult`, `HttpError`, everything from Task 4.
- Produces (added to `BookingService`): `board({ qrCode, tripId, scannedBy, scannedByType })` → `{ result, booking? }`. Writes a `BoardingScan` for every attempt.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/transport/__tests__/booking.board.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Booking } from '@models/transport/booking.model';
import { BoardingScan } from '@models/transport/boardingScan.model';
import { SeatScheme } from '@interfaces/transport.interface';
import { BookingStatus, BoardingScanResult } from '@interfaces/booking.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function sellOne() {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 4, seatScheme: SeatScheme.SEQUENTIAL });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  const { booking } = await BookingService.sellSeat({
    tripId: trip._id.toString(), seatNumber: '1', passengerName: 'T', passengerPhone: '76707421',
    paymentMethod: PaymentMethod.CASH, soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator',
  });
  return { trip, booking, scannedBy: new mongoose.Types.ObjectId().toString() };
}

describe('BookingService.board', () => {
  it('SUCCESS on first scan, marks BOARDED, writes a scan', async () => {
    const { trip, booking, scannedBy } = await sellOne();
    const r = await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.SUCCESS);
    const fresh = await Booking.findById(booking._id);
    expect(fresh!.status).toBe(BookingStatus.BOARDED);
    expect(await BoardingScan.countDocuments({ bookingId: booking._id })).toBe(1);
  });

  it('ALREADY_BOARDED on the second scan', async () => {
    const { trip, booking, scannedBy } = await sellOne();
    await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    const r = await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.ALREADY_BOARDED);
  });

  it('WRONG_TRIP when the QR belongs to a different trip', async () => {
    const { booking, scannedBy } = await sellOne();
    const r = await BookingService.board({ qrCode: booking.qrCode, tripId: new mongoose.Types.ObjectId().toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.WRONG_TRIP);
  });

  it('INVALID for an unknown QR', async () => {
    const { trip, scannedBy } = await sellOne();
    const r = await BookingService.board({ qrCode: 'ZZZZ9999', tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.INVALID);
  });

  it('CANCELLED_BOOKING for a cancelled booking', async () => {
    const { trip, booking, scannedBy } = await sellOne();
    await Booking.updateOne({ _id: booking._id }, { $set: { status: BookingStatus.CANCELLED } });
    const r = await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.CANCELLED_BOOKING);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/booking.board.test.ts`
Expected: FAIL — `BookingService.board is not a function`.

- [ ] **Step 3: Add `board` to `BookingService`**

Add imports at the top of `booking.service.ts`: `import { BoardingScan } from '@models/transport/boardingScan.model';` and add `BoardingScanResult` to the existing `@interfaces/booking.interface` import. Then add inside the class:

```typescript
  static async board(p: {
    qrCode: string;
    tripId: string;
    scannedBy: string;
    scannedByType: 'Vendor' | 'VendorSubUser' | 'ResellerOperator';
  }): Promise<{ result: BoardingScanResult; booking?: IBooking }> {
    const booking = await Booking.findOne({ qrCode: p.qrCode.trim().toUpperCase() });

    const writeScan = async (result: BoardingScanResult, bookingId?: mongoose.Types.ObjectId, vendorId?: mongoose.Types.ObjectId) => {
      await BoardingScan.create({
        bookingId,
        tripId: p.tripId,
        vendorId: vendorId ?? (booking?.vendorId),
        scannedBy: p.scannedBy,
        scannedByType: p.scannedByType,
        result,
      });
    };

    if (!booking) {
      // No vendor context for an unknown QR — record against the trip only.
      const trip = await Trip.findById(p.tripId).select('vendorId');
      await BoardingScan.create({ tripId: p.tripId, vendorId: trip?.vendorId, scannedBy: p.scannedBy, scannedByType: p.scannedByType, result: BoardingScanResult.INVALID });
      return { result: BoardingScanResult.INVALID };
    }
    if (booking.tripId.toString() !== p.tripId) {
      await writeScan(BoardingScanResult.WRONG_TRIP, booking._id, booking.vendorId);
      return { result: BoardingScanResult.WRONG_TRIP, booking };
    }
    if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.REFUNDED) {
      await writeScan(BoardingScanResult.CANCELLED_BOOKING, booking._id, booking.vendorId);
      return { result: BoardingScanResult.CANCELLED_BOOKING, booking };
    }
    if (booking.status === BookingStatus.BOARDED) {
      await writeScan(BoardingScanResult.ALREADY_BOARDED, booking._id, booking.vendorId);
      return { result: BoardingScanResult.ALREADY_BOARDED, booking };
    }

    // Atomic transition to BOARDED so two concurrent scans can't both "succeed".
    const boarded = await Booking.findOneAndUpdate(
      { _id: booking._id, status: BookingStatus.CONFIRMED },
      { $set: { status: BookingStatus.BOARDED, boardedAt: new Date(), boardedBy: p.scannedBy } },
      { new: true },
    );
    if (!boarded) {
      await writeScan(BoardingScanResult.ALREADY_BOARDED, booking._id, booking.vendorId);
      return { result: BoardingScanResult.ALREADY_BOARDED, booking };
    }
    await writeScan(BoardingScanResult.SUCCESS, booking._id, booking.vendorId);
    return { result: BoardingScanResult.SUCCESS, booking: boarded };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/booking.board.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/booking.service.ts src/services/transport/__tests__/booking.board.test.ts
git commit -m "feat(transport): BookingService.board (boarding scan)"
```

---

### Task 6: POS transport validators + controller + routes + mount

**Files:**
- Create: `src/validators/transportPos.validator.ts`
- Create: `src/controllers/transportPos.controller.ts`
- Create: `src/routes/transportPos.route.ts`
- Modify: `src/app.ts`
- Test: `src/services/transport/__tests__/pos.smoke.test.ts`

**Interfaces:**
- Consumes: `TripService.listSellable`/`getWithAvailability` (SP1a), `BookingService.sellSeat`/`board`; `authenticateReseller`, `requireResellerPermission`, `ResellerPermission`; `ApiResponseUtil`, `failWithHttpError`. Reads `(req as any).reseller.{operatorId, resellerId, hubId}`.
- Produces: `transportPosRoutes` mounted at `/api/reseller/transport`.

- [ ] **Step 1: Write the failing end-to-end service test (the flow the POS controller drives)**

```typescript
// src/services/transport/__tests__/pos.smoke.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { TripService } from '@services/transport/trip.service';
import { BookingService } from '@services/transport/booking.service';
import { SeatScheme } from '@interfaces/transport.interface';
import { BoardingScanResult } from '@interfaces/booking.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('POS flow: browse sellable trips → sell a seat → board it', async () => {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'MZ→MB', originCity: 'Manzini', destinationCity: 'Mbabane', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 15, seatScheme: SeatScheme.SEQUENTIAL });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });

  const sellable = await TripService.listSellable({});
  expect(sellable.map((t) => t._id.toString())).toContain(trip._id.toString());

  const { booking } = await BookingService.sellSeat({
    tripId: trip._id.toString(), seatNumber: '1', passengerName: 'T', passengerPhone: '76707421',
    paymentMethod: PaymentMethod.CASH, soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator',
  });

  const scan = await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy: new mongoose.Types.ObjectId().toString(), scannedByType: 'ResellerOperator' });
  expect(scan.result).toBe(BoardingScanResult.SUCCESS);
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx jest src/services/transport/__tests__/pos.smoke.test.ts`
Expected: PASS if Tasks 4–5 are complete (this guards the contract the POS controller exposes). If it fails, fix the service first.

- [ ] **Step 3: Write the POS validators**

```typescript
// src/validators/transportPos.validator.ts
import Joi from 'joi';
import { PaymentMethod } from '@interfaces/ticket.interface';

const HEX24 = /^[0-9a-fA-F]{24}$/;

export const listTripsQuerySchema = Joi.object({
  routeId: Joi.string().regex(HEX24).optional(),
  vendorId: Joi.string().regex(HEX24).optional(),
});

export const sellSeatSchema = Joi.object({
  tripId: Joi.string().regex(HEX24).required(),
  seatNumber: Joi.string().trim().optional(),
  passengerName: Joi.string().trim().max(100).required(),
  passengerPhone: Joi.string().trim().max(20).required(),
  paymentMethod: Joi.string().valid(PaymentMethod.CASH, PaymentMethod.KESHLESS_WALLET).required()
    .messages({ 'any.only': 'Only cash and Keshless wallet are supported for bus bookings right now' }),
  keshlessCardNumber: Joi.when('paymentMethod', { is: PaymentMethod.KESHLESS_WALLET, then: Joi.string().length(8).pattern(/^[A-Z0-9]+$/).required(), otherwise: Joi.optional() }),
  keshlessPin: Joi.when('paymentMethod', { is: PaymentMethod.KESHLESS_WALLET, then: Joi.string().length(4).pattern(/^[0-9]{4}$/).optional(), otherwise: Joi.optional() }),
});

export const boardSchema = Joi.object({
  qrCode: Joi.string().trim().required(),
  tripId: Joi.string().regex(HEX24).required(),
});
```

- [ ] **Step 4: Write the POS controller**

```typescript
// src/controllers/transportPos.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { TripService } from '@services/transport/trip.service';
import { BookingService } from '@services/transport/booking.service';
import { Reseller } from '@models/reseller.model';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { listTripsQuerySchema, sellSeatSchema, boardSchema } from '@validators/transportPos.validator';

function reseller(req: Request): { operatorId: string; resellerId: string; hubId?: string } | undefined {
  return (req as any).reseller;
}

export class TransportPosController {
  static async listTrips(req: Request, res: Response): Promise<any> {
    try {
      if (!reseller(req)) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const { error, value } = listTripsQuerySchema.validate(req.query);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      // Resellers browse trips platform-wide (mirrors reseller event browsing).
      return ApiResponseUtil.success(res, await TripService.listSellable({ vendorId: value.vendorId, routeId: value.routeId }));
    } catch (e) { return failWithHttpError(res, e, 'Failed to list trips'); }
  }

  static async getTrip(req: Request, res: Response): Promise<any> {
    try {
      if (!reseller(req)) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      // isSuperAdmin=true → not vendor-scoped, so a reseller can view any vendor's trip.
      return ApiResponseUtil.success(res, await TripService.getWithAvailability('', String(req.params['id']), true));
    } catch (e) { return failWithHttpError(res, e, 'Failed to load trip'); }
  }

  static async sell(req: Request, res: Response): Promise<any> {
    try {
      const r = reseller(req);
      if (!r) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const { error, value } = sellSeatSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);

      const resellerDoc = await Reseller.findById(r.resellerId).select('commissionPercent');
      const cfg = await PaymentConfigService.get();
      const commissionPercent = resellerDoc?.commissionPercent ?? cfg.defaultResellerCommissionPercent;

      const result = await BookingService.sellSeat({
        ...value,
        soldBy: r.operatorId,
        soldByType: 'reseller-operator',
        resellerId: r.resellerId,
        hubId: r.hubId,
        resellerCommissionPercent: commissionPercent,
      });
      return ApiResponseUtil.created(res, result, 'Booking sold');
    } catch (e) { return failWithHttpError(res, e, 'Failed to sell seat'); }
  }

  static async board(req: Request, res: Response): Promise<any> {
    try {
      const r = reseller(req);
      if (!r) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const { error, value } = boardSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      const result = await BookingService.board({ qrCode: value.qrCode, tripId: value.tripId, scannedBy: r.operatorId, scannedByType: 'ResellerOperator' });
      return ApiResponseUtil.success(res, result, 'Scan recorded');
    } catch (e) { return failWithHttpError(res, e, 'Failed to record boarding scan'); }
  }
}
```

- [ ] **Step 5: Write the POS router**

```typescript
// src/routes/transportPos.route.ts
import { Router } from 'express';
import { authenticateReseller, requireResellerPermission } from '@middleware/resellerAuth.middleware';
import { ResellerPermission } from '@interfaces/resellerPermission.interface';
import { TransportPosController } from '@controllers/transportPos.controller';

// POS / conductor bus selling + boarding. Mounted at /api/reseller/transport
// (a distinct path under the reseller namespace; not shadowed by /api/reseller).
const router = Router();

router.use(authenticateReseller);

router.get('/trips', requireResellerPermission(ResellerPermission.VIEW_EVENTS), TransportPosController.listTrips);
router.get('/trips/:id', requireResellerPermission(ResellerPermission.VIEW_EVENTS), TransportPosController.getTrip);
router.post('/bookings', requireResellerPermission(ResellerPermission.SELL_TICKETS), TransportPosController.sell);
router.post('/board', requireResellerPermission(ResellerPermission.SELL_TICKETS), TransportPosController.board);

export default router;
```

- [ ] **Step 6: Mount in `app.ts`**

Add the import near the other `@routes/*` imports:

```typescript
import transportPosRoutes from '@routes/transportPos.route';
```

Add the mount in the `app.use(...)` block, right after `app.use('/api/reseller', resellerRoutes);` (more-specific path can also sit before — either works since Express matches `/api/reseller/transport` to this router first when registered before the broad one; to be safe, register it BEFORE `/api/reseller`):

```typescript
app.use('/api/reseller/transport', transportPosRoutes); // POS bus selling + boarding
```

(If placing before the broad `/api/reseller` mount, add it there; otherwise Express still routes correctly because `transportPosRoutes` only defines `/trips`, `/bookings`, `/board` sub-paths.)

- [ ] **Step 7: Typecheck + run the full transport suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx jest src/services/transport src/models/transport`
Expected: all transport tests PASS.

- [ ] **Step 8: Manual smoke (recommended)**

Start `npm run dev`; get a reseller-operator JWT (login via `/api/reseller/auth/login`). With an SP1a-created trip:

```bash
curl -s http://localhost:PORT/api/reseller/transport/trips -H "Authorization: Bearer $RES_JWT"
curl -sX POST http://localhost:PORT/api/reseller/transport/bookings -H "Authorization: Bearer $RES_JWT" -H 'Content-Type: application/json' \
  -d '{"tripId":"<id>","seatNumber":"1","passengerName":"Thabo","passengerPhone":"76707421","paymentMethod":"cash"}'
# use the returned booking.qrCode:
curl -sX POST http://localhost:PORT/api/reseller/transport/board -H "Authorization: Bearer $RES_JWT" -H 'Content-Type: application/json' \
  -d '{"qrCode":"<qr>","tripId":"<id>"}'
```
Expected: sell returns 201 with `booking.status: "confirmed"` + a `qrCode`; board returns `result: "success"`; a second board returns `already_boarded`.

- [ ] **Step 9: Commit**

```bash
git add src/validators/transportPos.validator.ts src/controllers/transportPos.controller.ts src/routes/transportPos.route.ts src/app.ts src/services/transport/__tests__/pos.smoke.test.ts
git commit -m "feat(transport): POS bus selling + boarding endpoints"
```

---

## Non-goals (SP1b) → SP1c and beyond

- **Async payments (MoMo, card):** SP1c. It mirrors the events async path: `BookingService.initiateMomoBooking` / `initiateCardBooking` (claim seat + `Booking(PENDING)` + `BookingSale(PENDING)` + `momoReferenceId`/`peachPaymentId` + `reservationExpiresAt`), `finalizeMomoBooking(ref)` / `finalizeCardBooking(id)` (idempotent claim → confirm booking → SMS, or release seat on fail — twins of `TicketService.finalize*`), a **webhook dispatch** (in `momo.controller`/`card.controller`, after the ticket finalizer throws "not found", fall through to the booking finalizer), a **card reconcile sweep** (`reconcilePendingCardBookings`, twin of `reconcilePendingCardSales`, added to `backgroundTasks.ts`), and a **booking expiry sweep** (bookings have no `ReservationService`, so a `sweepExpiredBookings` must flip PENDING→FAILED and release the seat/`soldCount` after `reservationExpiresAt` — MoMo has no reconcile today, so this is the MoMo backstop too).
- **Refund/cancel** a confirmed booking (releases seat, reverses payout).
- **Return tickets** (`BookingGroup`) — Phase 4. `BookingSale.bookingIds` is already an array so a return is one sale over two bookings without a schema change.
- **SMS booking confirmation** — wire `SmsService` into `sellSeat`/`finalize*` (best-effort, like ticket confirmations) in SP1c.
- **`Vendor.businessType += 'transport'`** — SP3 (dashboard self-identification).
- **Payout aggregation** — extend `OrganizerPayout` close to include `BookingSale` (the accepted "two payout paths" cost) — a follow-up.

## Self-Review

**Spec coverage (SP1b = Phase-1 selling half, sync portion):**
- `Booking` / `BookingSale` / `BoardingScan` dedicated collections → Tasks 1–3. ✓
- `booking.service.sellSeat` with atomic seat-claim (seat-mapped) + capacity-guarded claim (PASSENGER_COUNT), reused payment processors + `computeSaleEconomics`, rollback on failure → Task 4. ✓
- `board()` writing a `BoardingScan` with the full result matrix → Task 5. ✓
- POS endpoints (`/pos/transport` → house-style `/api/reseller/transport`: list trips, get trip, sell, board) → Task 6. ✓
- Async (MoMo/card) finalizers + webhook dispatch (§5.8) → explicitly deferred to SP1c (documented above). ✓ (scoping decision, not a gap)
- Fail-loud on payment failure (rollback + throw) → Task 4 test "payment failure rollback". ✓

**Placeholder scan:** no TBD/TODO; every step has real code or an exact command. ✓

**Type consistency:** `BookingStatus`/`BoardingScanResult`/`IBooking`/`IBookingSale`/`IBoardingScan` defined once (Task 1) and imported everywhere. `BookingService.sellSeat` return `{ booking, sale }` and `board` return `{ result, booking? }` match their Task-6 controller callers. `SellSeatParams.soldByType` union (`'vendor'|'sub-user'|'reseller-operator'`) matches `SOLD_BY_MAP`. Reused `PaymentMethod`/`PaymentStatus`/`SalesChannel` come from `@interfaces/ticket.interface` (not redefined). ✓

**Scope check:** SP1b is one coherent subsystem (sync selling + boarding) producing testable, shippable software: a conductor sells + boards a cash bus ticket on the POS. Async money is SP1c. ✓
