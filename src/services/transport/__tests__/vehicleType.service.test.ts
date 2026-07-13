import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { VehicleTypeService } from '@services/transport/vehicleType.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { SeatScheme } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const vendorId = () => new mongoose.Types.ObjectId().toString();

describe('VehicleTypeService', () => {
  it('creates and lists vehicle types scoped to the vendor', async () => {
    const v1 = vendorId();
    const v2 = vendorId();
    await VehicleTypeService.create({ vendorId: v1, name: 'Kombi', totalSeats: 15 });
    await VehicleTypeService.create({ vendorId: v2, name: 'Coach', totalSeats: 60, seatScheme: SeatScheme.SEQUENTIAL });
    const list = await VehicleTypeService.list(v1);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Kombi');
  });

  it('rejects a ROW_LETTER type without layoutJson', async () => {
    await expect(
      VehicleTypeService.create({ vendorId: vendorId(), name: 'RowBus', totalSeats: 8, seatScheme: SeatScheme.ROW_LETTER }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('update only touches the caller-owned doc (404 across vendors)', async () => {
    const owner = vendorId();
    const vt = await VehicleTypeService.create({ vendorId: owner, name: 'Kombi', totalSeats: 15 });
    await expect(
      VehicleTypeService.update(vendorId(), vt._id.toString(), { totalSeats: 20 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const updated = await VehicleTypeService.update(owner, vt._id.toString(), { totalSeats: 20 });
    expect(updated.totalSeats).toBe(20);
  });

  it('deactivate flips isActive to false', async () => {
    const owner = vendorId();
    const vt = await VehicleTypeService.create({ vendorId: owner, name: 'Kombi', totalSeats: 15 });
    await VehicleTypeService.deactivate(owner, vt._id.toString());
    const fresh = await VehicleType.findById(vt._id);
    expect(fresh!.isActive).toBe(false);
  });
});
