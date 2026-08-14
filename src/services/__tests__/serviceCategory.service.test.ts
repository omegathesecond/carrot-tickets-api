import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { ServiceCategory } from '@models/serviceCategory.model';
import { ServiceCategoryService } from '@services/serviceCategory.service';
import { seedServiceCategories } from '../../scripts/seed-service-categories';
import { SERVICE_CATEGORIES } from '@/constants/serviceCategories';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('seedServiceCategories', () => {
  it('upserts all 11 categories from the constant', async () => {
    await seedServiceCategories();
    const count = await ServiceCategory.countDocuments({});
    expect(count).toBe(SERVICE_CATEGORIES.length);
    expect(count).toBe(11);
  });

  it('is idempotent — running it twice still leaves 11 rows', async () => {
    await seedServiceCategories();
    await seedServiceCategories();
    const count = await ServiceCategory.countDocuments({});
    expect(count).toBe(11);
  });

  it('never reactivates a category an admin has disabled', async () => {
    await seedServiceCategories();
    await ServiceCategory.updateOne({ value: 'sound_hire' }, { $set: { isActive: false } });
    await seedServiceCategories();
    const row = await ServiceCategory.findOne({ value: 'sound_hire' });
    expect(row?.isActive).toBe(false);
  });
});

describe('ServiceCategoryService.listActive', () => {
  it('excludes an isActive:false row and sorts by order', async () => {
    await ServiceCategory.create({ value: 'zeta', label: 'Zeta', order: 2, isActive: true });
    await ServiceCategory.create({ value: 'alpha', label: 'Alpha', order: 1, isActive: true });
    await ServiceCategory.create({ value: 'disabled_one', label: 'Disabled One', order: 0, isActive: false });

    const active = await ServiceCategoryService.listActive();
    expect(active.map((c) => c.value)).toEqual(['alpha', 'zeta']);
    expect(active.find((c) => c.value === 'disabled_one')).toBeUndefined();
  });
});

describe('ServiceCategoryService.isValidActive', () => {
  it('is true for a seeded, active value', async () => {
    await seedServiceCategories();
    expect(await ServiceCategoryService.isValidActive('sound_hire')).toBe(true);
  });

  it('is false for an unknown value', async () => {
    await seedServiceCategories();
    expect(await ServiceCategoryService.isValidActive('bouncy_castle')).toBe(false);
  });

  it('is false for a disabled value', async () => {
    await seedServiceCategories();
    await ServiceCategory.updateOne({ value: 'sound_hire' }, { $set: { isActive: false } });
    expect(await ServiceCategoryService.isValidActive('sound_hire')).toBe(false);
  });
});

describe('ServiceCategoryService admin CRUD', () => {
  it('create() rejects a duplicate value with HttpError(409)', async () => {
    await ServiceCategoryService.create({ value: 'sound_hire', label: 'Sound hire' });
    await expect(ServiceCategoryService.create({ value: 'sound_hire', label: 'Sound Hire Again' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('update() throws HttpError(404) for a missing id', async () => {
    await expect(ServiceCategoryService.update('000000000000000000000000', { label: 'X' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('update() does not accept a value change (value is immutable)', async () => {
    const created = await ServiceCategoryService.create({ value: 'sound_hire', label: 'Sound hire' });
    const updated = await ServiceCategoryService.update(created.id, { label: 'Renamed', isActive: false } as any);
    expect(updated.label).toBe('Renamed');
    expect(updated.isActive).toBe(false);
    expect(updated.value).toBe('sound_hire');
  });

  it('list() returns all rows including inactive ones', async () => {
    await ServiceCategoryService.create({ value: 'active_one', label: 'Active One' });
    const created = await ServiceCategoryService.create({ value: 'inactive_one', label: 'Inactive One' });
    await ServiceCategoryService.update(created.id, { isActive: false });

    const all = await ServiceCategoryService.list();
    expect(all.map((c) => c.value).sort()).toEqual(['active_one', 'inactive_one']);
  });
});
