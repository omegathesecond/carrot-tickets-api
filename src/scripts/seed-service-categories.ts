/**
 * Seeds the `servicecategories` collection from the SERVICE_CATEGORIES
 * constant (src/constants/serviceCategories.ts) — the 11 categories the
 * events/services signup flow originally shipped with, hardcoded. The
 * constant is now only the SEED source: reads go through
 * ServiceCategoryService against the DB (see src/models/serviceCategory.model.ts),
 * so an admin can add/edit/retire a category with no code deploy.
 *
 * Idempotent: each category is upserted by `value` with the constant's
 * current label/order every run, via $set — but isActive is only set via
 * $setOnInsert, so re-running this script NEVER reactivates a category an
 * admin has since disabled through the admin API. Safe to re-run against
 * BOTH dev and prod DBs.
 *
 *   MONGODB_URI='...' npm run seed:service-categories
 */
import mongoose from 'mongoose';
import { ServiceCategory } from '@models/serviceCategory.model';
import { SERVICE_CATEGORIES } from '@/constants/serviceCategories';

export async function seedServiceCategories(): Promise<void> {
  for (const [index, cat] of SERVICE_CATEGORIES.entries()) {
    await ServiceCategory.updateOne(
      { value: cat.value },
      {
        $set: { label: cat.label, order: index },
        $setOnInsert: { isActive: true },
      },
      { upsert: true }
    );
    console.log(`[seed-service-categories] upserted "${cat.value}"`);
  }

  const count = await ServiceCategory.countDocuments({});
  console.log(`[seed-service-categories] ${count} service categories in the collection`);
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri, { autoIndex: false });
    console.log('[seed-service-categories] connected (autoIndex disabled)');
    await seedServiceCategories();
    await mongoose.disconnect();
    console.log('[seed-service-categories] done');
  })().catch((err) => {
    console.error('[seed-service-categories] failed:', err);
    process.exit(1);
  });
}
