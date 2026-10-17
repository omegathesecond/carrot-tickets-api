import { Vendor } from '@models/vendor.model';

/** Move existing provider selections to the array schema before serving traffic. */
export async function migrateServiceCategories(): Promise<void> {
  await Vendor.collection.updateMany(
    { serviceCategory: { $type: 'string' }, serviceCategories: { $exists: false } },
    [{ $set: { serviceCategories: ['$serviceCategory'] } }, { $unset: 'serviceCategory' }],
  );
}
