// api/src/scripts/__tests__/cleanup-eventless-cashiers.test.ts
//
// The environment that proves the API correct is the one environment
// structurally incapable of reproducing this bug: mongodb-memory-server builds
// a fresh database from the CURRENT schema every run, and the current schema
// REQUIRES eventId on an organizer cashier — so the legacy row that exists in
// every real database simply cannot be created through the model.
//
// These tests therefore build the real starting state by hand, inserting
// through the raw driver. A test that seeded through Mongoose would prove
// nothing, because Mongoose would refuse the very document under test.
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Cashier } from '@models/cashier.model';
import { cleanupEventlessCashiers } from '../cleanup-eventless-cashiers';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// Per-file incrementing sequence, not Math.random() — a random pick over a
// small range collides across it() blocks and flakes the unique loginCode
// index. Crockford base32 (no I/L/O/U), e.g. '4KZ9P2'.
let __loginCodeSeq = 700;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

const cashiers = () => mongoose.connection.db!.collection('cashiers');

/** A cashier as the OLD schema stored her: organizer-scoped, no event at all. */
async function insertLegacyCashier(fullName: string) {
  const loginCode = nextLoginCode();
  const { insertedId } = await cashiers().insertOne({
    fullName, loginCode, pin: '$2b$10$notarealhashbutshapedlikeone',
    scope: 'organizer', vendorId: new mongoose.Types.ObjectId(),
    isActive: true, failedPinAttempts: 0, lockedUntil: null,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return { id: insertedId, loginCode };
}

it('the model really does refuse to create this row (the state being cleaned up)', async () => {
  // Negative control. Without it the assertions below could pass for the wrong
  // reason — you cannot tell a cleanup from an absent problem.
  await expect(Cashier.create({
    fullName: 'Nomsa', loginCode: nextLoginCode(), pin: '123456',
    scope: 'organizer', vendorId: new mongoose.Types.ObjectId(),
  })).rejects.toThrow(/eventId/);
});

it('removes an organizer cashier carrying no event', async () => {
  const legacy = await insertLegacyCashier('Legacy Nomsa');

  const result = await cleanupEventlessCashiers();

  expect(result).toEqual({ legacyCashiers: 1, deleted: 1 });
  expect(await cashiers().findOne({ _id: legacy.id })).toBeNull();
});

it('leaves PLATFORM cashiers alone — they are legitimately global', async () => {
  const platform = await Cashier.create({
    fullName: 'Carrot Staff', loginCode: nextLoginCode(), pin: '123456', scope: 'platform',
  });
  expect(platform.eventId).toBeUndefined(); // event-less, and correctly so

  const result = await cleanupEventlessCashiers();

  expect(result.deleted).toBe(0);
  expect(await Cashier.findById(platform._id)).not.toBeNull();
});

it('leaves a post-change organizer cashier with an event alone', async () => {
  const eventId = new mongoose.Types.ObjectId();
  const kept = await Cashier.create({
    fullName: 'Sipho', loginCode: nextLoginCode(), pin: '123456',
    scope: 'organizer', vendorId: new mongoose.Types.ObjectId(), eventId,
  });

  const result = await cleanupEventlessCashiers();

  expect(result.deleted).toBe(0);
  const reloaded = await Cashier.findById(kept._id);
  expect(reloaded).not.toBeNull();
  expect(reloaded!.eventId!.toString()).toBe(eventId.toString());
});

it('removes only the legacy rows when all three populations sit side by side', async () => {
  await insertLegacyCashier('Legacy A');
  await insertLegacyCashier('Legacy B');
  const platform = await Cashier.create({ fullName: 'Carrot Staff', loginCode: nextLoginCode(), pin: '123456', scope: 'platform' });
  const scoped = await Cashier.create({
    fullName: 'Sipho', loginCode: nextLoginCode(), pin: '123456',
    scope: 'organizer', vendorId: new mongoose.Types.ObjectId(), eventId: new mongoose.Types.ObjectId(),
  });

  const result = await cleanupEventlessCashiers();

  expect(result).toEqual({ legacyCashiers: 2, deleted: 2 });
  const survivors = await Cashier.find({}).sort({ fullName: 1 });
  expect(survivors.map((c) => c.fullName)).toEqual(['Carrot Staff', 'Sipho']);
  expect(survivors.map((c) => String(c._id)).sort())
    .toEqual([String(platform._id), String(scoped._id)].sort());
});

it('treats an explicit eventId:null the same as a missing one', async () => {
  // Belt and braces: a partial earlier fix, or a driver-level $unset, can
  // leave the key present and null rather than absent.
  const { insertedId } = await cashiers().insertOne({
    fullName: 'Null Event', loginCode: nextLoginCode(), pin: '$2b$10$notarealhash',
    scope: 'organizer', vendorId: new mongoose.Types.ObjectId(), eventId: null,
    isActive: true, failedPinAttempts: 0, lockedUntil: null,
    createdAt: new Date(), updatedAt: new Date(),
  });

  const result = await cleanupEventlessCashiers();

  expect(result.deleted).toBe(1);
  expect(await cashiers().findOne({ _id: insertedId })).toBeNull();
});

it('is idempotent — a second run neither throws nor removes anything more', async () => {
  await insertLegacyCashier('Legacy Nomsa');
  await Cashier.create({ fullName: 'Carrot Staff', loginCode: nextLoginCode(), pin: '123456', scope: 'platform' });

  const first = await cleanupEventlessCashiers();
  expect(first.deleted).toBe(1);

  const second = await cleanupEventlessCashiers();
  expect(second).toEqual({ legacyCashiers: 0, deleted: 0 });
  expect(await Cashier.countDocuments({})).toBe(1);
});

it('runs clean on a database that never had a legacy cashier', async () => {
  const result = await cleanupEventlessCashiers();
  expect(result).toEqual({ legacyCashiers: 0, deleted: 0 });
});
