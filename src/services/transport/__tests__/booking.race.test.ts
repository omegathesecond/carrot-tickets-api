// src/services/transport/__tests__/booking.race.test.ts
//
// SP1c final-review money-integrity fixes: EVERY capacity-release/status
// transition for async bus bookings is unified on a SINGLE atomic arbiter —
// BookingSale.paymentStatus (CAS PENDING→{COMPLETED|FAILED}). These tests drive
// the two callers that can race for the same sale — finalize* and the expiry
// sweep — concurrently against a real in-memory Mongo, and assert the DB always
// lands in ONE fully-consistent end state (never a paid sale with a released
// seat, never a double capacity release). They also prove the sweep verifies
// with the gateway before failing (paid-but-slow MoMo near TTL) and that a MoMo
// callback keyed only on externalId resolves the bus BookingSale.

import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';

const momo = { isConfigured: jest.fn(), requestToPay: jest.fn(), getStatus: jest.fn() };
jest.spyOn(MtnMomoClient.prototype, 'isConfigured').mockImplementation(() => momo.isConfigured());
jest.spyOn(MtnMomoClient.prototype, 'requestToPay').mockImplementation((...a: any[]) => momo.requestToPay(...a));
jest.spyOn(MtnMomoClient.prototype, 'getStatus').mockImplementation((...a: any[]) => momo.getStatus(...a));

import { MomoController } from '@controllers/momo.controller';
import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Seat } from '@models/transport/seat.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { Trip } from '@models/transport/trip.model';
import { SeatScheme } from '@interfaces/transport.interface';
import { BookingStatus } from '@interfaces/booking.interface';
import { PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(async () => { await clearTestDb(); momo.isConfigured.mockReset(); momo.requestToPay.mockReset(); momo.getStatus.mockReset(); });
afterAll(disconnectTestDb);

async function seedTrip(scheme = SeatScheme.SEQUENTIAL, totalSeats = 4) {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${scheme}-${totalSeats}-${Math.random()}`, totalSeats, seatScheme: scheme });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  return { vendorId, trip };
}
const args = (extra: any) => ({ passengerName: 'T', passengerPhone: '76707421', momoPhone: '76707421', soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator' as const, ...extra });

// Native driver bypasses the timestamps plugin so the backdated hold sticks.
async function backdateExpiry(ref: string) {
  await BookingSale.collection.updateOne({ momoReferenceId: ref }, { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
}

function mockRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}
function mockMomoReq(body: any): Request {
  return {
    body,
    method: 'POST',
    originalUrl: '/api/public/purchase/momo/callback',
    ip: '127.0.0.1',
    params: {},
    query: {},
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as Request;
}

describe('single-arbiter money integrity: finalize vs sweep', () => {
  it('GA: SUCCESSFUL finalize racing an expired sweep confirms once — seat NOT released, both callers truthful', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'RRSUCC' });
    const { trip } = await seedTrip(SeatScheme.PASSENGER_COUNT, 10);
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString() }));
    expect((await Trip.findById(trip._id))!.soldCount).toBe(1);

    await backdateExpiry('RRSUCC');
    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '35', currency: 'SZL' } });

    const [finRes] = await Promise.all([
      BookingService.finalizeMomoBooking('RRSUCC'),
      BookingService.sweepExpiredBookings(),
    ]);

    const booking = await Booking.findOne({ tripId: trip._id });
    const sale = await BookingSale.findOne({ momoReferenceId: 'RRSUCC' });
    const freshTrip = await Trip.findById(trip._id);

    // The gateway said SUCCESSFUL, so the only consistent end state is paid+confirmed.
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    expect(freshTrip!.soldCount).toBe(1); // capacity held, NOT released by the racing sweep
    // No false status: the direct finalize truthfully reports the paid outcome.
    expect(finRes.status).toBe('completed');
    // Invariant: sale COMPLETED iff booking CONFIRMED.
    expect(sale!.paymentStatus === PaymentStatus.COMPLETED).toBe(booking!.status === BookingStatus.CONFIRMED);
  });

  it('GA: FAILED finalize racing an expired sweep decrements soldCount EXACTLY once', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'RRFAIL' });
    const { trip } = await seedTrip(SeatScheme.PASSENGER_COUNT, 10);
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString() }));
    expect((await Trip.findById(trip._id))!.soldCount).toBe(1);

    await backdateExpiry('RRFAIL');
    momo.getStatus.mockResolvedValue({ status: 'FAILED', raw: {} });

    await Promise.all([
      BookingService.finalizeMomoBooking('RRFAIL'),
      BookingService.sweepExpiredBookings(),
    ]);

    const booking = await Booking.findOne({ tripId: trip._id });
    const sale = await BookingSale.findOne({ momoReferenceId: 'RRFAIL' });
    const freshTrip = await Trip.findById(trip._id);

    expect(freshTrip!.soldCount).toBe(0); // decremented exactly once despite two racers
    expect(booking!.status).toBe(BookingStatus.CANCELLED);
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
  });
});

describe('sweep verifies with the gateway before failing', () => {
  it('MoMo paid-but-slow: an expired sale the gateway now reports SUCCESSFUL is CONFIRMED, not failed', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'RSLOW' });
    const { trip } = await seedTrip();
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }));

    await backdateExpiry('RSLOW');
    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '35', currency: 'SZL' } });

    await BookingService.sweepExpiredBookings();

    const booking = await Booking.findOne({ tripId: trip._id });
    const sale = await BookingSale.findOne({ momoReferenceId: 'RSLOW' });
    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED); // sweep did NOT fail a paid booking
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(seat!.isBooked).toBe(true);
  });
});

describe('MoMo callback resolves a bus booking by externalId', () => {
  it('confirms a PENDING bus booking when the callback carries only externalId (= saleRef)', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'REXT' });
    const { trip } = await seedTrip();
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }));
    const created = await BookingSale.findOne({ momoReferenceId: 'REXT' });

    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '35', currency: 'SZL' } });

    const req = mockMomoReq({ externalId: created!.saleRef }); // no referenceId at all
    const res = mockRes();
    await MomoController.callback(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    const sale = await BookingSale.findOne({ momoReferenceId: 'REXT' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });
});
