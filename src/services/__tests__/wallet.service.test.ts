import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService } from '@services/wallet.service';
import { Wallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';

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

describe('WalletService.bindBand', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('binds a blank band to an unbound wallet and records the binding', async () => {
    const w = await WalletService.ensureWallet(eventId, buyerId);
    const bound = await WalletService.bindBand(String(w._id), 'AABBCC01', 'gate-op-1');

    expect(bound.bandUid).toBe('AABBCC01');
    const audit = await BandBinding.find({ walletId: w._id });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.bandUid).toBe('AABBCC01');
    expect(audit[0]?.unboundAt).toBeUndefined();
    expect(audit[0]?.boundBy).toBe('gate-op-1');
  });

  it('refuses to bind a UID already live on another wallet in the same event', async () => {
    const a = await WalletService.ensureWallet(eventId, buyerId);
    const b = await WalletService.ensureWallet(eventId, new mongoose.Types.ObjectId().toString());
    await WalletService.bindBand(String(a._id), 'AABBCC01');

    await expect(WalletService.bindBand(String(b._id), 'AABBCC01')).rejects.toThrow(
      'band is already bound to another wallet at this event',
    );
    // The loser must not get a half-written audit row.
    expect(await BandBinding.countDocuments({ walletId: b._id })).toBe(0);
  });

  it('refuses to bind a second band to a wallet that already has one', async () => {
    const w = await WalletService.ensureWallet(eventId, buyerId);
    await WalletService.bindBand(String(w._id), 'AABBCC01');
    await expect(WalletService.bindBand(String(w._id), 'AABBCC02')).rejects.toThrow(
      'wallet already has a band bound',
    );
  });

  it('refuses to bind to a closed wallet', async () => {
    const w = await WalletService.ensureWallet(eventId, buyerId);
    await Wallet.updateOne({ _id: w._id }, { $set: { status: 'closed' } });
    await expect(WalletService.bindBand(String(w._id), 'AABBCC03')).rejects.toThrow(
      'wallet is not active',
    );
  });

  it('only one of many concurrent binds of the SAME uid wins', async () => {
    const wallets = await Promise.all([
      WalletService.ensureWallet(eventId, new mongoose.Types.ObjectId().toString()),
      WalletService.ensureWallet(eventId, new mongoose.Types.ObjectId().toString()),
      WalletService.ensureWallet(eventId, new mongoose.Types.ObjectId().toString()),
    ]);
    const results = await Promise.allSettled(
      wallets.map((w) => WalletService.bindBand(String(w._id), 'SAMEUID1')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await Wallet.countDocuments({ eventId, bandUid: 'SAMEUID1' })).toBe(1);
  });
});
