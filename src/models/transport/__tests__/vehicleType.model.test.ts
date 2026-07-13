import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { VehicleType } from '@models/transport/vehicleType.model';
import { SeatScheme } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('VehicleType model', () => {
  it('defaults seatScheme to SEQUENTIAL, isActive true, registrations []', async () => {
    const vt = await VehicleType.create({
      vendorId: new mongoose.Types.ObjectId(),
      name: '60-seater coach',
      totalSeats: 60,
    });
    expect(vt.seatScheme).toBe(SeatScheme.SEQUENTIAL);
    expect(vt.isActive).toBe(true);
    expect(vt.registrations).toEqual([]);
    expect((vt.toJSON() as any).__v).toBeUndefined();
  });

  it('enforces unique (vendorId, name)', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    await VehicleType.init();
    await VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 15 });
    await expect(
      VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 15 }),
    ).rejects.toThrow();
  });

  it('rejects totalSeats < 1', async () => {
    await expect(
      VehicleType.create({ vendorId: new mongoose.Types.ObjectId(), name: 'Bad', totalSeats: 0 }),
    ).rejects.toThrow();
  });
});
