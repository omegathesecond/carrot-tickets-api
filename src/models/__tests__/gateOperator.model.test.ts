// api/src/models/__tests__/gateOperator.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('creates a platform-scoped operator with no vendorId', async () => {
  const op = await GateOperator.create({ fullName: 'Gate A', loginCode: '800001', pin: '111111', scope: 'platform' });
  expect(op.scope).toBe('platform');
  expect(op.vendorId).toBeUndefined();
});

it('hashes the pin and never serializes it', async () => {
  const op = await GateOperator.create({ fullName: 'Gate B', loginCode: '800002', pin: '222222', scope: 'organizer', vendorId: new mongoose.Types.ObjectId() });
  const withPin = await GateOperator.findById(op._id).select('+pin');
  expect(await withPin!.comparePin('222222')).toBe(true);
  expect(JSON.parse(JSON.stringify(op)).pin).toBeUndefined();
});

it('rejects an invalid scope', async () => {
  await expect(GateOperator.create({ fullName: 'Bad', loginCode: '800003', pin: '333333', scope: 'whoever' as any }))
    .rejects.toThrow();
});
