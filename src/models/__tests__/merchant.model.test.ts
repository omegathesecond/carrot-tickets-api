// api/src/models/__tests__/merchant.model.test.ts
//
// A stall holds no credentials any more, so merchantSchema declares neither
// `loginCode` nor `pin` — and that is precisely why both are still stripped in
// its toJSON/toObject transforms. Mongoose HYDRATES fields that exist in the
// DATABASE but not in the schema and serializes them, so until
// migrate-merchant-credentials.ts has run, a legacy stall round-trips its old
// loginCode and its bcrypt PIN HASH into every admin response that returns a
// merchant document (MerchantAdminController.list / .transactions).
//
// The legacy row is inserted through the RAW DRIVER on purpose: Mongoose's
// strict mode drops undeclared fields on write, so seeding through the model
// would prove nothing — the fields cannot be set that way at all.
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Merchant } from '@models/merchant.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const LEGACY_LOGIN_CODE = '800123';
const LEGACY_PIN_HASH = '$2b$10$K4Xq1oR7uJ8pWm2ZbN0dLeYhVtC3sA6gF9iQxDrTvUyOwPzEnMlBa';

const merchants = () => mongoose.connection.db!.collection('merchants');

/** A stall exactly as the OLD schema stored it: credentials on the place. */
async function insertLegacyStall(): Promise<string> {
  const { insertedId } = await merchants().insertOne({
    name: 'Legacy Stall',
    eventId: new mongoose.Types.ObjectId(),
    commissionPercent: 10,
    status: 'active',
    loginCode: LEGACY_LOGIN_CODE,
    pin: LEGACY_PIN_HASH,
    // Undeclared too, and deliberately NOT stripped — the control below.
    failedPinAttempts: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return String(insertedId);
}

it('the fixture really is a legacy row — the raw document carries both credentials', async () => {
  // Guards the two tests below from passing vacuously: if the insert had
  // dropped these fields, "no pin in the output" would prove nothing.
  const id = await insertLegacyStall();
  const raw = await merchants().findOne({ _id: new mongoose.Types.ObjectId(id) });
  expect(raw!['loginCode']).toBe(LEGACY_LOGIN_CODE);
  expect(raw!['pin']).toBe(LEGACY_PIN_HASH);
});

it('findById never serializes a legacy stall\'s pin hash or loginCode', async () => {
  const id = await insertLegacyStall();

  const serialized = JSON.parse(JSON.stringify(await Merchant.findById(id)));

  expect(serialized.pin).toBeUndefined();
  expect(serialized.loginCode).toBeUndefined();

  // The CONTROL. `failedPinAttempts` is just as undeclared as pin/loginCode
  // and comes back intact, which proves Mongoose does hydrate undeclared
  // fields here — so the two above are absent because the TRANSFORM removed
  // them, not because Mongoose never loaded them.
  expect(serialized.failedPinAttempts).toBe(3);
  expect(serialized.name).toBe('Legacy Stall');
});

it('find() — the shape MerchantAdminController.list hands to the dashboard — is clean too', async () => {
  await insertLegacyStall();

  const serialized = JSON.parse(JSON.stringify(await Merchant.find({})));

  expect(serialized).toHaveLength(1);
  expect(serialized[0].pin).toBeUndefined();
  expect(serialized[0].loginCode).toBeUndefined();
  expect(serialized[0].failedPinAttempts).toBe(3); // control, as above
});

it('toObject strips them as well as toJSON', async () => {
  const id = await insertLegacyStall();

  const obj = (await Merchant.findById(id))!.toObject() as Record<string, unknown>;

  expect(obj['pin']).toBeUndefined();
  expect(obj['loginCode']).toBeUndefined();
  expect(obj['failedPinAttempts']).toBe(3); // control, as above
});
