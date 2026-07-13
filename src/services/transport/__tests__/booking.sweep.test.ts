import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';
import { PeachClient } from '@services/payments/peach.client';

const momo = { isConfigured: jest.fn(), requestToPay: jest.fn(), getStatus: jest.fn() };
jest.spyOn(MtnMomoClient.prototype, 'isConfigured').mockImplementation(() => momo.isConfigured());
jest.spyOn(MtnMomoClient.prototype, 'requestToPay').mockImplementation((...a: any[]) => momo.requestToPay(...a));
jest.spyOn(MtnMomoClient.prototype, 'getStatus').mockImplementation((...a: any[]) => momo.getStatus(...a));

const peach = { isConfigured: jest.fn(), createPayment: jest.fn(), getPaymentStatus: jest.fn() };
jest.spyOn(PeachClient.prototype, 'isConfigured').mockImplementation(() => peach.isConfigured());
jest.spyOn(PeachClient.prototype, 'createPayment').mockImplementation((...a: any[]) => peach.createPayment(...a));
jest.spyOn(PeachClient.prototype, 'getPaymentStatus').mockImplementation((...a: any[]) => peach.getPaymentStatus(...a));

import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Seat } from '@models/transport/seat.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { Trip } from '@models/transport/trip.model';
import { SeatScheme, TripStatus } from '@interfaces/transport.interface';
import { BookingStatus } from '@interfaces/booking.interface';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';

beforeAll(connectTestDb);
beforeEach(async () => {
  // peachCardEnabled defaults to false — re-seeded each time since
  // clearTestDb() (in the previous afterEach) wipes the config document.
  await PaymentConfigService.update({ peachCardEnabled: true, platformFeePercent: 0 });
});
afterEach(async () => {
  await clearTestDb();
  momo.isConfigured.mockReset(); momo.requestToPay.mockReset(); momo.getStatus.mockReset();
  peach.isConfigured.mockReset(); peach.createPayment.mockReset(); peach.getPaymentStatus.mockReset();
});
afterAll(disconnectTestDb);

async function seedTrip(scheme = SeatScheme.SEQUENTIAL, totalSeats = 4) {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${scheme}-${totalSeats}`, totalSeats, seatScheme: scheme });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  return { vendorId, trip };
}
const args = (extra: any) => ({ passengerName: 'T', passengerPhone: '76707421', soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator' as const, ...extra });

describe('BookingService.sweepExpiredBookings', () => {
  it('expired PENDING momo sale: releases the seat, cancels the booking, fails the sale, returns count 1', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'RSWEEP1' });
    const { trip } = await seedTrip();
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1', momoPhone: '76707421' }));

    // Backdate the reservation hold so it reads as lapsed.
    await BookingSale.updateOne({ momoReferenceId: 'RSWEEP1' }, { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } });

    const n = await BookingService.sweepExpiredBookings();
    expect(n).toBe(1);

    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(false);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CANCELLED);
    const sale = await BookingSale.findOne({ momoReferenceId: 'RSWEEP1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(sale!.momoFailureReason).toBe('EXPIRED');
  });

  it('leaves a not-yet-expired PENDING sale untouched', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'RSWEEP2' });
    const { trip } = await seedTrip();
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1', momoPhone: '76707421' }));

    const n = await BookingService.sweepExpiredBookings();
    expect(n).toBe(0);

    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(true);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.PENDING);
    const sale = await BookingSale.findOne({ momoReferenceId: 'RSWEEP2' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('GA trip: concurrent sweeps of the same expired booking decrement soldCount exactly once', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'RSWEEPGA' });
    const { trip } = await seedTrip(SeatScheme.PASSENGER_COUNT, 10);
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), momoPhone: '76707421' }));
    expect((await Trip.findById(trip._id))!.soldCount).toBe(1);

    await BookingSale.updateOne({ momoReferenceId: 'RSWEEPGA' }, { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } });

    const [a, b] = await Promise.all([BookingService.sweepExpiredBookings(), BookingService.sweepExpiredBookings()]);
    expect(a + b).toBe(1);

    const freshTrip = await Trip.findById(trip._id);
    expect(freshTrip!.soldCount).toBe(0);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CANCELLED);
  });
});

describe('BookingService.reconcilePendingCardBookings', () => {
  it('finalizes a stuck PENDING card sale older than the cutoff via finalizeCardBooking', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'PRECON1', code: '000.000.000', redirect: { url: 'https://pay' } });
    const { trip } = await seedTrip();
    await BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }));

    // Backdate createdAt so the sale reads as "stuck" past the reconcile cutoff.
    // Mongoose's `timestamps: true` plugin silently strips `createdAt` from a
    // plain `$set` on update queries (it only stamps createdAt on insert), so
    // load the doc, mutate the field directly, and save() — save() only
    // re-stamps createdAt when the doc `isNew`, so our manual value sticks.
    // Mongoose's `timestamps: true` plugin re-stamps createdAt/updatedAt via
    // both the update-query middleware AND the save() pre-hook, so neither a
    // plain $set through updateOne nor a load+set+save() sticks. Bypass
    // Mongoose entirely via the native driver collection to backdate the raw
    // document.
    await BookingSale.collection.updateOne({ peachPaymentId: 'PRECON1' }, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });

    peach.getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '35', currency: 'ZAR' });
    const n = await BookingService.reconcilePendingCardBookings();
    expect(n).toBe(1);

    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    const sale = await BookingSale.findOne({ peachPaymentId: 'PRECON1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });

  it('does not touch a card sale still within the cutoff window', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'PRECON2', code: '000.000.000', redirect: { url: 'https://pay' } });
    const { trip } = await seedTrip();
    await BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }));

    const n = await BookingService.reconcilePendingCardBookings();
    expect(n).toBe(0);
    expect(peach.getPaymentStatus).not.toHaveBeenCalled();

    const sale = await BookingSale.findOne({ peachPaymentId: 'PRECON2' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    void trip;
  });
});
