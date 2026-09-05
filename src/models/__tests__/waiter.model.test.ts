import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Waiter } from '@models/waiter.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const base = {
  fullName: 'Thabo', loginCode: 'WTR001', pin: '123456',
  scope: 'organizer' as const,
  vendorId: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId(),
};

describe('the Waiter actor', () => {
  it('hashes the PIN and never returns it by default', async () => {
    const w = await Waiter.create(base);
    expect(w.pin).not.toBe('123456');
    const read = await Waiter.findById(w._id);
    expect(read!.pin).toBeUndefined();
  });

  it('compares a PIN through the shared credential mixin', async () => {
    await Waiter.create(base);
    const w = await Waiter.findOne({ loginCode: 'WTR001' }).select('+pin');
    expect(await w!.comparePin('123456')).toBe(true);
    expect(await w!.comparePin('000000')).toBe(false);
  });

  it('requires an event for an organizer waiter', async () => {
    // A floor waiter is hired for ONE event and ends with it, same as a cashier.
    const { eventId, ...noEvent } = base;
    await expect(Waiter.create(noEvent)).rejects.toThrow();
  });

  it('refuses to move a waiter to another event', async () => {
    const w = await Waiter.create(base);
    const other = new mongoose.Types.ObjectId();
    w.eventId = other;
    await w.save();
    expect(String((await Waiter.findById(w._id))!.eventId)).toBe(String(base.eventId));
  });
});
