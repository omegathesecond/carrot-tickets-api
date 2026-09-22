// api/src/scripts/__tests__/migrateWeekendIndexes.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { migrateWeekendIndexes } from '@/scripts/migrate-weekend-indexes';
import { WeekendStatus } from '@models/weekendStatus.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const indexes = () => mongoose.connection.collection('weekendstatuses').indexes() as Promise<any[]>;
const byName = async (name: string) => (await indexes()).find((i) => i.name === name);

/** The shape prod is in before this deploy: buyerId_1 plain unique. */
async function createLegacyIndex() {
  const col = mongoose.connection.collection('weekendstatuses');
  const existing = await indexes().catch(() => []);
  if (existing.find((i) => i.name === 'buyerId_1')) await col.dropIndex('buyerId_1');
  await col.createIndex({ buyerId: 1 }, { unique: true, name: 'buyerId_1' });
}

function baseFields(buyerId: mongoose.Types.ObjectId) {
  const now = new Date();
  const weekendEnd = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  return {
    buyerId,
    statusType: 'have_plans' as const,
    audience: 'public' as const,
    weekendStart: now,
    weekendEnd,
    activeUntil: weekendEnd,
  };
}

describe('migrating the weekendstatuses collection off the legacy unique buyerId index', () => {
  it('drops the legacy plain-unique buyerId_1 index', async () => {
    await createLegacyIndex();
    expect((await byName('buyerId_1'))?.unique).toBe(true);

    await migrateWeekendIndexes();

    expect(await byName('buyerId_1')).toBeUndefined();
  });

  it('lets a buyer have a second plan_post row once migrated — the whole point', async () => {
    await createLegacyIndex();
    const buyerId = new mongoose.Types.ObjectId();

    // Before: two rows for the same buyer both index on buyerId and the
    // second is rejected. This is the production symptom (E11000 on
    // buyerId_1) the migration exists to remove.
    await WeekendStatus.create({ ...baseFields(buyerId), source: 'plan_post' });
    await expect(
      WeekendStatus.create({ ...baseFields(buyerId), source: 'plan_post' })
    ).rejects.toThrow(/duplicate key|E11000/i);

    await migrateWeekendIndexes();

    const second = await WeekendStatus.create({ ...baseFields(buyerId), source: 'plan_post' });
    expect(second.buyerId).toEqual(buyerId);

    const count = await WeekendStatus.countDocuments({ buyerId });
    expect(count).toBe(2);
  });

  it('still enforces idempotent creation on a repeated clientRequestId afterwards', async () => {
    await createLegacyIndex();
    await migrateWeekendIndexes();

    const buyerId = new mongoose.Types.ObjectId();
    await WeekendStatus.create({ ...baseFields(buyerId), source: 'plan_post', clientRequestId: 'req-1' });
    await expect(
      WeekendStatus.create({ ...baseFields(buyerId), source: 'plan_post', clientRequestId: 'req-1' })
    ).rejects.toThrow(/duplicate key|E11000/i);
  });

  it('is inert on a second run — it must not churn a live index every boot', async () => {
    await createLegacyIndex();
    await migrateWeekendIndexes();
    const first = await indexes();

    await migrateWeekendIndexes();
    const second = await indexes();

    expect(second.map((i) => i.name).sort()).toEqual(first.map((i) => i.name).sort());
  });

  it('is safe on an environment that has never had the collection', async () => {
    await mongoose.connection.collection('weekendstatuses').drop().catch(() => undefined);
    await expect(migrateWeekendIndexes()).resolves.toBeUndefined();
    expect(await byName('buyerId_1')).toBeUndefined();
  });
});
