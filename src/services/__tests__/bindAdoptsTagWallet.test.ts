// api/src/services/__tests__/bindAdoptsTagWallet.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { ScanService } from '@services/scan.service';
import { WalletService } from '@services/wallet.service';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';

const VENDOR = new mongoose.Types.ObjectId();
const EVENT = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await connectTestDb();
  await Wallet.syncIndexes();
});
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const seedTicket = () =>
  Ticket.create({
    eventId: EVENT, vendorId: VENDOR, ticketType: 'General', price: 100,
    status: TicketStatus.SOLD,
  });

/** A tag scanned at the Register desk: registered, and carrying its own wallet. */
async function issuedTag(bandUid: string) {
  await enrolTags(EVENT, bandUid);
  const { wallet } = await WalletService.ensureStandaloneWalletForBand({
    eventId: String(EVENT), bandUid,
  });
  return wallet;
}

describe('attaching a ticket to a tag that is already somebody wallet', () => {
  it('joins the ticket to the tag existing wallet rather than minting a second', async () => {
    const tagWallet = await issuedTag('04a22b1c');
    const ticket = await seedTicket();

    const { wallet } = await ScanService.bindBandToTicket({
      ticketId: ticket.ticketId, bandUid: '04a22b1c', vendorId: String(VENDOR),
    });

    expect(String(wallet._id)).toBe(String(tagWallet._id));
    expect(String(wallet.ticketId)).toBe(String(ticket._id));
    // One wallet, not two — a second would have collided on {eventId, bandUid}
    // and, worse, split the person's money across both.
    expect(await Wallet.countDocuments({ eventId: EVENT })).toBe(1);
  });

  it('keeps the cash already loaded on the tag', async () => {
    const tagWallet = await issuedTag('04a22b1c');
    await Wallet.updateOne({ _id: tagWallet._id }, { $set: { balance: 7500, cashFundedBalance: 7500 } });
    const ticket = await seedTicket();

    const { wallet } = await ScanService.bindBandToTicket({
      ticketId: ticket.ticketId, bandUid: '04a22b1c', vendorId: String(VENDOR),
    });

    expect(wallet.balance).toBe(7500);
    expect(wallet.cashFundedBalance).toBe(7500);
  });

  it('refuses rather than merging when the ticket already has its own wallet', async () => {
    await issuedTag('04a22b1c');
    const ticket = await seedTicket();
    await WalletService.ensureWalletForTicket({
      ticketId: String(ticket._id), eventId: String(EVENT),
    });

    await expect(
      ScanService.bindBandToTicket({
        ticketId: ticket.ticketId, bandUid: '04a22b1c', vendorId: String(VENDOR),
      }),
    ).rejects.toThrow(/cannot be merged/i);

    // Nothing moved: both wallets are exactly as they were.
    expect(await Wallet.countDocuments({ eventId: EVENT })).toBe(2);
  });

  it('still refuses a tag that is not in the register at all', async () => {
    const ticket = await seedTicket();
    await expect(
      ScanService.bindBandToTicket({
        ticketId: ticket.ticketId, bandUid: '04a22b99', vendorId: String(VENDOR),
      }),
    ).rejects.toThrow(/not registered for this event/i);
  });

  it('will not hand one tag to two different tickets', async () => {
    await issuedTag('04a22b1c');
    const first = await seedTicket();
    const second = await seedTicket();
    await ScanService.bindBandToTicket({
      ticketId: first.ticketId, bandUid: '04a22b1c', vendorId: String(VENDOR),
    });

    await expect(
      ScanService.bindBandToTicket({
        ticketId: second.ticketId, bandUid: '04a22b1c', vendorId: String(VENDOR),
      }),
    ).rejects.toThrow();
  });
});
