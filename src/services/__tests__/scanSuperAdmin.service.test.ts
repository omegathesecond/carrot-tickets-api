// api/src/services/__tests__/scanSuperAdmin.service.test.ts
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

async function soldTicket() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({ vendorId, name: 'E', venue: 'V', eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 1, reserved: 0 }] });
  const ticket = await Ticket.create({ eventId: event._id, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD });
  return { ticket, vendorId };
}

it('super-admin check-in succeeds for a ticket owned by another vendor', async () => {
  const { ticket } = await soldTicket();
  const operatorId = new mongoose.Types.ObjectId().toString();
  const res = await ScanService.checkInTicket({
    ticketId: ticket.ticketId,
    vendorId: undefined as any,         // platform operator has no single vendor
    scannedBy: operatorId,
    scannedByType: 'gate-operator',
    isSuperAdmin: true,
  });
  expect(res.valid).toBe(true);
  expect(res.scan?.scannedByType).toBe('GateOperator');
  expect(res.scan?.vendorId?.toString()).toBe(ticket.vendorId.toString()); // stamped from ticket
});

it('non-super-admin gate operator cannot check in another vendor ticket', async () => {
  const { ticket } = await soldTicket();
  const res = await ScanService.checkInTicket({
    ticketId: ticket.ticketId,
    vendorId: new mongoose.Types.ObjectId().toString(), // different vendor
    scannedBy: new mongoose.Types.ObjectId().toString(),
    scannedByType: 'gate-operator',
    isSuperAdmin: false,
  });
  expect(res.valid).toBe(false);
  expect(res.message).toMatch(/different vendor/i);
});
