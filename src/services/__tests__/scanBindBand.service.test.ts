import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { ScanService } from '@services/scan.service';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';

async function seedTicket(eventId: mongoose.Types.ObjectId, status = TicketStatus.SOLD) {
  const t = await Ticket.create({
    eventId,
    vendorId: new mongoose.Types.ObjectId(),
    ticketType: 'General',
    price: 100,
    status,
  });
  return t; // t.ticketId is the auto-generated short code
}

describe('ScanService.bindBandToTicket', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it("binds a band to the ticket's wallet and returns both", async () => {
    const eventId = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId);
    const res = await ScanService.bindBandToTicket({
      ticketId: t.ticketId, bandUid: 'BAND0001', expectedEventId: String(eventId), boundBy: 'op1',
    });
    expect(res.wallet.bandUid).toBe('BAND0001');
    expect(String(res.wallet.ticketId)).toBe(String(t._id));
  });

  it('is idempotent on the wallet — re-binding logic aside, one wallet per ticket', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const t = await seedTicket(eventId);
    await ScanService.bindBandToTicket({ ticketId: t.ticketId, bandUid: 'BAND0002' });
    // second bind attempt on the same (already-banded) ticket surfaces bindBand's message
    await expect(
      ScanService.bindBandToTicket({ ticketId: t.ticketId, bandUid: 'BAND0003' }),
    ).rejects.toThrow('wallet already has a band bound');
  });

  it('rejects a ticket from a different event when expectedEventId is set', async () => {
    const t = await seedTicket(new mongoose.Types.ObjectId());
    await expect(
      ScanService.bindBandToTicket({
        ticketId: t.ticketId, bandUid: 'BAND0004',
        expectedEventId: new mongoose.Types.ObjectId().toString(),
      }),
    ).rejects.toThrow('different event');
  });

  it('rejects an unknown ticket code', async () => {
    await expect(
      ScanService.bindBandToTicket({ ticketId: 'NOSUCHCODE', bandUid: 'BAND0005' }),
    ).rejects.toThrow('Ticket not found');
  });

  it('rejects a refunded ticket (no spendable band)', async () => {
    const t = await seedTicket(new mongoose.Types.ObjectId(), TicketStatus.REFUNDED);
    await expect(
      ScanService.bindBandToTicket({ ticketId: t.ticketId, bandUid: 'BAND0006' }),
    ).rejects.toThrow(/cannot bind a band/);
  });

  it('rejects a uid already live on another ticket in the event', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const a = await seedTicket(eventId);
    const b = await seedTicket(eventId);
    await ScanService.bindBandToTicket({ ticketId: a.ticketId, bandUid: 'DUPUID01', expectedEventId: String(eventId) });
    await expect(
      ScanService.bindBandToTicket({ ticketId: b.ticketId, bandUid: 'DUPUID01', expectedEventId: String(eventId) }),
    ).rejects.toThrow('band is already bound to another wallet at this event');
  });
});
