// api/src/models/__tests__/cashier.eventScope.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Cashier } from '@models/cashier.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// Per-file incrementing sequence, not Math.random() — a random pick over a
// small range collides across the it() blocks below and flakes the unique
// loginCode index. Crockford base32 (no I/L/O/U) so the literals read like
// real login codes, e.g. '4KZ9P2' — see task-4/task-11 reports.
let __loginCodeSeq = 900;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

const organizer = () => ({
  fullName: 'Nomsa',
  loginCode: nextLoginCode(),
  pin: '123456',
  scope: 'organizer' as const,
  vendorId: new mongoose.Types.ObjectId(),
});

it('requires an event for an organizer cashier', async () => {
  await expect(new Cashier(organizer()).save()).rejects.toThrow(/eventId/);
});

it('allows a platform cashier with no event', async () => {
  const c = await new Cashier({
    fullName: 'Carrot Staff', loginCode: nextLoginCode(), pin: '123456', scope: 'platform',
  }).save();
  expect(c.eventId).toBeUndefined();
});

it('refuses to move a cashier to another event', async () => {
  const eventId = new mongoose.Types.ObjectId();
  const c = await new Cashier({ ...organizer(), eventId }).save();
  c.eventId = new mongoose.Types.ObjectId();
  await c.save();
  // Assert against a document reloaded from the database, not the in-memory
  // one — mongoose can silently no-op the assignment above without the
  // schema's `immutable: true` doing anything, and an in-memory-only
  // assertion would pass either way. Reloading is the only check that
  // actually proves persistence-level immutability held.
  const reloaded = await Cashier.findById(c._id);
  expect(reloaded!.eventId!.toString()).toBe(eventId.toString());
});
