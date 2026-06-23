/**
 * Shared test fixtures for ticket-sale flows.
 *
 * seedPublishedEvent builds a PUBLISHED event with exactly one ticket type and
 * returns the ids the sale paths need. Task 8 (reseller sales) reuses this.
 */
import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

export interface SeedPublishedEventOptions {
  price?: number;
  capacity?: number;
  ticketTypeName?: string;
  vendorId?: mongoose.Types.ObjectId;
}

export interface SeededPublishedEvent {
  eventId: string;
  ticketTypeId: string;
  vendorId: string;
  capacity: number;
}

export async function seedPublishedEvent(
  opts: SeedPublishedEventOptions = {}
): Promise<SeededPublishedEvent> {
  const price = opts.price ?? 100;
  const capacity = opts.capacity ?? 10;
  const ticketTypeName = opts.ticketTypeName ?? 'General';
  const vendorId = opts.vendorId ?? new mongoose.Types.ObjectId();

  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Snapshot Test Event',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      {
        name: ticketTypeName,
        price,
        quantity: capacity,
        sold: 0,
        reserved: 0,
      },
    ],
  });

  const ticketTypeId = event.ticketTypes[0]!._id!.toString();
  return {
    eventId: event._id.toString(),
    ticketTypeId,
    vendorId: vendorId.toString(),
    capacity,
  };
}
