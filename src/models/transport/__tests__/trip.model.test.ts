import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { Trip } from '@models/transport/trip.model';
import { TripStatus, SeatScheme } from '@interfaces/transport.interface';

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
      seatScheme: SeatScheme.SEQUENTIAL,
    });
    expect(trip.status).toBe(TripStatus.SCHEDULED);
    expect(trip.soldCount).toBe(0);
    expect(trip.reservedCount).toBe(0);
  });
});
