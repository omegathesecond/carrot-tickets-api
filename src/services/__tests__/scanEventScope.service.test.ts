// api/src/services/__tests__/scanEventScope.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ScanService } from '@services/scan.service';
import { Ticket } from '@models/ticket.model';
import { Event } from '@models/event.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { EventStatus } from '@interfaces/event.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/** One vendor running two shows, with a sold ticket for each. */
async function twoShows() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const make = async (name: string) => {
    const event = await Event.create({
      vendorId, name, venue: 'V', eventDate: future, startTime: future, endTime: future,
      status: EventStatus.PUBLISHED,
      ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 1, reserved: 0 }],
    });
    const ticket = await Ticket.create({ eventId: event._id, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD });
    return { event, ticket };
  };
  return { vendorId, assigned: await make('Assigned Show'), other: await make('Other Show') };
}

const scanParams = (vendorId: mongoose.Types.ObjectId, ticketId: string, allowedEventIds?: string[]) => ({
  ticketId,
  vendorId: vendorId.toString(),
  scannedBy: new mongoose.Types.ObjectId().toString(),
  scannedByType: 'gate-operator' as const,
  isSuperAdmin: false,
  ...(allowedEventIds ? { allowedEventIds } : {}),
});

describe('an assigned operator is held to their events by the ticket, not by the client', () => {
  it('checks in a ticket for an assigned event', async () => {
    const { vendorId, assigned } = await twoShows();
    const allowed = [(assigned.event._id as any).toString()];

    const res = await ScanService.checkInTicket(scanParams(vendorId, assigned.ticket.ticketId, allowed));

    expect(res.valid).toBe(true);
  });

  it('refuses a ticket for an event they are not assigned to, even with no expectedEventId sent', async () => {
    const { vendorId, assigned, other } = await twoShows();
    const allowed = [(assigned.event._id as any).toString()];

    const res = await ScanService.checkInTicket(scanParams(vendorId, other.ticket.ticketId, allowed));

    expect(res.valid).toBe(false);
    expect(res.message).toMatch(/not assigned/i);
  });

  it('refuses even when the client claims the unassigned event is the selected one', async () => {
    const { vendorId, assigned, other } = await twoShows();
    const allowed = [(assigned.event._id as any).toString()];

    // The device says "I am scanning Other Show" — matching expectedEventId is
    // exactly what let an operator work any of their organizer's shows before.
    const res = await ScanService.checkInTicket({
      ...scanParams(vendorId, other.ticket.ticketId, allowed),
      expectedEventId: (other.event._id as any).toString(),
    });

    expect(res.valid).toBe(false);
    expect(res.message).toMatch(/not assigned/i);
  });

  it('records the refusal as a wrong_event scan so the gate has an audit trail', async () => {
    const { vendorId, assigned, other } = await twoShows();
    const allowed = [(assigned.event._id as any).toString()];

    const res = await ScanService.checkInTicket(scanParams(vendorId, other.ticket.ticketId, allowed));

    expect(res.scan?.scanResult).toBe('wrong_event');
    expect(res.scan?.isValid).toBe(false);
  });

  it('leaves the refused ticket un-checked-in', async () => {
    const { vendorId, assigned, other } = await twoShows();
    const allowed = [(assigned.event._id as any).toString()];

    await ScanService.checkInTicket(scanParams(vendorId, other.ticket.ticketId, allowed));

    expect((await Ticket.findById(other.ticket._id))!.status).toBe(TicketStatus.SOLD);
  });
});

describe('validateTicket applies the same assignment check', () => {
  it('previews an assigned event ticket', async () => {
    const { vendorId, assigned } = await twoShows();
    const res = await ScanService.validateTicket(scanParams(vendorId, assigned.ticket.ticketId, [(assigned.event._id as any).toString()]));

    expect(res.valid).toBe(true);
  });

  it('refuses an unassigned event ticket', async () => {
    const { vendorId, assigned, other } = await twoShows();
    const res = await ScanService.validateTicket(scanParams(vendorId, other.ticket.ticketId, [(assigned.event._id as any).toString()]));

    expect(res.valid).toBe(false);
    expect(res.message).toMatch(/not assigned/i);
  });
});

describe('unassigned operators keep working every show', () => {
  it('checks in either show when no allowedEventIds are passed', async () => {
    const { vendorId, assigned, other } = await twoShows();

    expect((await ScanService.checkInTicket(scanParams(vendorId, assigned.ticket.ticketId))).valid).toBe(true);
    expect((await ScanService.checkInTicket(scanParams(vendorId, other.ticket.ticketId))).valid).toBe(true);
  });

  it('still honours expectedEventId as the device-selected show', async () => {
    const { vendorId, assigned, other } = await twoShows();

    const res = await ScanService.checkInTicket({
      ...scanParams(vendorId, other.ticket.ticketId),
      expectedEventId: (assigned.event._id as any).toString(),
    });

    expect(res.valid).toBe(false);
    expect(res.message).toMatch(/wrong event/i);
  });
});
