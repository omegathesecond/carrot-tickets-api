import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import mongoose from 'mongoose';
import { ResellerCommissionWithdrawal } from '../resellerCommissionWithdrawal.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('creates a withdrawal defaulting to requested', async () => {
  const w = await ResellerCommissionWithdrawal.create({
    resellerId: new mongoose.Types.ObjectId(),
    amount: 150,
    requestedBy: 'op-1',
    requestedAt: new Date(),
    snapshotAt: new Date(),
  });
  expect(w.status).toBe('requested');
});
