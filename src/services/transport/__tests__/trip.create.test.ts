import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { TripService, generateSeatNumbers } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Seat } from '@models/transport/seat.model';
import { Trip } from '@models/transport/trip.model';
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
  it('ROW_LETTER without layoutJson throws 400', () => {
    expect(() => generateSeatNumbers(SeatScheme.ROW_LETTER, 4)).toThrow();
    try {
      generateSeatNumbers(SeatScheme.ROW_LETTER, 4);
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
  });
  it('ROW_LETTER with rows exceeding the alphabet throws 400', () => {
    try {
      generateSeatNumbers(SeatScheme.ROW_LETTER, 100, { rows: 24, seatsPerRow: 4 });
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
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

  it('rejects reservedSeatNumbers on a passenger-count vehicle', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.PASSENGER_COUNT, 40);
    await expect(
      TripService.createTrip({
        vendorId,
        routeId,
        vehicleTypeId,
        departureTime: new Date(Date.now() + 86400000),
        reservedSeatNumbers: ['1'],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unknown seat label in reservedSeatNumbers', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.SEQUENTIAL, 4);
    await expect(
      TripService.createTrip({
        vendorId,
        routeId,
        vehicleTypeId,
        departureTime: new Date(Date.now() + 86400000),
        reservedSeatNumbers: ['99'],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a reservedCount greater than totalSeats', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.PASSENGER_COUNT, 10);
    await expect(
      TripService.createTrip({
        vendorId,
        routeId,
        vehicleTypeId,
        departureTime: new Date(Date.now() + 86400000),
        reservedCount: 11,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('deletes the orphan trip (and seats) if seat insert fails', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const { routeId, vehicleTypeId } = await seedRouteAndVehicle(vendorId, SeatScheme.SEQUENTIAL, 4);
    const spy = jest.spyOn(Seat, 'insertMany').mockRejectedValueOnce(new Error('boom'));
    await expect(
      TripService.createTrip({ vendorId, routeId, vehicleTypeId, departureTime: new Date(Date.now() + 86400000) }),
    ).rejects.toThrow('boom');
    expect(await Trip.countDocuments({})).toBe(0);
    expect(await Seat.countDocuments({})).toBe(0);
    spy.mockRestore();
  });
});
