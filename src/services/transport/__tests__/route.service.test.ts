import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { RouteService } from '@services/transport/route.service';
import { Route } from '@models/transport/route.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const vendorId = () => new mongoose.Types.ObjectId().toString();

describe('RouteService', () => {
  it('creates + lists routes scoped to the vendor', async () => {
    const v1 = vendorId();
    await RouteService.create({ vendorId: v1, name: 'MZ→MB', originCity: 'Manzini', destinationCity: 'Mbabane', farePerSeat: 35 });
    await RouteService.create({ vendorId: vendorId(), name: 'Other', originCity: 'A', destinationCity: 'B', farePerSeat: 10 });
    const list = await RouteService.list(v1);
    expect(list).toHaveLength(1);
    expect(list[0]!.farePerSeat).toBe(35);
  });

  it('update is vendor-scoped (404 for a non-owner)', async () => {
    const owner = vendorId();
    const r = await RouteService.create({ vendorId: owner, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 20 });
    await expect(
      RouteService.update(vendorId(), r._id.toString(), { farePerSeat: 25 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const updated = await RouteService.update(owner, r._id.toString(), { farePerSeat: 25 });
    expect(updated.farePerSeat).toBe(25);
  });

  it('deactivate flips isActive to false (owner)', async () => {
    const owner = vendorId();
    const r = await RouteService.create({ vendorId: owner, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 20 });
    await RouteService.deactivate(owner, r._id.toString());
    const fresh = await Route.findById(r._id);
    expect(fresh!.isActive).toBe(false);
  });

  it('deactivate returns 404 for a cross-vendor id and leaves the route active', async () => {
    const owner = vendorId();
    const other = vendorId();
    const r = await RouteService.create({ vendorId: owner, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 20 });
    await expect(RouteService.deactivate(other, r._id.toString())).rejects.toMatchObject({ statusCode: 404 });
    const fresh = await Route.findById(r._id);
    expect(fresh!.isActive).toBe(true);
  });
});
