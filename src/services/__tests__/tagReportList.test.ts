import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';
import { TagReportService } from '@services/tagReport.service';

const EVENT = new mongoose.Types.ObjectId();
const VENDOR = new mongoose.Types.ObjectId();

async function tagFor(name: string, phone: string, over: Record<string, unknown> = {}) {
  const ticket = await Ticket.create({
    eventId: EVENT, vendorId: VENDOR, ticketType: 'General', price: 0,
    customerName: name, customerPhone: phone,
  } as any);
  const wallet = await Wallet.create({
    eventId: EVENT, ticketId: ticket._id, bandUid: 'UID' + phone.slice(-4),
    balance: 1000, cashFundedBalance: 0, status: 'active', ...over,
  });
  return { ticket, wallet };
}

describe('TagReportService.list', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns each tag with the holder it is bound to', async () => {
    const { ticket } = await tagFor('Thandi Dlamini', '+26876001234');

    const { tags } = await TagReportService.list(String(EVENT), {});

    expect(tags).toHaveLength(1);
    expect(tags[0]!.holder).toEqual({
      name: 'Thandi Dlamini',
      phone: '+26876001234',
      // The human ticket code lives on ticket.ticketId, NOT ticket._id.
      ticketCode: (await Ticket.findById(ticket._id))!.ticketId,
    });
  });

  it('derives status from the band and the wallet, not from wallet.status alone', async () => {
    await tagFor('Bound Bongi', '+26876001111');
    await tagFor('Lost Lindiwe', '+26876002222', { bandUid: null });
    await tagFor('Frozen Fana', '+26876003333', { status: 'frozen' });

    const { tags } = await TagReportService.list(String(EVENT), {});
    const byName = Object.fromEntries(tags.map((t) => [t.holder.name, t.status]));

    expect(byName['Bound Bongi']).toBe('active');
    expect(byName['Lost Lindiwe']).toBe('unbound');
    expect(byName['Frozen Fana']).toBe('frozen');
  });

  it('filters by status', async () => {
    await tagFor('Bound Bongi', '+26876001111');
    await tagFor('Lost Lindiwe', '+26876002222', { bandUid: null });

    const { tags } = await TagReportService.list(String(EVENT), { status: 'unbound' });

    expect(tags.map((t) => t.holder.name)).toEqual(['Lost Lindiwe']);
  });

  it('searches on tag UID prefix and on holder name or phone', async () => {
    await tagFor('Thandi Dlamini', '+26876001234');
    await tagFor('Sipho Nkosi', '+26876009999');

    const byUid = await TagReportService.list(String(EVENT), { q: 'UID1234' });
    const byName = await TagReportService.list(String(EVENT), { q: 'sipho' });
    const byPhone = await TagReportService.list(String(EVENT), { q: '9999' });

    expect(byUid.tags.map((t) => t.holder.name)).toEqual(['Thandi Dlamini']);
    expect(byName.tags.map((t) => t.holder.name)).toEqual(['Sipho Nkosi']);
    expect(byPhone.tags.map((t) => t.holder.name)).toEqual(['Sipho Nkosi']);
  });

  it('pages without dropping or repeating a row across the cursor boundary', async () => {
    for (let i = 0; i < 5; i++) await tagFor(`Person ${i}`, `+2687600000${i}`);

    const first = await TagReportService.list(String(EVENT), { limit: 2 });
    const second = await TagReportService.list(String(EVENT), { limit: 2, cursor: first.nextCursor! });

    expect(first.tags).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.tags).toHaveLength(2);
    const seen = [...first.tags, ...second.tags].map((t) => t.walletId);
    expect(new Set(seen).size).toBe(4);
  });
});
