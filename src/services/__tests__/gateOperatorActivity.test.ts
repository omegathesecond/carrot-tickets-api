import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketScan } from '@models/ticketScan.model';
import { BandBinding } from '@models/bandBinding.model';
import { Ticket } from '@models/ticket.model';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { GateOperatorActivityService } from '@services/gateOperatorActivity.service';

const VENDOR = new mongoose.Types.ObjectId();
const OPERATOR = new mongoose.Types.ObjectId();
const OTHER_OPERATOR = new mongoose.Types.ObjectId();

let event: any;
let otherEvent: any;

async function makeEvent(name: string) {
  return Event.create({
    name, vendorId: VENDOR, venue: 'Mavuso', eventDate: new Date('2026-08-19T00:00:00Z'),
    startTime: new Date('2026-08-19T18:00:00Z'), endTime: new Date('2026-08-20T02:00:00Z'),
    status: 'published',
  } as any);
}

async function ticketFor(eventId: any, holder: string) {
  return Ticket.create({
    eventId, vendorId: VENDOR, ticketType: 'General', price: 0,
    customerName: holder, customerPhone: '+26876001234',
  } as any);
}

async function scan(opts: {
  eventId: any; ticketId: any; by?: mongoose.Types.ObjectId; result?: string; isValid?: boolean; at?: Date;
}) {
  return TicketScan.create({
    ticketId: opts.ticketId, eventId: opts.eventId, vendorId: VENDOR,
    scannedBy: opts.by ?? OPERATOR, scannedByType: 'GateOperator',
    isValid: opts.isValid ?? true, scanResult: opts.result ?? 'success',
    scannedAt: opts.at ?? new Date('2026-08-19T19:00:00Z'),
  } as any);
}

describe('GateOperatorActivityService.forOperator', () => {
  beforeAll(connectTestDb);
  beforeEach(async () => { event = await makeEvent('Main Event'); otherEvent = await makeEvent('Other Event'); });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('counts what this operator admitted and what they turned away', async () => {
    const t = await ticketFor(event._id, 'Sipho');
    await scan({ eventId: event._id, ticketId: t._id });
    await scan({ eventId: event._id, ticketId: t._id, result: 'already_scanned', isValid: false });
    await scan({ eventId: event._id, ticketId: t._id, result: 'wrong_event', isValid: false });

    const { summary } = await GateOperatorActivityService.forOperator({ operatorId: String(OPERATOR) });

    expect(summary.scans).toBe(3);
    expect(summary.admitted).toBe(1);
    expect(summary.refused).toBe(2);
  });

  it('never counts another operator’s scans', async () => {
    const t = await ticketFor(event._id, 'Sipho');
    await scan({ eventId: event._id, ticketId: t._id });
    await scan({ eventId: event._id, ticketId: t._id, by: OTHER_OPERATOR });

    const { summary } = await GateOperatorActivityService.forOperator({ operatorId: String(OPERATOR) });

    expect(summary.scans).toBe(1);
  });

  it('breaks the work down per event, named', async () => {
    const mine = await ticketFor(event._id, 'Sipho');
    const theirs = await ticketFor(otherEvent._id, 'Thandi');
    await scan({ eventId: event._id, ticketId: mine._id });
    await scan({ eventId: event._id, ticketId: mine._id });
    await scan({ eventId: otherEvent._id, ticketId: theirs._id });

    const { byEvent } = await GateOperatorActivityService.forOperator({ operatorId: String(OPERATOR) });

    const named = Object.fromEntries(byEvent.map((e) => [e.eventName, e.scans]));
    expect(named).toEqual({ 'Main Event': 2, 'Other Event': 1 });
  });

  it('narrows to one event when asked', async () => {
    const mine = await ticketFor(event._id, 'Sipho');
    const theirs = await ticketFor(otherEvent._id, 'Thandi');
    await scan({ eventId: event._id, ticketId: mine._id });
    await scan({ eventId: otherEvent._id, ticketId: theirs._id });

    const { summary } = await GateOperatorActivityService.forOperator({
      operatorId: String(OPERATOR), eventId: String(event._id),
    });

    expect(summary.scans).toBe(1);
  });

  it('names the ticket holder on each recent scan', async () => {
    const t = await ticketFor(event._id, 'Sipho Nkosi');
    await scan({ eventId: event._id, ticketId: t._id });

    const { recent } = await GateOperatorActivityService.forOperator({ operatorId: String(OPERATOR) });

    expect(recent[0]!.holderName).toBe('Sipho Nkosi');
    expect(recent[0]!.eventName).toBe('Main Event');
    expect(recent[0]!.result).toBe('success');
  });

  it('counts the tags this operator registered — boundBy is a string id', async () => {
    const t = await ticketFor(event._id, 'Sipho');
    const wallet = await Wallet.create({
      eventId: event._id, ticketId: t._id, bandUid: '04AABBCC', balance: 0, cashFundedBalance: 0,
    });
    await BandBinding.create({
      walletId: wallet._id, eventId: event._id, bandUid: '04AABBCC', boundBy: String(OPERATOR),
    });

    const { summary } = await GateOperatorActivityService.forOperator({ operatorId: String(OPERATOR) });
    const registrations = await GateOperatorActivityService.registrationsBy({ operatorId: String(OPERATOR) });

    expect(summary.tagsRegistered).toBe(1);
    expect(registrations[0]!.bandUid).toBe('04AABBCC');
    expect(registrations[0]!.holderName).toBe('Sipho');
  });
});
