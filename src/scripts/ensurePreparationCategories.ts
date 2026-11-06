import { ServiceCategory } from '@models/serviceCategory.model';
import { PREPARATION_CATEGORIES } from '@models/preparation.model';
import { SERVICE_CATEGORIES } from '@/constants/serviceCategories';

/** Add attendee service categories without changing existing admin labels,
 * ordering or activation decisions. Runs before the API accepts traffic. */
export async function ensurePreparationCategories(): Promise<void> {
  const categories = SERVICE_CATEGORIES.filter(category => (PREPARATION_CATEGORIES as readonly string[]).includes(category.value));
  await ServiceCategory.bulkWrite(categories.map((category, index) => ({
    updateOne: {
      filter: { value: category.value },
      update: { $setOnInsert: { value: category.value, label: category.label, order: 100 + index, isActive: true } },
      upsert: true,
    },
  })));
}
