/**
 * Shared test fixtures for ticket-sale flows.
 *
 * seedPublishedEvent builds a PUBLISHED event with exactly one ticket type and
 * returns the ids the sale paths need. Task 8 (reseller sales) reuses this.
 */
import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';

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

let __loginCodeSeq = 100000;

export async function seedReseller(): Promise<{ resellerId: string; hubId: string }> {
  const r = await Reseller.create({ businessName: 'Fixture Reseller', commissionPercent: null });
  const hub = await ResellerHub.create({ resellerId: r._id, name: 'Fixture Hub' });
  return { resellerId: r._id.toString(), hubId: hub._id.toString() };
}

export async function seedOperator(opts: {
  role?: string;
  pin?: string;
  resellerId?: string;
  hubId?: string;
  loginCode?: string;
} = {}): Promise<{ operator: any; resellerId: string; hubId: string; loginCode: string; pin: string }> {
  let resellerId = opts.resellerId;
  let hubId = opts.hubId;
  if (!resellerId || !hubId) {
    const seeded = await seedReseller();
    resellerId = resellerId ?? seeded.resellerId;
    hubId = hubId ?? seeded.hubId;
  }
  const loginCode = opts.loginCode ?? String(__loginCodeSeq++);
  const pin = opts.pin ?? '654321';
  const operator = await ResellerOperator.create({
    hubId, resellerId, fullName: 'Fixture Op',
    loginCode, pin, role: opts.role ?? 'reseller_operator',
  });
  return { operator, resellerId, hubId, loginCode, pin };
}
