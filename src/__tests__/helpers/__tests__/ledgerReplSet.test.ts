import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../mongo';

/**
 * The cashless ledger commits a wallet balance mutation and its double-entry
 * postings in ONE transaction, so its suites need a replica set — MongoDB
 * rejects transactions on a standalone mongod. connectLedgerTestDb() provides
 * that; connectTestDb() (standalone) deliberately does not.
 */
describe('test harness: ledger replica set', () => {
  // A replica set takes longer to start than the 30s default hook budget allows
  // under full-suite CPU load. Scoped here rather than raising it globally.
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const Thing = mongoose.model('ReplSetHarnessThing', new mongoose.Schema({ name: String }));

  it('commits a multi-document transaction', async () => {
    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await Thing.create([{ name: 'a' }], { session });
      await Thing.create([{ name: 'b' }], { session });
    });
    await session.endSession();

    expect(await Thing.countDocuments({})).toBe(2);
  });

  it('rolls a failed transaction back atomically', async () => {
    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => {
        await Thing.create([{ name: 'c' }], { session });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await session.endSession();

    // The write inside the aborted transaction must leave nothing behind —
    // this is what lets the ledger keep balance and postings consistent.
    expect(await Thing.countDocuments({})).toBe(0);
  });
});
