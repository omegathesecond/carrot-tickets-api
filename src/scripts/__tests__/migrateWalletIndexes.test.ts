// api/src/scripts/__tests__/migrateWalletIndexes.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { migrateWalletIndexes } from '@/scripts/migrate-wallet-indexes';
import { Wallet } from '@models/wallet.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const indexes = () => mongoose.connection.collection('wallets').indexes() as Promise<any[]>;
const byName = async (name: string) => (await indexes()).find((i) => i.name === name);

/** The shape prod is in before this deploy: ticketId_1 plain unique. */
async function createLegacyIndex() {
  const col = mongoose.connection.collection('wallets');
  const existing = await indexes().catch(() => []);
  if (existing.find((i) => i.name === 'ticketId_1')) await col.dropIndex('ticketId_1');
  await col.createIndex({ ticketId: 1 }, { unique: true, name: 'ticketId_1' });
}

describe('migrating the wallets collection to a partial ticketId index', () => {
  it('replaces the legacy plain-unique index with the partial one', async () => {
    await createLegacyIndex();
    expect((await byName('ticketId_1'))?.partialFilterExpression).toBeUndefined();

    await migrateWalletIndexes();

    const after = await byName('ticketId_1');
    expect(after?.unique).toBe(true);
    expect(after?.partialFilterExpression).toEqual({ ticketId: { $exists: true } });
  });

  it('lets a second ticketless wallet exist once migrated — the whole point', async () => {
    await createLegacyIndex();
    // Before: two wallets with no ticket both index as null and the second is
    // rejected. This is the production symptom the migration exists to remove.
    await Wallet.create({
      eventId: new mongoose.Types.ObjectId(), bandUid: '04a22b01',
      balance: 0, cashFundedBalance: 0, status: 'active',
    });
    await expect(
      Wallet.create({
        eventId: new mongoose.Types.ObjectId(), bandUid: '04a22b02',
        balance: 0, cashFundedBalance: 0, status: 'active',
      }),
    ).rejects.toThrow(/duplicate key|E11000/i);

    await migrateWalletIndexes();

    const second = await Wallet.create({
      eventId: new mongoose.Types.ObjectId(), bandUid: '04a22b02',
      balance: 0, cashFundedBalance: 0, status: 'active',
    });
    expect(second.bandUid).toBe('04a22b02');
  });

  it('still enforces one wallet per ticket afterwards', async () => {
    await createLegacyIndex();
    await migrateWalletIndexes();

    const ticketId = new mongoose.Types.ObjectId();
    const eventId = new mongoose.Types.ObjectId();
    await Wallet.create({ eventId, ticketId, bandUid: '04a22b03', balance: 0, cashFundedBalance: 0, status: 'active' });
    await expect(
      Wallet.create({ eventId, ticketId, bandUid: '04a22b04', balance: 0, cashFundedBalance: 0, status: 'active' }),
    ).rejects.toThrow(/duplicate key|E11000/i);
  });

  it('is inert on a second run — it must not churn a live money index every boot', async () => {
    await createLegacyIndex();
    await migrateWalletIndexes();
    const first = await byName('ticketId_1');

    await migrateWalletIndexes();
    const second = await byName('ticketId_1');

    expect(second?.partialFilterExpression).toEqual(first?.partialFilterExpression);
    expect(second?.unique).toBe(true);
  });

  it('is safe on an environment that has never had the collection', async () => {
    await mongoose.connection.collection('wallets').drop().catch(() => undefined);
    await expect(migrateWalletIndexes()).resolves.toBeUndefined();
    expect((await byName('ticketId_1'))?.partialFilterExpression).toEqual({ ticketId: { $exists: true } });
  });
});
