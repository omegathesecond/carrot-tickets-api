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

/** A tag handed out at the register desk with no ticket behind it — so no
 *  ticketId, and nothing for the ticket $lookup to join. */
async function standaloneTag(uid: string, over: Record<string, unknown> = {}) {
  return Wallet.create({
    eventId: EVENT, bandUid: uid,
    balance: 1000, cashFundedBalance: 0, status: 'active', ...over,
  });
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

  // The bug: 496 tags registered, 11 holding money, _id-desc order, one funded
  // tag on page 1. The organizer read a wall of E0.00 as "the balances are gone"
  // while E1,865 sat on wristbands.
  describe('funded', () => {
    it('keeps only the tags holding money', async () => {
      await tagFor('Funded Fikile', '+26876001111', { balance: 6000 });
      await tagFor('Empty Enock', '+26876002222', { balance: 0, cashFundedBalance: 0 });

      const { tags } = await TagReportService.list(String(EVENT), { funded: true });

      expect(tags.map((t) => t.holder.name)).toEqual(['Funded Fikile']);
    });

    it('keeps a funded STANDALONE tag, which has no ticket to join', async () => {
      const wallet = await standaloneTag('UIDSTANDALONE', { balance: 4000 });

      const { tags } = await TagReportService.list(String(EVENT), { funded: true });

      expect(tags.map((t) => t.walletId)).toEqual([String(wallet._id)]);
      expect(tags[0]!.holder).toEqual({ name: null, phone: null, ticketCode: null });
    });

    it('composes with the status filter', async () => {
      await tagFor('Funded Frozen', '+26876001111', { balance: 6000, status: 'frozen' });
      await tagFor('Funded Active', '+26876002222', { balance: 6000 });
      await tagFor('Empty Frozen', '+26876003333', { balance: 0, status: 'frozen' });

      const { tags } = await TagReportService.list(String(EVENT), { funded: true, status: 'frozen' });

      expect(tags.map((t) => t.holder.name)).toEqual(['Funded Frozen']);
    });
  });

  describe("sort: 'balance'", () => {
    it('puts the biggest balance first, whatever order the tags were registered in', async () => {
      await tagFor('Small Sipho', '+26876001111', { balance: 500 });
      await tagFor('Big Bongi', '+26876002222', { balance: 90000 });
      await tagFor('Middle Musa', '+26876003333', { balance: 6000 });

      const { tags } = await TagReportService.list(String(EVENT), { sort: 'balance' });

      expect(tags.map((t) => t.holder.name)).toEqual(['Big Bongi', 'Middle Musa', 'Small Sipho']);
    });

    it("leaves 'recent' — and the default — on newest-registered-first", async () => {
      await tagFor('First First', '+26876001111', { balance: 90000 });
      await tagFor('Second Second', '+26876002222', { balance: 500 });

      const explicit = await TagReportService.list(String(EVENT), { sort: 'recent' });
      const implicit = await TagReportService.list(String(EVENT), {});

      const newestFirst = ['Second Second', 'First First'];
      expect(explicit.tags.map((t) => t.holder.name)).toEqual(newestFirst);
      expect(implicit.tags.map((t) => t.holder.name)).toEqual(newestFirst);
    });

    it('pages without dropping or repeating a row', async () => {
      for (let i = 0; i < 5; i++) await tagFor(`Person ${i}`, `+2687600000${i}`, { balance: (i + 1) * 1000 });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await TagReportService.list(String(EVENT), {
          sort: 'balance', limit: 2, ...(cursor ? { cursor } : {}),
        });
        seen.push(...res.tags.map((t) => t.holder.name!));
        if (!res.hasMore) break;
        cursor = res.nextCursor!;
      }

      expect(seen).toEqual(['Person 4', 'Person 3', 'Person 2', 'Person 1', 'Person 0']);
    });

    /**
     * THE case a balance-only cursor gets wrong. `balance < cursor` skips every
     * other row on the same balance; `balance <= cursor` repeats them forever.
     * Bulk-registered plastic makes ties the norm, not the edge case: every tag
     * loaded with the same E200 float collides here.
     */
    it('pages through a run of EQUAL balances without dropping or repeating one', async () => {
      for (let i = 0; i < 5; i++) await tagFor(`Person ${i}`, `+2687600000${i}`, { balance: 20000 });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await TagReportService.list(String(EVENT), {
          sort: 'balance', limit: 2, ...(cursor ? { cursor } : {}),
        });
        seen.push(...res.tags.map((t) => t.walletId));
        if (!res.hasMore) break;
        cursor = res.nextCursor!;
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('carries the balance in the cursor, because _id alone cannot order this page', async () => {
      await tagFor('Big Bongi', '+26876001111', { balance: 90000 });
      await tagFor('Small Sipho', '+26876002222', { balance: 500 });

      const first = await TagReportService.list(String(EVENT), { sort: 'balance', limit: 1 });

      expect(first.nextCursor).toBe(`90000:${first.tags[0]!.walletId}`);
    });

    it('pages a funded, searched list without losing the ordering', async () => {
      await standaloneTag('UIDAAA', { balance: 3000 });
      await standaloneTag('UIDBBB', { balance: 9000 });
      await standaloneTag('UIDCCC', { balance: 0 });
      await standaloneTag('OTHER', { balance: 50000 });

      const first = await TagReportService.list(String(EVENT), { funded: true, sort: 'balance', q: 'UID', limit: 1 });
      const second = await TagReportService.list(String(EVENT), {
        funded: true, sort: 'balance', q: 'UID', limit: 1, cursor: first.nextCursor!,
      });

      expect(first.tags.map((t) => t.bandUid)).toEqual(['UIDBBB']);
      expect(second.tags.map((t) => t.bandUid)).toEqual(['UIDAAA']);
      expect(second.hasMore).toBe(false);
    });
  });
});
