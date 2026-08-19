// api/src/models/__tests__/merchantOperator.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { MerchantOperator } from '@models/merchantOperator.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// Per-file incrementing sequence, not Math.random() — a random pick over ~9
// variants collides across the it() blocks below and flakes. Starting value
// is arbitrary Crockford base32 (no I/L/O/U) that reads like a real login
// code, e.g. '4KZ9P2' — see task-4 report for why literal digit strings like
// '123456' are avoided here.
let __loginCodeSeq = 400;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

const base = () => ({
  fullName: 'Thabo Dlamini',
  merchantId: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId(),
  loginCode: nextLoginCode(),
  pin: '123456',
});

it('requires a merchantId', async () => {
  const { merchantId, ...withoutMerchant } = base();
  await expect(new MerchantOperator(withoutMerchant).save()).rejects.toThrow(/merchantId/);
});

it('hashes the pin and never serializes it', async () => {
  const op = await new MerchantOperator(base()).save();
  expect(op.pin).not.toBe('123456');
  expect(await op.comparePin('123456')).toBe(true);
  expect(JSON.parse(JSON.stringify(op)).pin).toBeUndefined();
});

it('refuses to move an operator to another stall', async () => {
  const op = await new MerchantOperator(base()).save();
  const original = op.merchantId.toString();
  op.merchantId = new mongoose.Types.ObjectId();
  await op.save();
  // Assert against a document reloaded from the database, not the in-memory
  // one — mongoose can silently no-op the assignment above without the
  // schema's `immutable: true` doing anything, and an in-memory-only
  // assertion would pass either way. Reloading is the only check that
  // actually proves persistence-level immutability held.
  const reloaded = await MerchantOperator.findById(op._id);
  expect(reloaded!.merchantId.toString()).toBe(original);
});
