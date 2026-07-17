import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService } from '@services/wallet.service';
import { Wallet } from '@models/wallet.model';

const eventId = new mongoose.Types.ObjectId().toString();
const buyerId = new mongoose.Types.ObjectId().toString();

describe('WalletService.ensureWallet', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('creates an active empty wallet for a new attendee', async () => {
    const w = await WalletService.ensureWallet(eventId, buyerId);
    expect(w.balance).toBe(0);
    expect(w.status).toBe('active');
    expect(String(w.eventId)).toBe(eventId);
  });

  it('is idempotent — the same attendee gets the SAME wallet, not a second one', async () => {
    const a = await WalletService.ensureWallet(eventId, buyerId);
    const b = await WalletService.ensureWallet(eventId, buyerId);
    expect(String(a._id)).toBe(String(b._id));
    expect(await Wallet.countDocuments({ eventId, buyerId })).toBe(1);
  });

  it('never creates two wallets under concurrent calls', async () => {
    await Promise.all([
      WalletService.ensureWallet(eventId, buyerId),
      WalletService.ensureWallet(eventId, buyerId),
      WalletService.ensureWallet(eventId, buyerId),
    ]);
    expect(await Wallet.countDocuments({ eventId, buyerId })).toBe(1);
  });

  it('gives the same attendee a SEPARATE wallet per event (closed-loop)', async () => {
    const other = new mongoose.Types.ObjectId().toString();
    const a = await WalletService.ensureWallet(eventId, buyerId);
    const b = await WalletService.ensureWallet(other, buyerId);
    expect(String(a._id)).not.toBe(String(b._id));
  });

  /**
   * The concurrency test above does NOT reach the E11000 catch, so it cannot
   * cover it: those calls routinely serialise, and MongoDB additionally retries
   * a findAndModify upsert server-side when the duplicate key comes from an
   * index on exactly the filter's fields — which is this case. It would pass
   * with the whole catch block deleted. These stub the duplicate-key error in
   * directly so the catch is the only thing under test.
   */
  describe('duplicate-key (E11000) handling', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    const dupKeyError = (keyPattern: Record<string, number>) =>
      Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyPattern });

    it('lost the insert race — returns the winner wallet already in the DB', async () => {
      const winner = await WalletService.ensureWallet(eventId, buyerId);
      jest.spyOn(Wallet, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw dupKeyError({ eventId: 1, buyerId: 1 });
      });

      const w = await WalletService.ensureWallet(eventId, buyerId);

      expect(String(w._id)).toBe(String(winner._id));
      expect(w.balance).toBe(0);
      expect(w.status).toBe('active');
      expect(await Wallet.countDocuments({ eventId, buyerId })).toBe(1);
    });

    it('rethrows E11000 when no winner exists — never invents a wallet', async () => {
      jest.spyOn(Wallet, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw dupKeyError({ eventId: 1, buyerId: 1 });
      });

      await expect(WalletService.ensureWallet(eventId, buyerId)).rejects.toThrow('E11000');
      expect(await Wallet.countDocuments({ eventId, buyerId })).toBe(0);
    });

    it('rethrows an E11000 raised by a DIFFERENT index even when a wallet matches', async () => {
      await WalletService.ensureWallet(eventId, buyerId);
      jest.spyOn(Wallet, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw dupKeyError({ eventId: 1, bandUid: 1 }); // not the buyerId race
      });

      await expect(WalletService.ensureWallet(eventId, buyerId)).rejects.toThrow('E11000');
    });
  });
});
