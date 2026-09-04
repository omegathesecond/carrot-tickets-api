import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';
import { BandBinding } from '@models/bandBinding.model';
import { GateOperator } from '@models/gateOperator.model';
import { TagReportService } from '@services/tagReport.service';

const EVENT = new mongoose.Types.ObjectId();
const OTHER_EVENT = new mongoose.Types.ObjectId();
const VENDOR = new mongoose.Types.ObjectId();

async function registered(bandUid: string, holder: string, opts: {
  eventId?: mongoose.Types.ObjectId; boundBy?: string; unboundAt?: Date; balance?: number;
} = {}) {
  const eventId = opts.eventId ?? EVENT;
  const ticket = await Ticket.create({
    eventId, vendorId: VENDOR, ticketType: 'General', price: 0,
    customerName: holder, customerPhone: '+26876001234',
  } as any);
  const wallet = await Wallet.create({
    eventId, ticketId: ticket._id, bandUid, balance: opts.balance ?? 2500,
    cashFundedBalance: 0, status: 'active',
  });
  await BandBinding.create({
    walletId: wallet._id, eventId, bandUid,
    ...(opts.boundBy ? { boundBy: opts.boundBy } : {}),
    ...(opts.unboundAt ? { unboundAt: opts.unboundAt } : {}),
  });
  return wallet;
}

describe('TagReportService.registrations — the register desk log', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('names the person who registered each tag, not their id', async () => {
    const desk = await GateOperator.create({
      fullName: 'Register Rose', scope: 'organizer', vendorId: VENDOR,
      eventIds: [EVENT], loginCode: '920001', pin: '123456', grants: ['issue_tags'],
    } as any);
    await registered('04AABBCC', 'Sipho Nkosi', { boundBy: String(desk._id) });

    const { registrations } = await TagReportService.registrations(String(EVENT), {});

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.registeredBy).toBe('Register Rose');
    expect(registrations[0]!.holder.name).toBe('Sipho Nkosi');
    expect(registrations[0]!.balance).toBe(2500);
  });

  it('keeps a released tag in the log — it was still registered that night', async () => {
    await registered('04LOST01', 'Lost Lindiwe', { unboundAt: new Date('2026-08-19T22:00:00Z') });

    const { registrations } = await TagReportService.registrations(String(EVENT), {});

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.releasedAt).not.toBeNull();
  });

  it('never leaks another event’s registrations', async () => {
    await registered('04AABBCC', 'Mine', {});
    await registered('04DDEEFF', 'Theirs', { eventId: OTHER_EVENT });

    const { registrations } = await TagReportService.registrations(String(EVENT), {});

    expect(registrations.map((r) => r.holder.name)).toEqual(['Mine']);
  });

  it('searches by tag UID', async () => {
    await registered('04AABBCC', 'Sipho', {});
    await registered('04DDEEFF', 'Thandi', {});

    const { registrations } = await TagReportService.registrations(String(EVENT), { q: 'ddee' });

    expect(registrations.map((r) => r.holder.name)).toEqual(['Thandi']);
  });

  it('pages newest-first on a cursor that cannot repeat or skip a row', async () => {
    await registered('04000001', 'One', {});
    await registered('04000002', 'Two', {});
    await registered('04000003', 'Three', {});

    const first = await TagReportService.registrations(String(EVENT), { limit: 2 });
    expect(first.registrations.map((r) => r.bandUid)).toEqual(['04000003', '04000002']);
    expect(first.hasMore).toBe(true);

    const second = await TagReportService.registrations(String(EVENT), {
      limit: 2, cursor: first.nextCursor!,
    });
    expect(second.registrations.map((r) => r.bandUid)).toEqual(['04000001']);
    expect(second.hasMore).toBe(false);
  });
});
