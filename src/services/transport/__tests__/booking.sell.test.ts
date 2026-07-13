import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import * as paymentsModule from '@services/payments';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Seat } from '@models/transport/seat.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { SeatScheme } from '@interfaces/transport.interface';
import { BookingStatus } from '@interfaces/booking.interface';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

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

  it('labels channel by soldByType', async () => {
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    const { sale: resellerSale } = await BookingService.sellSeat(
      sellArgs({ tripId: trip._id.toString(), seatNumber: '1', soldByType: 'reseller-operator' }),
    );
    expect(resellerSale.channel).toBe(SalesChannel.RESELLER_POS);

    const { sale: vendorSale } = await BookingService.sellSeat(
      sellArgs({
        tripId: trip._id.toString(),
        seatNumber: '2',
        soldByType: 'vendor',
        soldBy: new mongoose.Types.ObjectId().toString(),
      }),
    );
    expect(vendorSale.channel).toBe(SalesChannel.BOX_OFFICE);
  });
});

describe('BookingService.sellSeat — post-charge persistence failure', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('post-charge persist failure keeps the seat claimed and fails loud', async () => {
    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    const spy = jest.spyOn(BookingSale, 'create').mockRejectedValueOnce(new Error('db down'));

    await expect(
      BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1' })),
    ).rejects.toThrow('db down');

    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(true); // money captured — NOT released

    const booking = await Booking.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(booking).not.toBeNull();
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);

    spy.mockRestore();
  });
});

describe('BookingService.sellSeat — payment failure rollback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('releases the seat and throws when the processor returns failed', async () => {
    // NOTE (deviation from the brief): the brief's draft used
    // `jest.resetModules()` + `jest.doMock('@services/payments', ...)` +
    // dynamic re-`import('@services/transport/booking.service')`. That blows
    // away the whole Jest module registry, so the freshly re-imported service
    // (and the Trip/Seat/Booking/Route model files it transitively requires)
    // re-require a BRAND NEW `mongoose` package instance that was never
    // `.connect()`-ed — every query then buffers and times out
    // ("Operation `trips.findOne()` buffering timed out after 10000ms"),
    // confirmed by running it. `jest.spyOn` on the already-imported,
    // already-connected `@services/payments` module namespace swaps out
    // just `getProcessor` for this one test (booking.service.ts's compiled
    // CommonJS call site re-reads `payments_1.getProcessor(...)` on every
    // call, so the live object mutation is honored) without touching the
    // module registry or the DB connection.
    jest.spyOn(paymentsModule, 'getProcessor').mockReturnValue({
      method: PaymentMethod.KESHLESS_WALLET,
      isConfigured: () => true,
      charge: async () => ({ status: 'failed', message: 'Insufficient balance' }),
    } as any);

    const { trip } = await seedTrip(SeatScheme.SEQUENTIAL, 4);
    await expect(
      BookingService.sellSeat(sellArgs({ tripId: trip._id.toString(), seatNumber: '1', paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: 'ABCD2345' })),
    ).rejects.toThrow(/Insufficient balance/);
    const seat = await Seat.findOne({ tripId: trip._id, seatNumber: '1' });
    expect(seat!.isBooked).toBe(false);
    expect(await Booking.countDocuments({ tripId: trip._id })).toBe(0);
  });
});
