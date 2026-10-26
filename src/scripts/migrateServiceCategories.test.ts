import { connectTestDb, disconnectTestDb, clearTestDb } from '../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { migrateServiceCategories } from './migrateServiceCategories';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

it('moves existing selections once and preserves new multi-category profiles', async () => {
  const legacy = await Vendor.collection.insertOne({ businessName: 'Legacy', slug: 'legacy', email: 'legacy@example.com', phoneNumber: '+26876000001', serviceCategory: 'sound_hire' });
  const current = await Vendor.collection.insertOne({ businessName: 'Current', slug: 'current', email: 'current@example.com', phoneNumber: '+26876000002', serviceCategories: ['sound_hire', 'catering'] });
  await migrateServiceCategories();
  await migrateServiceCategories();
  const migrated = await Vendor.collection.findOne({ _id: legacy.insertedId });
  expect(migrated?.['serviceCategories']).toEqual(['sound_hire']);
  expect(migrated).not.toHaveProperty('serviceCategory');
  expect((await Vendor.collection.findOne({ _id: current.insertedId }))?.['serviceCategories']).toEqual(['sound_hire', 'catering']);
});
