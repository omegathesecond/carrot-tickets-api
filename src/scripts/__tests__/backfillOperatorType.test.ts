import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { backfillOperatorType } from '../backfillOperatorType';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

it('fills missing operatorType with events, idempotently, without overwriting', async () => {
  // insert raw docs bypassing the schema default to simulate pre-migration rows
  await mongoose.connection.collection('vendors').insertMany([
    { businessName: 'Legacy A', password: 'x', slug: 'legacy-a' },
    { businessName: 'Legacy B', password: 'x', slug: 'legacy-b' },
  ] as any);
  const transport = await Vendor.create({ businessName: 'Bus', phoneNumber: '+268760000010', password: 'secret1', operatorType: 'transport' });

  const first = await backfillOperatorType();
  expect(first.updated).toBe(2);
  const again = await backfillOperatorType();
  expect(again.updated).toBe(0); // idempotent

  const a = await Vendor.findOne({ slug: 'legacy-a' });
  expect(a?.operatorType).toBe('events');
  const t = await Vendor.findById(transport._id);
  expect(t?.operatorType).toBe('transport'); // untouched
});
