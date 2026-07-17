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
});
