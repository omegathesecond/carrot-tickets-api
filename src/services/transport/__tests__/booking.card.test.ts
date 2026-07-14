import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { PeachClient } from '@services/payments/peach.client';

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
afterEach(async () => { await clearTestDb(); peach.isConfigured.mockReset(); peach.createPayment.mockReset(); peach.getPaymentStatus.mockReset(); });
afterAll(disconnectTestDb);

async function seedTrip(scheme = SeatScheme.SEQUENTIAL, totalSeats = 4) {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${scheme}-${totalSeats}`, totalSeats, seatScheme: scheme });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  return { vendorId, trip };
}
const args = (extra: any) => ({ passengerName: 'T', passengerPhone: '76707421', soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator' as const, ...extra });

describe('BookingService.initiateCardBooking', () => {
  it('claims the seat + creates a PENDING booking & sale, no confirmation yet', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'P1', code: '000.000.000', redirect: { url: 'https://pay' } });
    const { trip } = await seedTrip();
    const res = await BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }));
    expect(res.paymentId).toBe('P1');
    expect(res.redirectUrl).toBe('https://pay');
    expect(res.expiresAt).toBeInstanceOf(Date);
    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(true);
    const sale = await BookingSale.findOne({ peachPaymentId: 'P1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.PENDING);
  });

  it('releases the seat + marks FAILED when createPayment throws', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockRejectedValue(new Error('Peach down'));
    const { trip } = await seedTrip();
    await expect(BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }))).rejects.toThrow('Peach down');
    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(false);
    const sale = await BookingSale.findOne({});
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('409 when the seat is already taken', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'P2', code: '000.000.000', redirect: { url: 'https://pay' } });
    const { trip } = await seedTrip();
    await BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }));
    await expect(BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('throws when card payments are not configured', async () => {
    peach.isConfigured.mockReturnValue(false);
    const { trip } = await seedTrip();
    await expect(BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }))).rejects.toThrow();
  });

  it('rejects initiating on a departed trip with 422', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'P3', code: '000.000.000', redirect: { url: 'https://pay' } });
    const { trip } = await seedTrip();
    await Trip.updateOne({ _id: trip._id }, { $set: { status: TripStatus.DEPARTED } });
    await expect(BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }))).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('BookingService.finalizeCardBooking', () => {
  async function initiate(seatNumber = '1', paymentId = 'P1') {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: paymentId, code: '000.000.000', redirect: { url: 'https://pay' } });
    const { trip } = await seedTrip();
    await BookingService.initiateCardBooking(args({ tripId: trip._id.toString(), seatNumber }));
    return { trip };
  }

  it('confirms the booking on success code with matching amount (idempotent)', async () => {
    const { trip } = await initiate('1', 'P1');
    peach.getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '35', currency: 'ZAR' });
    const first = await BookingService.finalizeCardBooking('P1');
    expect(first.status).toBe('completed');
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    const sale = await BookingSale.findOne({ peachPaymentId: 'P1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    // idempotent
    expect((await BookingService.finalizeCardBooking('P1')).status).toBe('completed');
    expect(await Booking.countDocuments({ tripId: trip._id })).toBe(1);
  });

  it('releases the seat + FAILED on a rejected code', async () => {
    const { trip } = await initiate('1', 'P2');
    peach.getPaymentStatus.mockResolvedValue({ code: '800.100.100', amount: '35', currency: 'ZAR' });
    expect((await BookingService.finalizeCardBooking('P2')).status).toBe('failed');
    expect((await Seat.findOne({ tripId: trip._id, seatNumber: '1' }))!.isBooked).toBe(false);
    expect((await BookingSale.findOne({ peachPaymentId: 'P2' }))!.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('refuses to confirm on amount mismatch → FAILED + seat released', async () => {
    const { trip } = await initiate('1', 'P3');
    peach.getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '5', currency: 'ZAR' });
    expect((await BookingService.finalizeCardBooking('P3')).status).toBe('failed');
    expect((await Seat.findOne({ tripId: trip._id, seatNumber: '1' }))!.isBooked).toBe(false);
    expect((await Booking.findOne({ tripId: trip._id }))!.status).not.toBe(BookingStatus.CONFIRMED);
  });

  it('returns pending while Peach is still pending', async () => {
    await initiate('1', 'P4');
    peach.getPaymentStatus.mockResolvedValue({ code: '000.200.000', amount: '35', currency: 'ZAR' });
    expect((await BookingService.finalizeCardBooking('P4')).status).toBe('pending');
    expect((await BookingSale.findOne({ peachPaymentId: 'P4' }))!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('throws when no sale matches the payment id', async () => {
    await expect(BookingService.finalizeCardBooking('NOPE')).rejects.toThrow(/not found/i);
  });

  it('GA trip: concurrent rejected finalize decrements soldCount exactly once', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'PGA', code: '000.000.000', redirect: { url: 'https://pay' } });
    const { trip } = await seedTrip(SeatScheme.PASSENGER_COUNT, 10);
    await BookingService.initiateCardBooking(args({ tripId: trip._id.toString() }));
    expect((await Trip.findById(trip._id))!.soldCount).toBe(1);

    peach.getPaymentStatus.mockResolvedValue({ code: '800.100.100', amount: '35', currency: 'ZAR' });
    await Promise.allSettled([
      BookingService.finalizeCardBooking('PGA'),
      BookingService.finalizeCardBooking('PGA'),
    ]);

    const freshTrip = await Trip.findById(trip._id);
    expect(freshTrip!.soldCount).toBe(0);
  });
});
