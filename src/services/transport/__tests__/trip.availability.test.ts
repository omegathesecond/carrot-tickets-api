import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { TripService } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Trip } from '@models/transport/trip.model';
import { Seat } from '@models/transport/seat.model';
import { SeatScheme, TripStatus } from '@interfaces/transport.interface';

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

  it('filters by routeId, excluding trips on other routes', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const tripA = await seedTrip(vendorId, SeatScheme.SEQUENTIAL, 4);
    const tripB = await seedTrip(vendorId, SeatScheme.SEQUENTIAL, 6);
    const list = await TripService.listSellable({ vendorId, routeId: tripA.routeId.toString() });
    const ids = list.map((x) => x._id.toString());
    expect(ids).toContain(tripA._id.toString());
    expect(ids).not.toContain(tripB._id.toString());
  });

  it('excludes trips that are not scheduled/boarding (e.g. departed)', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const trip = await seedTrip(vendorId, SeatScheme.SEQUENTIAL, 4);
    await Trip.updateOne({ _id: trip._id }, { $set: { status: TripStatus.DEPARTED } });
    const list = await TripService.listSellable({ vendorId });
    expect(list.map((x) => x._id.toString())).not.toContain(trip._id.toString());
  });

  it('excludes trips whose departureTime has already passed', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const trip = await seedTrip(vendorId, SeatScheme.SEQUENTIAL, 4);
    await Trip.updateOne({ _id: trip._id }, { $set: { departureTime: new Date(Date.now() - 86400000) } });
    const list = await TripService.listSellable({ vendorId });
    expect(list.map((x) => x._id.toString())).not.toContain(trip._id.toString());
  });
});
