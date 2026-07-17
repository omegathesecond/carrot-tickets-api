import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';

const eventId = new mongoose.Types.ObjectId();

describe('Wallet model', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('defaults a new wallet to an active, empty, unbound ZAR wallet', async () => {
    const w = await Wallet.create({ eventId, buyerId: new mongoose.Types.ObjectId() });
    expect(w.balance).toBe(0);
    expect(w.cashFundedBalance).toBe(0);
    expect(w.status).toBe('active');
    expect(w.currency).toBe('ZAR');
    expect(w.bandUid).toBeNull();
  });

  it('rejects a negative balance', async () => {
    await expect(
      Wallet.create({ eventId, balance: -1 }),
    ).rejects.toThrow(/balance/);
  });

  it('rejects a non-integer balance (money is integer cents)', async () => {
    await expect(
      Wallet.create({ eventId, balance: 10.5 }),
    ).rejects.toThrow(/integer minor units/);
  });

  it('rejects cashFundedBalance greater than balance', async () => {
    await expect(
      Wallet.create({ eventId, balance: 100, cashFundedBalance: 101 }),
    ).rejects.toThrow(/cashFundedBalance cannot exceed balance/);
  });

  it('allows MANY unbound wallets in one event (partial index must not collide on null)', async () => {
    await Wallet.create({ eventId, buyerId: new mongoose.Types.ObjectId() });
    await Wallet.create({ eventId, buyerId: new mongoose.Types.ObjectId() });
    await Wallet.create({ eventId, buyerId: new mongoose.Types.ObjectId() });
    expect(await Wallet.countDocuments({ eventId, bandUid: null })).toBe(3);
  });

  it('refuses two wallets bound to the same band UID in one event', async () => {
    await Wallet.create({ eventId, bandUid: 'AABBCC01' });
    await expect(
      Wallet.create({ eventId, bandUid: 'AABBCC01' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows the same band UID in a DIFFERENT event (wallets are per-event closed-loop)', async () => {
    const other = new mongoose.Types.ObjectId();
    await Wallet.create({ eventId, bandUid: 'AABBCC02' });
    const w = await Wallet.create({ eventId: other, bandUid: 'AABBCC02' });
    expect(w.bandUid).toBe('AABBCC02');
  });
});
