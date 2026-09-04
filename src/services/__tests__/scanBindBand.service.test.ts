import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { ScanService } from '@services/scan.service';
import { Ticket } from '@models/ticket.model';
import { Wallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { enrolTags } from '@/__tests__/helpers/eventTags';

/**
 * Every uid this file binds. A tag only binds if its event's register holds it
 * (see EventTag), and every test here mints its own event, so the box has to be
 * stocked alongside the ticket rather than once for the suite. Enrolling the
 * whole list is harmless: the tests that expect a bind to FAIL fail for their
 * own reasons (wrong vendor, wrong event, uid already live, ticket refunded),
 * none of which the register can mask.
 */
const TAGS = [
  'ba0d0001', 'ba0d0002', 'ba0d0003', 'ba0d0004', 'ba0d0005', 'ba0d0006', 'ba0d0007', 'ba0d0008',
  'c0550001', 'c0550002', 'd0d0d001', '105d0001', '0e000001', '0efd0001', '0efd0002', '7e0d0001',
  'a1a1a1a1', 'a2a2a2a2',
];

async function seedTicket(
  eventId: mongoose.Types.ObjectId,
  status = TicketStatus.SOLD,
  vendorId: mongoose.Types.ObjectId = new mongoose.Types.ObjectId(),
) {
  const t = await Ticket.create({
    eventId,
    vendorId,
    ticketType: 'General',
    price: 100,
    status,
  });
  await enrolTags(eventId, ...TAGS);
  return t; // t.ticketId is the auto-generated short code
}

describe('ScanService.bindBandToTicket', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it("binds a band to the ticket's wallet and returns both", async () => {
    const eventId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId, TicketStatus.SOLD, vendorId);
    const res = await ScanService.bindBandToTicket({
      ticketId: t.ticketId, bandUid: 'ba0d0001', vendorId: String(vendorId),
      expectedEventId: String(eventId), boundBy: 'op1',
    });
    expect(res.wallet.bandUid).toBe('ba0d0001');
    expect(String(res.wallet.ticketId)).toBe(String(t._id));
  });

  it('is idempotent on the wallet — re-binding logic aside, one wallet per ticket', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId, TicketStatus.SOLD, vendorId);
    await ScanService.bindBandToTicket({ ticketId: t.ticketId, bandUid: 'ba0d0002', vendorId: String(vendorId) });
    // second bind attempt on the same (already-banded) ticket surfaces bindBand's message
    await expect(
      ScanService.bindBandToTicket({ ticketId: t.ticketId, bandUid: 'ba0d0003', vendorId: String(vendorId) }),
    ).rejects.toThrow('wallet already has a band bound');
  });

  it('rejects a ticket from a different event when expectedEventId is set', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const t = await seedTicket(new mongoose.Types.ObjectId(), TicketStatus.SOLD, vendorId);
    await expect(
      ScanService.bindBandToTicket({
        ticketId: t.ticketId, bandUid: 'ba0d0004', vendorId: String(vendorId),
        expectedEventId: new mongoose.Types.ObjectId().toString(),
      }),
    ).rejects.toThrow('different event');
  });

  it('rejects an unknown ticket code', async () => {
    await expect(
      ScanService.bindBandToTicket({ ticketId: 'NOSUCHCODE', bandUid: 'ba0d0005', vendorId: String(new mongoose.Types.ObjectId()) }),
    ).rejects.toThrow('Ticket not found');
  });

  it('rejects a refunded ticket (no spendable band)', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const t = await seedTicket(new mongoose.Types.ObjectId(), TicketStatus.REFUNDED, vendorId);
    await expect(
      ScanService.bindBandToTicket({ ticketId: t.ticketId, bandUid: 'ba0d0006', vendorId: String(vendorId) }),
    ).rejects.toThrow(/cannot bind a band/);
  });

  it('rejects a uid already live on another ticket in the event', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const a = await seedTicket(eventId, TicketStatus.SOLD, vendorId);
    const b = await seedTicket(eventId, TicketStatus.SOLD, vendorId);
    await ScanService.bindBandToTicket({ ticketId: a.ticketId, bandUid: 'd0d0d001', vendorId: String(vendorId), expectedEventId: String(eventId) });
    await expect(
      ScanService.bindBandToTicket({ ticketId: b.ticketId, bandUid: 'd0d0d001', vendorId: String(vendorId), expectedEventId: String(eventId) }),
    ).rejects.toThrow('band is already bound to another wallet at this event');
  });

  it('rejects a vendor-A operator binding a vendor-B ticket', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const vendorB = new mongoose.Types.ObjectId();
    const vendorA = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId, TicketStatus.SOLD, vendorB);

    await expect(
      ScanService.bindBandToTicket({ ticketId: t.ticketId, bandUid: 'ba0d0007', vendorId: String(vendorA) }),
    ).rejects.toThrow(/different vendor/);

    // No band should have been bound as a side effect of the rejected attempt.
    const wallet = await Wallet.findOne({ ticketId: t._id });
    expect(wallet?.bandUid ?? null).toBeNull();
  });

  it('allows a super-admin to bind a band across vendors', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const vendorB = new mongoose.Types.ObjectId();
    const vendorA = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId, TicketStatus.SOLD, vendorB);

    const res = await ScanService.bindBandToTicket({
      ticketId: t.ticketId, bandUid: 'ba0d0008', vendorId: String(vendorA), isSuperAdmin: true,
    });
    expect(res.wallet.bandUid).toBe('ba0d0008');
  });
});

describe('ScanService.reissueBandForTicket', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('swaps a lost band for a new one, balance preserved', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId);
    const { wallet } = await ScanService.bindBandToTicket({
      ticketId: t.ticketId, bandUid: '105d0001', vendorId: String(t.vendorId),
    });
    // simulate a funded wallet (real top-up is SP3)
    await Wallet.updateOne({ _id: wallet._id }, { $set: { balance: 5000 } });

    const res = await ScanService.reissueBandForTicket({
      ticketId: t.ticketId, newBandUid: '0e000001', reason: 'lost', vendorId: String(t.vendorId),
    });
    expect(res.wallet.bandUid).toBe('0e000001');
    expect(res.wallet.balance).toBe(5000);

    // the released uid is free to bind on a different ticket
    const t2 = await seedTicket(eventId);
    const again = await ScanService.bindBandToTicket({
      ticketId: t2.ticketId, bandUid: '105d0001', vendorId: String(t2.vendorId),
    });
    expect(again.wallet.bandUid).toBe('105d0001');
  });

  it('rejects reissue for a ticket that has no band bound', async () => {
    const t = await seedTicket(new mongoose.Types.ObjectId());
    // Give the ticket a wallet, but with NO band bound, so reissue hits the no-band path.
    const { wallet } = await ScanService.bindBandToTicket({
      ticketId: t.ticketId, bandUid: '7e0d0001', vendorId: String(t.vendorId),
    });
    await Wallet.updateOne({ _id: wallet._id }, { $set: { bandUid: null } });
    await expect(
      ScanService.reissueBandForTicket({
        ticketId: t.ticketId, newBandUid: 'a1a1a1a1', reason: 'lost', vendorId: String(t.vendorId),
      }),
    ).rejects.toThrow(/no band/);
  });

  it('rejects reissue for a ticket with no wallet at all', async () => {
    const t = await seedTicket(new mongoose.Types.ObjectId());
    await expect(
      ScanService.reissueBandForTicket({
        ticketId: t.ticketId, newBandUid: 'a2a2a2a2', reason: 'lost', vendorId: String(t.vendorId),
      }),
    ).rejects.toThrow('No wallet for this ticket');
  });

  it('rejects a cross-vendor reissue', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const vendorB = new mongoose.Types.ObjectId();
    const vendorA = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId, TicketStatus.SOLD, vendorB);
    await ScanService.bindBandToTicket({
      ticketId: t.ticketId, bandUid: 'c0550001', vendorId: String(vendorB),
    });

    await expect(
      ScanService.reissueBandForTicket({
        ticketId: t.ticketId, newBandUid: 'c0550002', reason: 'lost', vendorId: String(vendorA),
      }),
    ).rejects.toThrow(/different vendor/);
  });

  // The gate reissue used to unbind FIRST and only then discover the spare was
  // not in the register — the attendee walked away with no working tag at all.
  it('rejects reissue onto an UNREGISTERED uid and leaves the old band working', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId);
    const { wallet } = await ScanService.bindBandToTicket({
      ticketId: t.ticketId, bandUid: '105d0001', vendorId: String(t.vendorId),
    });

    await expect(
      ScanService.reissueBandForTicket({
        ticketId: t.ticketId, newBandUid: 'deadbeef', reason: 'lost', vendorId: String(t.vendorId),
      }),
    ).rejects.toThrow(/not registered/i);

    expect((await Wallet.findById(wallet._id))?.bandUid).toBe('105d0001');
    const row = await BandBinding.findOne({ walletId: wallet._id, bandUid: '105d0001' });
    expect(row?.unboundAt).toBeUndefined();
  });

  it('stores the CANONICAL uid on reissue, whatever the reader formatted', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId);
    await ScanService.bindBandToTicket({ ticketId: t.ticketId, bandUid: '105d0001', vendorId: String(t.vendorId) });

    const res = await ScanService.reissueBandForTicket({
      ticketId: t.ticketId, newBandUid: '0E:00:00:01', reason: 'lost', vendorId: String(t.vendorId),
    });
    expect(res.wallet.bandUid).toBe('0e000001');
  });

  it('rejects reissue for a refunded ticket and leaves the bound band untouched', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId);
    const { wallet } = await ScanService.bindBandToTicket({
      ticketId: t.ticketId, bandUid: '0efd0001', vendorId: String(t.vendorId),
    });

    // Ticket gets refunded after the band was bound — the refund flow flips
    // status but (per the known gap) does not unbind the band.
    await Ticket.updateOne({ _id: t._id }, { $set: { status: TicketStatus.REFUNDED } });

    await expect(
      ScanService.reissueBandForTicket({
        ticketId: t.ticketId, newBandUid: '0efd0002', reason: 'lost', vendorId: String(t.vendorId),
      }),
    ).rejects.toThrow(/cannot bind a band/);

    // The wallet must still carry the ORIGINAL band — no unbind/rebind should
    // have happened as a side effect of the rejected attempt.
    const reread = await Wallet.findOne({ _id: wallet._id });
    expect(reread?.bandUid).toBe('0efd0001');
  });
});
