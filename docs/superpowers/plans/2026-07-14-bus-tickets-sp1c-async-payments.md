# Bus Tickets — SP1c: Async Payments (MoMo + Card) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a conductor take **MTN MoMo** and **Peach card** payment for a bus seat on the POS — the asynchronous payment path — completing the payment matrix (SP1b already does cash + Keshless wallet synchronously).

**Architecture:** Mirror the events async pattern (`TicketService.initiate*`/`finalize*` in `ticket.service.ts`) for bookings: `initiateMomoBooking`/`initiateCardBooking` atomically claim the seat, create a **PENDING** `Booking` + `BookingSale` with a `reservationExpiresAt` hold and the provider reference, and kick off the charge; `finalizeMomoBooking`/`finalizeCardBooking` (idempotent, amount-guarded, atomic-claim) confirm the booking on success or release the seat on failure. The MoMo/card webhook + return controllers dispatch to the booking finalizers by trying the ticket finalizer first and falling through on "not found". Two background sweeps — `reconcilePendingCardBookings` (card backstop) and `sweepExpiredBookings` (releases seats for abandoned PENDING bookings; the MoMo backstop, since MoMo has no reconcile) — run on the existing interval. New POS endpoints initiate an async booking and poll its status.

**Tech Stack:** TypeScript, Express, Mongoose 8, Joi, Jest + ts-jest + mongodb-memory-server. Reuses `MtnMomoClient`/`PeachClient` (`@services/payments/*`), `computeSaleEconomics`, `PaymentConfigService`, `normalizePhone`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-13-bus-tickets-transport-vertical-design.md` (§5.8 payment webhook dispatch). **Depends on SP1a + SP1b** (this branch, HEAD `4053d7a`): imports `Trip`/`Seat`, `Booking`/`BookingSale`, `BookingService` (with `sellSeat`/`board`), `computeSaleEconomics`, `PaymentConfigService`.
- **DRY / reuse:** reuse `MtnMomoClient` (`requestToPay`/`getStatus`) and `PeachClient` (`createPayment`/`getPaymentStatus`/`classifyResultCode`) exactly as `ticket.service.ts` does — do NOT reimplement gateway calls. Reuse `computeSaleEconomics`, `PaymentConfigService`, `normalizePhone`, `HttpError`. Do NOT touch `Event`/`Ticket`/`TicketSale`/`TicketScan` MODELS; you WILL extend the shared `momo.controller.ts`/`card.controller.ts` + `backgroundTasks.ts` additively.
- **Fail loud, never silent-fallback:** on gateway/amount-guard failure release the seat and mark FAILED; never confirm a booking without a verified successful payment of the exact amount+currency.
- **Idempotency + atomic claim:** every finalize is idempotent (not-PENDING sale → return current status) and uses an atomic `BookingSale.findOneAndUpdate({ _id, paymentStatus: PENDING }, { paymentStatus: COMPLETED })` claim so a concurrent webhook + poll can't double-confirm. Mirror `finalizeMomoSale`/`finalizeCardSale`.
- **Amount guard:** before confirming, the gateway-reported amount must equal `sale.amountCharged ?? sale.totalAmount` and currency must equal `MTN_MOMO_CURRENCY` (default `SZL`) / `CARD_CURRENCY` (default `ZAR`). Mismatch → release + FAILED. Exactly as the ticket finalizers.
- **Money invariant:** POS bus sales stay at face — `serviceFeeAmount: 0`, `amountCharged: fare`. (No online service fee; async here is still a POS/conductor sale.)
- **Seat release on failure/expiry:** seat-mapped → `Seat.updateOne({ tripId, seatNumber, bookingId }, { isBooked:false, $unset bookingId })`; PASSENGER_COUNT → `Trip.updateOne({ _id }, { $inc: { soldCount: -1 } })`. Guarded so it only releases a seat still tied to this booking.
- **Test harness:** tests in `src/**/__tests__/*.test.ts`; DB helper from `src/__tests__/helpers/mongo`. Mock gateway CLIENTS with `jest.spyOn` on the imported class prototype (NOT `jest.resetModules`/`jest.doMock` — that breaks mongoose in this repo; use the pattern from `booking.sell.test.ts`). Run one file with `npx jest <path>`.
- **Branch:** continues on `feat/bus-tickets-transport`.

## File Structure

**Modify:**
- `src/models/transport/bookingSale.model.ts` — add index `{ paymentStatus:1, paymentMethod:1 }` (for the reconcile sweep query).
- `src/services/transport/booking.service.ts` — add static `momoClient`/`peachClient`, `MOMO_TTL_MS`/`CARD_TTL_MS`; add `initiateMomoBooking`, `finalizeMomoBooking`, `initiateCardBooking`, `finalizeCardBooking`, `reconcilePendingCardBookings`, `sweepExpiredBookings`, and a private `releaseBookingClaim` helper. Refactor the existing `sellSeat` claim/release into shared helpers where clean (do NOT change sellSeat behavior).
- `src/controllers/momo.controller.ts` — after `TicketService.finalizeMomoSale` reports "not found", fall through to `BookingService.finalizeMomoBooking`.
- `src/controllers/card.controller.ts` — same fall-through to `BookingService.finalizeCardBooking` in both `webhook` and `returnRedirect`.
- `src/tasks/backgroundTasks.ts` — add intervals for `reconcilePendingCardBookings` + `sweepExpiredBookings`.
- `src/controllers/transportPos.controller.ts` + `src/routes/transportPos.route.ts` + `src/validators/transportPos.validator.ts` — add async initiate + status-poll endpoints.

**Create:** test files alongside each.

---

### Task 1: `initiateMomoBooking`

**Files:**
- Modify: `src/services/transport/booking.service.ts`
- Test: `src/services/transport/__tests__/booking.momo.test.ts`

**Interfaces:**
- Produces: `BookingService.initiateMomoBooking(params) → { referenceId, saleId, expiresAt }` and a private `claimSeat`/`releaseBookingClaim` extraction reused by initiate + finalize. `InitiateBookingParams { tripId, seatNumber?, passengerName, passengerPhone, momoPhone, soldBy, soldByType, resellerId?, hubId? }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/transport/__tests__/booking.momo.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';

const momo = { isConfigured: jest.fn(), requestToPay: jest.fn(), getStatus: jest.fn() };
jest.spyOn(MtnMomoClient.prototype, 'isConfigured').mockImplementation(() => momo.isConfigured());
jest.spyOn(MtnMomoClient.prototype, 'requestToPay').mockImplementation((...a: any[]) => momo.requestToPay(...a));
jest.spyOn(MtnMomoClient.prototype, 'getStatus').mockImplementation((...a: any[]) => momo.getStatus(...a));

import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Seat } from '@models/transport/seat.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { SeatScheme } from '@interfaces/transport.interface';
import { BookingStatus } from '@interfaces/booking.interface';
import { PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(async () => { await clearTestDb(); momo.isConfigured.mockReset(); momo.requestToPay.mockReset(); momo.getStatus.mockReset(); });
afterAll(disconnectTestDb);

async function seedTrip(scheme = SeatScheme.SEQUENTIAL, totalSeats = 4) {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${scheme}-${totalSeats}`, totalSeats, seatScheme: scheme });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  return { vendorId, trip };
}
const args = (extra: any) => ({ passengerName: 'T', passengerPhone: '76707421', momoPhone: '76707421', soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator' as const, ...extra });

describe('BookingService.initiateMomoBooking', () => {
  it('claims the seat + creates a PENDING booking & sale, no confirmation yet', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'R1' });
    const { trip } = await seedTrip();
    const res = await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }));
    expect(res.referenceId).toBe('R1');
    expect(res.expiresAt).toBeInstanceOf(Date);
    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(true);
    const sale = await BookingSale.findOne({ momoReferenceId: 'R1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.PENDING);
  });

  it('releases the seat + marks FAILED when requestToPay throws', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockRejectedValue(new Error('MoMo down'));
    const { trip } = await seedTrip();
    await expect(BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }))).rejects.toThrow('MoMo down');
    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(false);
    const sale = await BookingSale.findOne({});
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('409 when the seat is already taken', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'R2' });
    const { trip } = await seedTrip();
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }));
    await expect(BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('throws when MoMo is not configured', async () => {
    momo.isConfigured.mockReturnValue(false);
    const { trip } = await seedTrip();
    await expect(BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/booking.momo.test.ts`
Expected: FAIL — `BookingService.initiateMomoBooking is not a function`.

- [ ] **Step 3: Add the shared claim/release helpers + `initiateMomoBooking` to `BookingService`**

Add these imports to `booking.service.ts` if missing: `import { MtnMomoClient } from '@services/payments/mtnMomo.client';`, `import { IBooking } from '@interfaces/booking.interface';` (already present). Add near the class top:

```typescript
  private static momoClient = new MtnMomoClient();
  private static MOMO_TTL_MS = 5 * 60_000;

  /** Atomically claim capacity for a booking; throws HttpError(409) if unavailable. Shared by sellSeat + async initiate. */
  private static async claimCapacity(trip: any, isSeatMapped: boolean, seatNumber: string | undefined, bookingId: any): Promise<void> {
    if (isSeatMapped) {
      if (!seatNumber) throw new HttpError(400, 'seatNumber is required for this vehicle');
      const seat = await Seat.findOneAndUpdate(
        { tripId: trip._id, seatNumber, isBooked: false, isReserved: false },
        { $set: { isBooked: true, bookingId } }, { new: true },
      );
      if (!seat) throw new HttpError(409, 'Seat is already booked or reserved');
    } else {
      const claimed = await Trip.findOneAndUpdate(
        { _id: trip._id, status: { $in: [TripStatus.SCHEDULED, TripStatus.BOARDING] }, $expr: { $lt: [{ $add: ['$soldCount', '$reservedCount'] }, '$totalSeats'] } },
        { $inc: { soldCount: 1 } }, { new: true },
      );
      if (!claimed) throw new HttpError(409, 'Trip is fully booked');
    }
  }

  /** Release a claim tied to a specific booking (seat-mapped: free the seat; passenger-count: decrement soldCount). */
  private static async releaseBookingClaim(booking: IBooking, isSeatMapped: boolean): Promise<void> {
    if (isSeatMapped) {
      await Seat.updateOne({ tripId: booking.tripId, seatNumber: booking.seatNumber, bookingId: booking._id }, { $set: { isBooked: false }, $unset: { bookingId: '' } });
    } else {
      await Trip.updateOne({ _id: booking.tripId }, { $inc: { soldCount: -1 } });
    }
  }
```

Then add `initiateMomoBooking`:

```typescript
  static async initiateMomoBooking(p: {
    tripId: string; seatNumber?: string; passengerName: string; passengerPhone: string; momoPhone: string;
    soldBy: string; soldByType: 'vendor' | 'sub-user' | 'reseller-operator'; resellerId?: string; hubId?: string;
  }): Promise<{ referenceId: string; saleId: string; expiresAt: Date }> {
    if (!this.momoClient.isConfigured()) throw new HttpError(503, 'MTN MoMo is not available');

    const trip = await Trip.findById(p.tripId);
    if (!trip) throw new HttpError(404, 'Trip not found');
    if (![TripStatus.SCHEDULED, TripStatus.BOARDING].includes(trip.status)) throw new HttpError(422, 'Trip is not open for sale');
    const isSeatMapped = trip.seatScheme !== SeatScheme.PASSENGER_COUNT;

    const route = await Route.findById(trip.routeId).select('farePerSeat');
    if (!route) throw new HttpError(404, 'Route not found');
    const fare = route.farePerSeat;

    const cfg = await PaymentConfigService.get();
    if (!cfg.mtnMomoEnabled) throw new HttpError(400, 'MoMo is not enabled');
    let resolvedCommission = cfg.defaultResellerCommissionPercent;
    if (p.resellerId) {
      const reseller = await Reseller.findById(p.resellerId).select('status isActive commissionPercent');
      if (!reseller) throw new HttpError(404, 'Reseller not found');
      if (reseller.status === 'suspended' || reseller.isActive === false) throw new HttpError(403, 'Reseller account is suspended');
      resolvedCommission = reseller.commissionPercent ?? cfg.defaultResellerCommissionPercent;
    }
    const mappedSoldByType = SOLD_BY_MAP[p.soldByType];
    const econ = computeSaleEconomics({ faceAmount: fare, paymentMethod: PaymentMethod.MTN_MOMO as any, soldByType: mappedSoldByType, resellerCommissionPercent: resolvedCommission, platformFeePercent: cfg.platformFeePercent });

    const booking = new Booking({ tripId: trip._id, vendorId: trip.vendorId, passengerName: p.passengerName, passengerPhone: normalizePhone(p.passengerPhone), seatNumber: isSeatMapped ? p.seatNumber : undefined, fareAmount: fare, platformFee: econ.platformFeeAmount, totalAmount: fare, status: BookingStatus.PENDING });
    await this.claimCapacity(trip, isSeatMapped, p.seatNumber, booking._id);

    const expiresAt = new Date(Date.now() + this.MOMO_TTL_MS);
    let sale;
    try {
      await booking.save();
      sale = await BookingSale.create({
        tripId: trip._id, vendorId: trip.vendorId, bookingIds: [booking._id], quantity: 1,
        customerName: p.passengerName, customerPhone: booking.passengerPhone, totalAmount: fare,
        paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.PENDING, reservationExpiresAt: expiresAt,
        soldBy: p.soldBy, soldByType: mappedSoldByType, channel: deriveChannel(mappedSoldByType),
        ...(p.resellerId ? { resellerId: p.resellerId } : {}), ...(p.hubId ? { hubId: p.hubId } : {}),
        faceAmount: fare, serviceFeeAmount: 0, amountCharged: fare,
        resellerCommissionPercent: econ.resellerCommissionPercent, resellerCommissionAmount: econ.resellerCommissionAmount,
        platformFeePercent: econ.platformFeePercent, platformFeeAmount: econ.platformFeeAmount,
        organizerProceeds: econ.organizerProceeds, fundsCustody: econ.fundsCustody, soldAt: new Date(),
      });
      booking.saleId = sale._id as any;
      await booking.save();
    } catch (err) {
      await this.releaseBookingClaim(booking, isSeatMapped);
      throw err;
    }

    try {
      const currency = process.env['MTN_MOMO_CURRENCY'] || 'SZL';
      const { referenceId } = await this.momoClient.requestToPay({ amount: fare, currency, payerMsisdn: normalizeMsisdn(p.momoPhone), externalId: sale.saleRef, payerMessage: `Bus seat ${p.seatNumber ?? 'GA'}` });
      sale.momoReferenceId = referenceId;
      await sale.save();
      return { referenceId, saleId: sale._id.toString(), expiresAt };
    } catch (err) {
      await this.releaseBookingClaim(booking, isSeatMapped);
      booking.status = BookingStatus.CANCELLED; await booking.save();
      sale.paymentStatus = PaymentStatus.FAILED; await sale.save();
      throw err;
    }
  }
```

Add a module-level MSISDN normalizer near the top of the file (mirror the events MoMo phone handling — 8-digit local → `268XXXXXXXX`, strip `+`):

```typescript
/** MTN wants a bare international MSISDN (no +). Local 8-digit → 268XXXXXXXX. */
function normalizeMsisdn(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length === 8) return `268${digits}`;
  return digits.replace(/^0+/, '');
}
```

Also add these imports if not present: `Reseller` (`@models/reseller.model` — already added in SP1b fix), `computeSaleEconomics`, `deriveChannel`, `SOLD_BY_MAP`, `PaymentMethod`, `PaymentStatus`, `SalesChannel`, `TripStatus`, `SeatScheme`, `normalizePhone`, `PaymentConfigService`, `Route`, `Trip`, `Seat`, `Booking`, `BookingSale`, `HttpError`, `BookingStatus` — most already imported from SP1b.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/booking.momo.test.ts`
Expected: PASS (4 tests). Refactor `sellSeat` to call `this.claimCapacity(...)`/`this.releaseBookingClaim(...)` ONLY if it stays behaviorally identical and its 14 tests still pass (`npx jest src/services/transport/__tests__/booking.sell.test.ts`); otherwise leave `sellSeat` untouched.

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/booking.service.ts src/services/transport/__tests__/booking.momo.test.ts
git commit -m "feat(transport): initiateMomoBooking (async MoMo — PENDING booking + requestToPay)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `finalizeMomoBooking`

**Files:**
- Modify: `src/services/transport/booking.service.ts`
- Test: `src/services/transport/__tests__/booking.momo.test.ts` (append)

**Interfaces:**
- Consumes: `initiateMomoBooking` (Task 1) for test setup; `momoClient.getStatus`.
- Produces: `BookingService.finalizeMomoBooking(referenceId) → { status: 'completed'|'failed'|'pending'; reason? }`; `getMomoBookingSaleByReference(referenceId)`.

- [ ] **Step 1: Write the failing test** (append to `booking.momo.test.ts`)

```typescript
describe('BookingService.finalizeMomoBooking', () => {
  async function initiate(seatNumber = '1', ref = 'R1') {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: ref });
    const { trip } = await seedTrip();
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber }));
    return { trip };
  }

  it('confirms the booking on SUCCESSFUL with matching amount (idempotent)', async () => {
    const { trip } = await initiate('1', 'R1');
    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '35', currency: 'SZL' } });
    const first = await BookingService.finalizeMomoBooking('R1');
    expect(first.status).toBe('completed');
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    const sale = await BookingSale.findOne({ momoReferenceId: 'R1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    // idempotent
    expect((await BookingService.finalizeMomoBooking('R1')).status).toBe('completed');
    expect(await Booking.countDocuments({ tripId: trip._id })).toBe(1);
  });

  it('releases the seat + FAILED on MTN FAILED', async () => {
    const { trip } = await initiate('1', 'R2');
    momo.getStatus.mockResolvedValue({ status: 'FAILED', raw: {} });
    expect((await BookingService.finalizeMomoBooking('R2')).status).toBe('failed');
    expect((await Seat.findOne({ tripId: trip._id, seatNumber: '1' }))!.isBooked).toBe(false);
    expect((await BookingSale.findOne({ momoReferenceId: 'R2' }))!.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('refuses to confirm on amount mismatch → FAILED + seat released', async () => {
    const { trip } = await initiate('1', 'R3');
    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '5', currency: 'SZL' } });
    expect((await BookingService.finalizeMomoBooking('R3')).status).toBe('failed');
    expect((await Seat.findOne({ tripId: trip._id, seatNumber: '1' }))!.isBooked).toBe(false);
    expect((await Booking.findOne({ tripId: trip._id }))!.status).not.toBe(BookingStatus.CONFIRMED);
  });

  it('returns pending while MTN is PENDING', async () => {
    await initiate('1', 'R4');
    momo.getStatus.mockResolvedValue({ status: 'PENDING', raw: {} });
    expect((await BookingService.finalizeMomoBooking('R4')).status).toBe('pending');
    expect((await BookingSale.findOne({ momoReferenceId: 'R4' }))!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('throws when no sale matches the reference', async () => {
    await expect(BookingService.finalizeMomoBooking('NOPE')).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/booking.momo.test.ts -t finalizeMomoBooking`
Expected: FAIL — `finalizeMomoBooking is not a function`.

- [ ] **Step 3: Add `finalizeMomoBooking` + `getMomoBookingSaleByReference`** (mirror `TicketService.finalizeMomoSale`)

```typescript
  static async getMomoBookingSaleByReference(referenceId: string) {
    return BookingSale.findOne({ momoReferenceId: referenceId });
  }

  static async finalizeMomoBooking(referenceId: string): Promise<{ status: 'completed' | 'failed' | 'pending'; reason?: string }> {
    const sale = await BookingSale.findOne({ momoReferenceId: referenceId });
    if (!sale) throw new HttpError(404, 'Booking sale not found for reference');
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      return sale.paymentStatus === PaymentStatus.COMPLETED ? { status: 'completed' } : { status: 'failed', reason: sale.momoFailureReason };
    }

    const booking = await Booking.findById(sale.bookingIds[0]);
    if (!booking) throw new HttpError(404, 'Booking not found for sale');
    const trip = await Trip.findById(booking.tripId).select('seatScheme');
    const isSeatMapped = trip?.seatScheme !== SeatScheme.PASSENGER_COUNT;

    const { status, raw } = await this.momoClient.getStatus(referenceId);
    if (status === 'PENDING') return { status: 'pending' };

    if (status === 'FAILED') {
      const reason = typeof raw?.reason === 'string' ? raw.reason : undefined;
      await this.releaseBookingClaim(booking, isSeatMapped);
      booking.status = BookingStatus.CANCELLED; await booking.save();
      sale.paymentStatus = PaymentStatus.FAILED; if (reason) sale.momoFailureReason = reason; await sale.save();
      return { status: 'failed', reason };
    }

    // SUCCESSFUL — amount + currency guard before confirming
    const expectedCurrency = process.env['MTN_MOMO_CURRENCY'] || 'SZL';
    const expectedAmount = sale.amountCharged ?? sale.totalAmount;
    const confirmedAmount = Number(raw?.amount);
    if (!Number.isFinite(confirmedAmount) || confirmedAmount !== expectedAmount || raw?.currency !== expectedCurrency) {
      await this.releaseBookingClaim(booking, isSeatMapped);
      booking.status = BookingStatus.CANCELLED; await booking.save();
      sale.paymentStatus = PaymentStatus.FAILED; sale.momoFailureReason = 'AMOUNT_MISMATCH'; await sale.save();
      return { status: 'failed', reason: 'AMOUNT_MISMATCH' };
    }

    // atomic claim — concurrent poll + callback can't double-confirm
    const claimed = await BookingSale.findOneAndUpdate({ _id: sale._id, paymentStatus: PaymentStatus.PENDING }, { $set: { paymentStatus: PaymentStatus.COMPLETED } }, { new: true });
    if (!claimed) return { status: 'completed' };
    booking.status = BookingStatus.CONFIRMED; await booking.save();
    return { status: 'completed' };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/booking.momo.test.ts`
Expected: PASS (all MoMo tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/booking.service.ts src/services/transport/__tests__/booking.momo.test.ts
git commit -m "feat(transport): finalizeMomoBooking (idempotent, amount-guarded, atomic claim)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `initiateCardBooking` + `finalizeCardBooking` (card twins)

**Files:**
- Modify: `src/services/transport/booking.service.ts`
- Test: `src/services/transport/__tests__/booking.card.test.ts`

**Interfaces:**
- Produces: `BookingService.initiateCardBooking(params) → { paymentId, redirectUrl?, saleId, expiresAt }`, `finalizeCardBooking(paymentId) → { status }`, `getCardBookingSaleByPaymentId(id)`. Uses `PeachClient.createPayment`/`getPaymentStatus` + `classifyResultCode`.

- [ ] **Step 1: Write the failing test** — mirror the MoMo test but spy on `PeachClient.prototype` (`isConfigured`, `createPayment` → `{ id, code, redirect }`, `getPaymentStatus` → `{ code, amount, currency }`), and keep `classifyResultCode` real (`jest.requireActual`). Assert: initiate creates PENDING sale with `peachPaymentId`, seat claimed; `finalizeCardBooking` confirms on a success code with matching amount/`CARD_CURRENCY` (default `ZAR`), releases on a rejected code, returns pending on a pending code, idempotent. (Structure identical to `booking.momo.test.ts`; use fare `35` and currency `ZAR`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/transport/__tests__/booking.card.test.ts`
Expected: FAIL — `initiateCardBooking is not a function`.

- [ ] **Step 3: Add card twins** — mirror Task 1/2 exactly, differences only: static `peachClient = new PeachClient()`, `CARD_TTL_MS = 15 * 60_000`; `initiateCardBooking` gates on `cfg.peachCardEnabled`, calls `peachClient.createPayment({ amount: fare, currency: process.env['CARD_CURRENCY']||'ZAR', merchantTransactionId: sale.saleRef, shopperResultUrl: process.env['CARD_RESULT_URL']||'', nonce: sale.saleRef })`, stores `sale.peachPaymentId = id`, returns `{ paymentId: id, redirectUrl: redirect?.url, saleId, expiresAt }`; `finalizeCardBooking(paymentId)` looks up by `peachPaymentId`, uses `classifyResultCode(code)` (`'pending'`→pending, `'rejected'`→release+FAILED, `'success'`→amount/currency guard→atomic claim→confirm). Add `getCardBookingSaleByPaymentId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/transport/__tests__/booking.card.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/transport/booking.service.ts src/services/transport/__tests__/booking.card.test.ts
git commit -m "feat(transport): initiate/finalizeCardBooking (Peach async twins)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `reconcilePendingCardBookings` + `sweepExpiredBookings` + wire into background tasks

**Files:**
- Modify: `src/services/transport/booking.service.ts`, `src/tasks/backgroundTasks.ts`, `src/models/transport/bookingSale.model.ts` (add `{ paymentStatus:1, paymentMethod:1 }` index)
- Test: `src/services/transport/__tests__/booking.sweep.test.ts`

**Interfaces:**
- Produces: `BookingService.reconcilePendingCardBookings(olderThanMs?) → number`, `sweepExpiredBookings() → number`.

- [ ] **Step 1: Write the failing test**

```typescript
// booking.sweep.test.ts — verify:
// (a) sweepExpiredBookings: a PENDING BookingSale whose reservationExpiresAt < now →
//     seat released, Booking CANCELLED, BookingSale FAILED, returns count 1; a not-yet-expired
//     PENDING sale is left untouched.
// (b) reconcilePendingCardBookings: a stuck PENDING card sale older than the cutoff calls
//     finalizeCardBooking (spy peachClient.getPaymentStatus → success) → COMPLETED.
// Seed via initiateMomoBooking / initiateCardBooking with a backdated reservationExpiresAt
// (set it directly via BookingSale.updateOne after initiate).
```

- [ ] **Step 2: Run to verify fail.** `npx jest src/services/transport/__tests__/booking.sweep.test.ts` → FAIL (functions missing).

- [ ] **Step 3: Implement** (mirror `reconcilePendingCardSales`, add the MoMo-less backstop sweep):

```typescript
  static async reconcilePendingCardBookings(olderThanMs = 2 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = await BookingSale.find({ paymentMethod: PaymentMethod.PEACH_CARD, paymentStatus: PaymentStatus.PENDING, peachPaymentId: { $exists: true, $nin: [null, ''] }, createdAt: { $lt: cutoff } }).limit(50);
    let n = 0;
    for (const s of stuck) {
      try { const r = await this.finalizeCardBooking(s.peachPaymentId as string); if (r.status !== 'pending') n++; }
      catch (err) { console.error(`[booking card-reconcile] failed for ${s.saleRef}`, err); }
    }
    return n;
  }

  /** MoMo has no reconcile: release seats for PENDING bookings whose hold lapsed, marking them FAILED. */
  static async sweepExpiredBookings(): Promise<number> {
    const lapsed = await BookingSale.find({ paymentStatus: PaymentStatus.PENDING, reservationExpiresAt: { $lt: new Date() } }).limit(100);
    let n = 0;
    for (const sale of lapsed) {
      try {
        const booking = await Booking.findById(sale.bookingIds[0]);
        if (booking && booking.status === BookingStatus.PENDING) {
          const trip = await Trip.findById(booking.tripId).select('seatScheme');
          await this.releaseBookingClaim(booking, trip?.seatScheme !== SeatScheme.PASSENGER_COUNT);
          booking.status = BookingStatus.CANCELLED; await booking.save();
        }
        sale.paymentStatus = PaymentStatus.FAILED; sale.momoFailureReason = sale.momoFailureReason || 'EXPIRED'; await sale.save();
        n++;
      } catch (err) { console.error(`[booking sweep] failed for ${sale.saleRef}`, err); }
    }
    return n;
  }
```

Add the index to `bookingSale.model.ts`: `bookingSaleSchema.index({ paymentStatus: 1, paymentMethod: 1 });`

Wire into `src/tasks/backgroundTasks.ts` (import `BookingService`, add two intervals mirroring the existing card-reconcile block):

```typescript
handles.push(setInterval(() => { BookingService.reconcilePendingCardBookings().catch(err => console.error('[booking card-reconcile] error', err)); }, 60_000));
handles.push(setInterval(() => { BookingService.sweepExpiredBookings().catch(err => console.error('[booking sweep] error', err)); }, 60_000));
```

- [ ] **Step 4: Run to verify pass.** `npx jest src/services/transport/__tests__/booking.sweep.test.ts` → PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** (`booking.service.ts`, `bookingSale.model.ts`, `backgroundTasks.ts`, `booking.sweep.test.ts`).

---

### Task 5: Webhook / return dispatch to booking finalizers

**Files:**
- Modify: `src/controllers/momo.controller.ts`, `src/controllers/card.controller.ts`
- Test: `src/controllers/__tests__/momoBookingDispatch.test.ts` (unit-level: call the controller with a reference that only a BookingSale owns → asserts the booking finalizer confirms it)

**Interfaces:**
- Consumes: `BookingService.finalizeMomoBooking`/`finalizeCardBooking`; existing `TicketService.finalize*`.

- [ ] **Step 1: Write the failing test** — seed a PENDING MoMo BookingSale (via `initiateMomoBooking`), stub `momoClient.getStatus` SUCCESSFUL, invoke `MomoController.callback` with `{ body: { referenceId } }` (mock `res`), assert the booking is CONFIRMED afterward. Repeat for card webhook.

- [ ] **Step 2: Run → FAIL** (controller doesn't dispatch to bookings yet; the ticket finalizer throws "not found" and nothing confirms the booking).

- [ ] **Step 3: Implement the fall-through.** In `momo.controller.ts` `callback`, wrap the `TicketService.finalizeMomoSale(referenceId)` call so that if it throws a "not found"/"Sale not found" error, it calls `BookingService.finalizeMomoBooking(referenceId)` instead (both idempotent, both swallow to always-200). Same in `card.controller.ts` `webhook` AND `returnRedirect` for `finalizeCardSale` → `finalizeCardBooking`. Keep the always-200 behavior. Example shape:

```typescript
try {
  await TicketService.finalizeMomoSale(referenceId);
} catch (e: any) {
  if (/not found/i.test(e?.message || '')) {
    try { await BookingService.finalizeMomoBooking(referenceId); } catch (be) { console.error('[momo callback] booking finalize', be); }
  } else { console.error('[momo callback] finalize threw', e); }
}
```

- [ ] **Step 4: Run → PASS.** Also run the existing momo/card controller tests to confirm the ticket path is unaffected. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** (`momo.controller.ts`, `card.controller.ts`, test).

---

### Task 6: POS async endpoints (initiate MoMo/card + status poll)

**Files:**
- Modify: `src/validators/transportPos.validator.ts`, `src/controllers/transportPos.controller.ts`, `src/routes/transportPos.route.ts`
- Test: `src/services/transport/__tests__/pos.async.smoke.test.ts` (service-level end-to-end: initiate → finalize → CONFIRMED)

**Interfaces:**
- Produces routes (auth = ResellerOperator, `SELL_TICKETS`): `POST /bookings/momo` (initiate), `POST /bookings/card` (initiate), `GET /bookings/momo/:referenceId/status`, `GET /bookings/card/:paymentId/status`.

- [ ] **Step 1: Write the failing smoke test** — seed trip, spy MoMo client, `BookingService.initiateMomoBooking(...)` → `finalizeMomoBooking(ref)` (SUCCESSFUL) → booking CONFIRMED; assert the flow the controller exposes.

- [ ] **Step 2: Run → PASS if Tasks 1-2 done** (guards the contract). If FAIL, fix service first.

- [ ] **Step 3: Add validators** — `initiateMomoBookingSchema` (`tripId` hex24, `seatNumber?`, `passengerName`, `passengerPhone`, `momoPhone` required), `initiateCardBookingSchema` (same minus momoPhone). Add controller methods `sellMomo`/`sellCard` (resolve reseller identity from `req.reseller`, call `BookingService.initiateMomoBooking`/`initiateCardBooking`, return `{ referenceId|paymentId, saleId, expiresAt, redirectUrl? }`) and `momoStatus`/`cardStatus` (call `finalizeMomoBooking`/`finalizeCardBooking`, return the status — this is the poll). Wire routes.

- [ ] **Step 4: Run** the transport suite + `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** (validator, controller, route, smoke test).

---

## Self-Review

**Spec coverage (SP1c = §5.8 + the SP1b non-goals async list):**
- initiate/finalize MoMo → Tasks 1-2; card twins → Task 3. ✓
- Webhook dispatch (try ticket finalizer, fall through to booking finalizer) → Task 5. ✓
- Card reconcile + MoMo-less expiry sweep → Task 4; BookingSale `{paymentStatus,paymentMethod}` index → Task 4. ✓
- POS async initiate + poll endpoints → Task 6. ✓
- Idempotency + atomic claim + amount guard + fail-loud seat release → Tasks 2/3 (mirrors the ticket finalizers). ✓

**Placeholder scan:** Task 3 & 6 describe the card/POS code as "mirror Task 1/2" with the exact deltas rather than re-pasting the full body — the implementer has the MoMo body as the verbatim template in the same file. If a task reviewer flags this as insufficiently explicit, expand at implementation time. All other steps have complete code.

**Type consistency:** `initiate*` returns `{ referenceId|paymentId, saleId, expiresAt }`; `finalize*` returns `{ status: 'completed'|'failed'|'pending' }`; `releaseBookingClaim(booking, isSeatMapped)` and `claimCapacity(trip, isSeatMapped, seatNumber, bookingId)` shared across initiate + sellSeat.

**Scope:** SP1c completes the payment matrix; it is additive to SP1b and reuses the events gateway clients + economics. No new consumer/dashboard surface (those are Phases 2-4).
