// api/src/scripts/__tests__/migrate-merchant-credentials.test.ts
//
// The environment that proves the API correct is the one environment
// structurally incapable of reproducing this bug: mongodb-memory-server builds
// a fresh database from the CURRENT schema every run, and the current schema no
// longer declares loginCode — so the stale `merchants.loginCode_1` index that
// exists in every real database simply never appears here.
//
// These tests therefore build the real starting state by hand: the unique,
// NON-sparse index created explicitly on the raw collection, and legacy stall
// documents inserted through the raw driver (Mongoose strict mode would strip
// fields the schema no longer declares).
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantAuthService } from '@services/merchantAuth.service';
import { migrateMerchantCredentials } from '../migrate-merchant-credentials';

beforeAll(connectTestDb);
afterEach(clearTestDb);
// clearTestDb only empties documents — an index outlives it and would poison
// the next test, so the stale one is torn down explicitly.
afterEach(async () => {
  try { await mongoose.connection.db!.collection('merchants').dropIndex('loginCode_1'); } catch { /* already gone */ }
});
afterAll(disconnectTestDb);

const merchants = () => mongoose.connection.db!.collection('merchants');

/**
 * The index the old schema declared: `loginCode: { unique: true, index: true }`.
 * Mongoose will NOT create it for us now that the field is gone, so a test that
 * skips this step proves nothing.
 */
async function createStaleIndex(): Promise<void> {
  await merchants().createIndex({ loginCode: 1 }, { unique: true, name: 'loginCode_1' });
}

async function indexNames(): Promise<string[]> {
  return (await merchants().indexes()).map((i: any) => i.name);
}

/** A stall as the OLD schema stored it: credentials on the place, PIN already bcrypt-hashed. */
async function insertLegacyStall(opts: { name: string; loginCode: string; pin: string; status?: 'active' | 'suspended' }) {
  const eventId = new mongoose.Types.ObjectId();
  const pinHash = await bcrypt.hash(opts.pin, 4); // low rounds: test speed, same shape
  const { insertedId } = await merchants().insertOne({
    name: opts.name,
    eventId,
    commissionPercent: 10,
    status: opts.status ?? 'active',
    loginCode: opts.loginCode,
    pin: pinHash,
    failedPinAttempts: 2,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { stallId: insertedId, eventId, pinHash };
}

it('the stale index really does break the second credential-less stall (the bug being fixed)', async () => {
  // Negative control. Without this the headline assertion below could pass for
  // the wrong reason — you cannot tell a fix from an absent bug.
  await createStaleIndex();
  const eventId = new mongoose.Types.ObjectId();

  await Merchant.create({ name: 'Side Bar', eventId });
  await expect(Merchant.create({ name: 'Gin Bar', eventId })).rejects.toThrow(/E11000/);
});

it('drops the stale index so credential-less stalls can be created again', async () => {
  await createStaleIndex();
  expect(await indexNames()).toContain('loginCode_1');

  const result = await migrateMerchantCredentials();

  expect(result.indexDropped).toBe(true);
  expect(await indexNames()).not.toContain('loginCode_1');

  // THE assertion that matters: two stalls with no loginCode at all. Before the
  // drop the second of these threw E11000 { loginCode: null } (test above).
  const eventId = new mongoose.Types.ObjectId();
  await expect(Merchant.create({ name: 'Side Bar', eventId })).resolves.toBeTruthy();
  await expect(Merchant.create({ name: 'Gin Bar', eventId })).resolves.toBeTruthy();
  expect(await Merchant.countDocuments({ eventId })).toBe(2);
});

it('carries each stall login onto a MerchantOperator with the hash intact', async () => {
  await createStaleIndex();
  const a = await insertLegacyStall({ name: 'Main Bar', loginCode: '4KZ903', pin: '445566' });
  const b = await insertLegacyStall({ name: 'VIP Bar', loginCode: '4KZ904', pin: '778899' });

  const result = await migrateMerchantCredentials();
  expect(result.legacyStalls).toBe(2);
  expect(result.operatorsCreated).toBe(2);

  const opA = await MerchantOperator.findOne({ loginCode: '4KZ903' }).select('+pin');
  expect(opA).toBeTruthy();
  expect(String(opA!.merchantId)).toBe(String(a.stallId));
  expect(String(opA!.eventId)).toBe(String(a.eventId));
  expect(opA!.isActive).toBe(true);
  expect(opA!.failedPinAttempts).toBe(2); // lockout bookkeeping carried, not reset

  // The hash must cross VERBATIM. Re-hashing an already-hashed PIN produces a
  // value that verifies against nothing, silently locking every operator out —
  // and it would still look like a well-formed bcrypt string.
  expect(opA!.pin).toBe(a.pinHash);
  expect(await bcrypt.compare('445566', opA!.pin)).toBe(true);

  const opB = await MerchantOperator.findOne({ loginCode: '4KZ904' }).select('+pin');
  expect(opB!.pin).toBe(b.pinHash);
  expect(await bcrypt.compare('778899', opB!.pin)).toBe(true);
});

it('leaves the migrated staff able to log in with the code and PIN they already have', async () => {
  await createStaleIndex();
  const { stallId } = await insertLegacyStall({ name: 'Main Bar', loginCode: '4KZ903', pin: '445566' });

  await migrateMerchantCredentials();

  // End to end through the real service — the whole point of step 1.
  const result = await MerchantAuthService.login('4KZ903', '445566');
  const token = MerchantAuthService.verifyToken(result.accessToken);
  expect(token.merchantId).toBe(String(stallId));
  expect(token.name).toBe('Main Bar');
  expect(token.merchantOperatorId).toBeTruthy();
});

it('carries a suspended stall over as an INACTIVE operator', async () => {
  await createStaleIndex();
  await insertLegacyStall({ name: 'Closed Bar', loginCode: '4KZ905', pin: '112233', status: 'suspended' });

  await migrateMerchantCredentials();

  const op = await MerchantOperator.findOne({ loginCode: '4KZ905' });
  expect(op!.isActive).toBe(false);
  await expect(MerchantAuthService.login('4KZ905', '112233')).rejects.toThrow('Invalid credentials');
});

it('clears the dead credential fields off the stall documents', async () => {
  await createStaleIndex();
  const { stallId } = await insertLegacyStall({ name: 'Main Bar', loginCode: '4KZ903', pin: '445566' });

  await migrateMerchantCredentials();

  const raw = await merchants().findOne({ _id: stallId });
  expect(raw).toBeTruthy();
  for (const dead of ['loginCode', 'pin', 'failedPinAttempts', 'lockedUntil', 'lastLoginAt']) {
    expect(raw).not.toHaveProperty(dead);
  }
  expect(raw!['name']).toBe('Main Bar'); // and nothing else was touched
  expect(raw!['commissionPercent']).toBe(10);
});

it('is idempotent — a second run neither throws nor duplicates operators', async () => {
  await createStaleIndex();
  await insertLegacyStall({ name: 'Main Bar', loginCode: '4KZ903', pin: '445566' });

  const first = await migrateMerchantCredentials();
  expect(first.operatorsCreated).toBe(1);
  expect(first.indexDropped).toBe(true);

  const second = await migrateMerchantCredentials();
  expect(second.legacyStalls).toBe(0);
  expect(second.operatorsCreated).toBe(0);
  expect(second.indexDropped).toBe(false); // IndexNotFound swallowed, not rethrown

  expect(await MerchantOperator.countDocuments({ loginCode: '4KZ903' })).toBe(1);
  expect(await bcrypt.compare('445566', (await MerchantOperator.findOne({ loginCode: '4KZ903' }).select('+pin'))!.pin)).toBe(true);
});

it('runs clean on a database that never had the index or any legacy stall', async () => {
  const result = await migrateMerchantCredentials();
  expect(result).toEqual({ legacyStalls: 0, operatorsCreated: 0, indexDropped: false });
});

it('skips a stall whose login code was already claimed by an operator', async () => {
  await createStaleIndex();
  const { stallId } = await insertLegacyStall({ name: 'Main Bar', loginCode: '4KZ903', pin: '445566' });
  // A half-finished earlier run, or an operator an organizer created by hand.
  await new MerchantOperator({
    fullName: 'Thabo Dlamini', merchantId: stallId, eventId: new mongoose.Types.ObjectId(),
    loginCode: '4KZ903', pin: '445566',
  }).save();

  const result = await migrateMerchantCredentials();

  expect(result.operatorsCreated).toBe(0);
  expect(await MerchantOperator.countDocuments({ loginCode: '4KZ903' })).toBe(1);
  // the real person's name survived — the migration did not overwrite them
  expect((await MerchantOperator.findOne({ loginCode: '4KZ903' }))!.fullName).toBe('Thabo Dlamini');
});
