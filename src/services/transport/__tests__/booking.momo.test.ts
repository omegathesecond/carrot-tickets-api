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
import { Trip } from '@models/transport/trip.model';
import { SeatScheme, TripStatus } from '@interfaces/transport.interface';
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

  it('sends MTN the full international MSISDN for a leading-zero local number', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'RM' });
    const { trip } = await seedTrip();
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1', momoPhone: '076707421' }));
    expect(momo.requestToPay).toHaveBeenCalledWith(expect.objectContaining({ payerMsisdn: '26876707421' }));
  });

  it('rejects initiating on a departed trip with 422', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'R3' });
    const { trip } = await seedTrip();
    await Trip.updateOne({ _id: trip._id }, { $set: { status: TripStatus.DEPARTED } });
    await expect(BookingService.initiateMomoBooking(args({ tripId: trip._id.toString(), seatNumber: '1' }))).rejects.toMatchObject({ statusCode: 422 });
  });
});

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

  it('GA trip: concurrent FAILED finalize decrements soldCount exactly once', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'RGA' });
    const { trip } = await seedTrip(SeatScheme.PASSENGER_COUNT, 10);
    await BookingService.initiateMomoBooking(args({ tripId: trip._id.toString() }));
    expect((await Trip.findById(trip._id))!.soldCount).toBe(1);

    momo.getStatus.mockResolvedValue({ status: 'FAILED', raw: {} });
    await Promise.allSettled([
      BookingService.finalizeMomoBooking('RGA'),
      BookingService.finalizeMomoBooking('RGA'),
    ]);

    const freshTrip = await Trip.findById(trip._id);
    expect(freshTrip!.soldCount).toBe(0);
  });
});
