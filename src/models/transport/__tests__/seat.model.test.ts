import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { Seat } from '@models/transport/seat.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('Seat model', () => {
  it('defaults isBooked/isReserved false', async () => {
    const seat = await Seat.create({ tripId: new mongoose.Types.ObjectId(), seatNumber: 'A1' });
    expect(seat.isBooked).toBe(false);
    expect(seat.isReserved).toBe(false);
  });

  it('enforces unique (tripId, seatNumber)', async () => {
    const tripId = new mongoose.Types.ObjectId();
    await Seat.create({ tripId, seatNumber: 'A1' });
    await Seat.init();
    await expect(Seat.create({ tripId, seatNumber: 'A1' })).rejects.toThrow();
  });
});
