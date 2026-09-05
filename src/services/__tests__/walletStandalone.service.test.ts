// api/src/services/__tests__/walletStandalone.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { WalletService } from '@services/wallet.service';
import { Wallet } from '@models/wallet.model';

const EVENT = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  await connectTestDb();
  await Wallet.syncIndexes();
});
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('handing out a tag that carries no ticket', () => {
  it('gives the tag a wallet of its own', async () => {
    await enrolTags(EVENT, '04a22b1c');

    const { wallet, created } = await WalletService.ensureStandaloneWalletForBand({
      eventId: EVENT, bandUid: '04a22b1c',
    });

    expect(created).toBe(true);
    expect(wallet.bandUid).toBe('04a22b1c');
    expect(wallet.ticketId).toBeUndefined();
    expect(wallet.balance).toBe(0);
    expect(wallet.status).toBe('active');
  });

  it('normalises the uid the way every money path reads it', async () => {
    await enrolTags(EVENT, '04a22b1c');

    const { wallet } = await WalletService.ensureStandaloneWalletForBand({
      eventId: EVENT, bandUid: '04:A2:2B:1C',
    });

    // Stored canonical, so the cashier's Wallet.findOne({eventId, bandUid})
    // finds it — the exact failure the normalisation comment in bindBand warns about.
    expect(wallet.bandUid).toBe('04a22b1c');
  });

  it('is idempotent — tapping the same tag twice returns the same wallet', async () => {
    await enrolTags(EVENT, '04a22b1c');

    const first = await WalletService.ensureStandaloneWalletForBand({ eventId: EVENT, bandUid: '04a22b1c' });
    const second = await WalletService.ensureStandaloneWalletForBand({ eventId: EVENT, bandUid: '04a22b1c' });

    expect(second.created).toBe(false);
    expect(String(second.wallet._id)).toBe(String(first.wallet._id));
    expect(await Wallet.countDocuments({})).toBe(1);
  });

  it('refuses a tag the organizer never registered', async () => {
    await expect(
      WalletService.ensureStandaloneWalletForBand({ eventId: EVENT, bandUid: '04a22b1c' }),
    ).rejects.toThrow(/not registered for this event/i);
    // and leaves nothing behind — no orphan wallet from the two-step create
    expect(await Wallet.countDocuments({})).toBe(0);
  });

  it('refuses a tag that already belongs to a ticket', async () => {
    await enrolTags(EVENT, '04a22b1c');
    const ticketId = new mongoose.Types.ObjectId();
    await Wallet.create({
      eventId: new mongoose.Types.ObjectId(EVENT), ticketId, bandUid: '04a22b1c',
      balance: 0, cashFundedBalance: 0, status: 'active',
    });

    await expect(
      WalletService.ensureStandaloneWalletForBand({ eventId: EVENT, bandUid: '04a22b1c' }),
    ).rejects.toThrow(/belongs to a ticket/i);
    expect(await Wallet.countDocuments({})).toBe(1);
  });

  it('leaves no orphan when the uid is malformed', async () => {
    await expect(
      WalletService.ensureStandaloneWalletForBand({ eventId: EVENT, bandUid: '04a2' }),
    ).rejects.toThrow();
    expect(await Wallet.countDocuments({})).toBe(0);
  });
});
