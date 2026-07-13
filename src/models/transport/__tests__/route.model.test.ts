import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { Route } from '@models/transport/route.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('Route model', () => {
  it('creates a route with fare and defaults isActive true', async () => {
    const route = await Route.create({
      vendorId: new mongoose.Types.ObjectId(),
      name: 'Manzini → Mbabane',
      originCity: 'Manzini',
      destinationCity: 'Mbabane',
      farePerSeat: 35,
    });
    expect(route.isActive).toBe(true);
    expect(route.farePerSeat).toBe(35);
    expect(route.stops).toBeUndefined();
  });

  it('requires originCity, destinationCity and farePerSeat', async () => {
    await expect(
      Route.create({ vendorId: new mongoose.Types.ObjectId(), name: 'X' } as any),
    ).rejects.toThrow();
  });
});
