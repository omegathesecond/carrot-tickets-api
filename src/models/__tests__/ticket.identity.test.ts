import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Ticket } from '@models/ticket.model';
import { Event } from '@models/event.model';
import { TicketStatus } from '@interfaces/ticket.interface';

describe('Ticket identity fields (customerEmail + buyerId)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('accepts a ticket bound to buyerId + customerEmail (no phone)', async () => {
    // Create an event to reference
    const vendorId = new mongoose.Types.ObjectId();
    const event = await Event.create({
      vendorId,
      name: 'Test Event',
      venue: 'Test Venue',
      eventDate: new Date(),
      startTime: new Date(),
      endTime: new Date(),
      ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }],
    });

    // Create a ticket with customerEmail and buyerId (no phone)
    const buyerId = new mongoose.Types.ObjectId();
    const customerEmail = 'buyer@example.com';

    const ticket = await Ticket.create({
      eventId: event._id,
      vendorId: event.vendorId,
      ticketType: 'GA',
      price: 0,
      customerEmail,
      buyerId,
      status: TicketStatus.SOLD,
    });

    // Verify the fields were persisted and customerEmail is lowercase
    expect(ticket.customerEmail).toBe(customerEmail.toLowerCase());
    expect(ticket.buyerId).toEqual(buyerId);
  });

  it('normalizes customerEmail to lowercase on save', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const event = await Event.create({
      vendorId,
      name: 'Test Event 2',
      venue: 'Test Venue',
      eventDate: new Date(),
      startTime: new Date(),
      endTime: new Date(),
      ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }],
    });

    const buyerId = new mongoose.Types.ObjectId();
    const ticket = await Ticket.create({
      eventId: event._id,
      vendorId: event.vendorId,
      ticketType: 'GA',
      price: 0,
      customerEmail: 'BUYER@EXAMPLE.COM',
      buyerId,
      status: TicketStatus.SOLD,
    });

    expect(ticket.customerEmail).toBe('buyer@example.com');
  });
});
