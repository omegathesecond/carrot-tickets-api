// api/src/models/__tests__/resellerOperator.credentials.test.ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerOperator } from '@models/resellerOperator.model';
import mongoose from 'mongoose';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('hashes the pin on save and comparePin verifies it', async () => {
  const op = await ResellerOperator.create({
    hubId: new mongoose.Types.ObjectId(),
    resellerId: new mongoose.Types.ObjectId(),
    fullName: 'Cred Test',
    loginCode: '900001',
    pin: '246810',
    role: 'reseller_operator',
  });
  const withPin = await ResellerOperator.findById(op._id).select('+pin');
  expect(withPin!.pin).not.toBe('246810');         // hashed
  expect(await withPin!.comparePin('246810')).toBe(true);
  expect(await withPin!.comparePin('000000')).toBe(false);
});
