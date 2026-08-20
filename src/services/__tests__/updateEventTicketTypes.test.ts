/**
 * EventService.updateEvent — ticket-type identity.
 *
 * A tier carries state nobody sends in an update payload: its subdocument _id
 * (which every issued ticket resolves through), its sold/reserved ledger, and
 * its reseller-allocation settings. updateEvent used to rebuild the array from
 * the payload, silently destroying all three. These tests pin the invariant
 * that an edit only changes what the caller actually sent.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import { EventService } from '@services/event.service';

const VENDOR = new mongoose.Types.ObjectId();
const RESELLER = new mongoose.Types.ObjectId();

const future = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/** A published event with an ordinary tier and a DeltaPay allocation tier —
 *  the shape of the live "Eswatini Farmers Market" event. */
async function seedEvent() {
  const date = future(30);
  const event = await Event.create({
    vendorId: VENDOR,
    name: 'Allocation Test Event',
    venue: 'Test Venue',
    eventDate: date,
    startTime: date,
    endTime: new Date(date.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    capacity: 300,
    ticketTypes: [
      { name: 'General', price: 300, quantity: 200, sold: 5, reserved: 2 },
      {
        name: 'DeltaPay Exclusive',
        price: 260,
        quantity: 100,
        sold: 3,
        reserved: 0,
        resellerId: RESELLER,
        isAllocation: true,
        allocationUnitCost: 250,
        restrictToMethod: PaymentMethod.DELTAPAY,
        waiveServiceFee: true,
      },
    ],
  });
  return {
    eventId: event._id.toString(),
    generalId: event.ticketTypes[0]!._id!.toString(),
    allocationId: event.ticketTypes[1]!._id!.toString(),
  };
}

/** The tier list as a caller echoes it back, optionally with one field changed. */
const echo = (
  ids: { generalId: string; allocationId: string },
  overrides: { general?: Record<string, unknown>; allocation?: Record<string, unknown> } = {}
) => [
  { _id: ids.generalId, name: 'General', price: 300, quantity: 200, ...overrides.general },
  { _id: ids.allocationId, name: 'DeltaPay Exclusive', price: 260, quantity: 100, ...overrides.allocation },
];

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('updateEvent — ticket type identity', () => {
  it('keeps the allocation fields when an unrelated tier is repriced', async () => {
    const ids = await seedEvent();

    await EventService.updateEvent(
      ids.eventId,
      VENDOR.toString(),
      { ticketTypes: echo(ids, { general: { price: 350 } }) as any },
      true
    );

    const after = await Event.findById(ids.eventId);
    const alloc = after!.ticketTypes.find(t => t.name === 'DeltaPay Exclusive')!;
    expect(alloc.resellerId?.toString()).toBe(RESELLER.toString());
    expect(alloc.isAllocation).toBe(true);
    expect(alloc.allocationUnitCost).toBe(250);
    expect(alloc.restrictToMethod).toBe(PaymentMethod.DELTAPAY);
    expect(alloc.waiveServiceFee).toBe(true);
    // and the edit the caller actually asked for landed
    expect(after!.ticketTypes.find(t => t.name === 'General')!.price).toBe(350);
  });

  it('keeps every tier _id stable, so issued tickets still resolve their tier', async () => {
    const ids = await seedEvent();

    await EventService.updateEvent(
      ids.eventId,
      VENDOR.toString(),
      { ticketTypes: echo(ids, { general: { price: 350 } }) as any },
      true
    );

    const after = await Event.findById(ids.eventId);
    expect(after!.ticketTypes.map(t => t._id!.toString())).toEqual([ids.generalId, ids.allocationId]);
  });

  it('preserves sold and reserved, and re-derives available from the new quantity', async () => {
    const ids = await seedEvent();

    await EventService.updateEvent(
      ids.eventId,
      VENDOR.toString(),
      { ticketTypes: echo(ids, { general: { quantity: 50 } }) as any },
      true
    );

    const general = (await Event.findById(ids.eventId))!.ticketTypes.find(t => t.name === 'General')!;
    expect(general.sold).toBe(5);
    expect(general.reserved).toBe(2);
    expect(general.available).toBe(43); // 50 - 5 sold - 2 reserved
  });

  it('renames a tier by _id without resetting its sold count', async () => {
    const ids = await seedEvent();

    await EventService.updateEvent(
      ids.eventId,
      VENDOR.toString(),
      { ticketTypes: echo(ids, { general: { name: 'General Admission' } }) as any },
      true
    );

    const after = await Event.findById(ids.eventId);
    const renamed = after!.ticketTypes.find(t => t._id!.toString() === ids.generalId)!;
    expect(renamed.name).toBe('General Admission');
    expect(renamed.sold).toBe(5);
    expect(after!.ticketTypes).toHaveLength(2);
  });

  it('still matches by name when the caller sends no _id (older clients)', async () => {
    const ids = await seedEvent();

    await EventService.updateEvent(
      ids.eventId,
      VENDOR.toString(),
      {
        ticketTypes: [
          { name: 'General', price: 400, quantity: 200 },
          { name: 'DeltaPay Exclusive', price: 260, quantity: 100 },
        ] as any,
      },
      true
    );

    const after = await Event.findById(ids.eventId);
    const general = after!.ticketTypes.find(t => t.name === 'General')!;
    expect(general._id!.toString()).toBe(ids.generalId);
    expect(general.price).toBe(400);
    expect(general.sold).toBe(5);
    expect(after!.ticketTypes.find(t => t.name === 'DeltaPay Exclusive')!.restrictToMethod)
      .toBe(PaymentMethod.DELTAPAY);
  });

  it('appends a genuinely new tier with a fresh ledger', async () => {
    const ids = await seedEvent();

    await EventService.updateEvent(
      ids.eventId,
      VENDOR.toString(),
      {
        ticketTypes: [
          ...echo(ids),
          { name: 'VIP', price: 800, quantity: 20 },
        ] as any,
      },
      true
    );

    const after = await Event.findById(ids.eventId);
    expect(after!.ticketTypes).toHaveLength(3);
    const vip = after!.ticketTypes.find(t => t.name === 'VIP')!;
    expect(vip.sold).toBe(0);
    expect(vip.reserved).toBe(0);
    expect(vip.available).toBe(20);
    expect(vip.isSoldOut).toBe(false);
  });

  it('refuses to drop a tier that has already sold tickets', async () => {
    const ids = await seedEvent();

    await expect(
      EventService.updateEvent(
        ids.eventId,
        VENDOR.toString(),
        { ticketTypes: [{ _id: ids.generalId, name: 'General', price: 300, quantity: 200 }] as any },
        true
      )
    ).rejects.toThrow(/Cannot remove ticket type.*DeltaPay Exclusive/);

    // nothing was written
    const after = await Event.findById(ids.eventId);
    expect(after!.ticketTypes).toHaveLength(2);
  });

  it('allows dropping a tier nobody has bought into', async () => {
    const ids = await seedEvent();
    // Add an untouched tier, then drop it.
    await EventService.updateEvent(
      ids.eventId,
      VENDOR.toString(),
      { ticketTypes: [...echo(ids), { name: 'Scrapped', price: 10, quantity: 5 }] as any },
      true
    );

    await EventService.updateEvent(
      ids.eventId,
      VENDOR.toString(),
      { ticketTypes: echo(ids) as any },
      true
    );

    const after = await Event.findById(ids.eventId);
    expect(after!.ticketTypes.map(t => t.name)).toEqual(['General', 'DeltaPay Exclusive']);
  });

  it('rejects an _id that belongs to no tier on this event', async () => {
    const ids = await seedEvent();
    const bogus = new mongoose.Types.ObjectId().toString();

    await expect(
      EventService.updateEvent(
        ids.eventId,
        VENDOR.toString(),
        { ticketTypes: [...echo(ids), { _id: bogus, name: 'Ghost', price: 1, quantity: 1 }] as any },
        true
      )
    ).rejects.toThrow(`Unknown ticket type: ${bogus}`);

    expect((await Event.findById(ids.eventId))!.ticketTypes).toHaveLength(2);
  });

  it('rejects two payload entries pointing at the same tier', async () => {
    const ids = await seedEvent();

    await expect(
      EventService.updateEvent(
        ids.eventId,
        VENDOR.toString(),
        {
          ticketTypes: [
            { _id: ids.generalId, name: 'General', price: 300, quantity: 200 },
            { _id: ids.generalId, name: 'General Again', price: 400, quantity: 200 },
            { _id: ids.allocationId, name: 'DeltaPay Exclusive', price: 260, quantity: 100 },
          ] as any,
        },
        true
      )
    ).rejects.toThrow(/Duplicate ticket type in update/);

    expect((await Event.findById(ids.eventId))!.ticketTypes).toHaveLength(2);
  });

  it('does not touch tiers at all when the payload omits ticketTypes', async () => {
    const ids = await seedEvent();

    await EventService.updateEvent(ids.eventId, VENDOR.toString(), { description: 'new copy' }, true);

    const after = await Event.findById(ids.eventId);
    expect(after!.description).toBe('new copy');
    expect(after!.ticketTypes.map(t => t._id!.toString())).toEqual([ids.generalId, ids.allocationId]);
    expect(after!.ticketTypes[1]!.restrictToMethod).toBe(PaymentMethod.DELTAPAY);
  });
});

describe('updateEvent — optional tier fields', () => {
  it('leaves an existing description alone when the payload omits it', async () => {
    const date = future(30);
    const event = await Event.create({
      vendorId: VENDOR,
      name: 'Description Test',
      venue: 'Test Venue',
      eventDate: date,
      startTime: date,
      endTime: new Date(date.getTime() + 60 * 60 * 1000),
      status: EventStatus.PUBLISHED,
      ticketTypes: [{ name: 'General', description: 'Includes a drink', price: 100, quantity: 10 }],
    });
    const tierId = event.ticketTypes[0]!._id!.toString();

    await EventService.updateEvent(
      event._id.toString(),
      VENDOR.toString(),
      { ticketTypes: [{ _id: tierId, name: 'General', price: 120, quantity: 10 }] as any },
      true
    );

    const after = await Event.findById(event._id);
    expect(after!.ticketTypes[0]!.description).toBe('Includes a drink');
    expect(after!.ticketTypes[0]!.price).toBe(120);
  });
});
