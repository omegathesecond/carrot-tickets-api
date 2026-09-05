// api/src/models/__tests__/wallet.standalone.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';

const EVENT = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await connectTestDb();
  // The partial unique indexes ARE the thing under test here, so build them
  // explicitly rather than trusting autoIndex to have finished racing.
  await Wallet.syncIndexes();
});
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const standalone = (bandUid: string | null) => ({
  eventId: EVENT, bandUid, balance: 0, cashFundedBalance: 0, status: 'active' as const,
});

describe('a wallet is identified by a ticket OR by its band', () => {
  it('accepts a wallet with no ticket behind it', async () => {
    const w = await Wallet.create(standalone('04a22b1c'));
    expect(w.ticketId).toBeUndefined();
    expect(w.bandUid).toBe('04a22b1c');
  });

  it('lets two ticketless wallets coexist at one event', async () => {
    // The trap the bandUid index comment already documents: a SPARSE unique
    // index on ticketId would index both of these as null and reject the
    // second. The partial filter is what makes this work.
    await Wallet.create(standalone('04a22b01'));
    await Wallet.create(standalone('04a22b02'));
    expect(await Wallet.countDocuments({})).toBe(2);
  });

  it('still allows only one wallet per ticket', async () => {
    const ticketId = new mongoose.Types.ObjectId();
    await Wallet.create({ ...standalone('04a22b03'), ticketId });
    await expect(
      Wallet.create({ ...standalone('04a22b04'), ticketId }),
    ).rejects.toThrow(/duplicate key|E11000/i);
  });

  it('still allows only one wallet per band at an event', async () => {
    await Wallet.create(standalone('04a22b05'));
    await expect(Wallet.create(standalone('04a22b05'))).rejects.toThrow(/duplicate key|E11000/i);
  });

  it('refuses a wallet with neither a ticket nor a band', async () => {
    // Reachable by no lookup, and so unmanageable — the same reasoning that
    // refuses an organizer-scope gate operator with no vendorId.
    await expect(Wallet.create(standalone(null))).rejects.toThrow(/ticket or a band/i);
  });
});
