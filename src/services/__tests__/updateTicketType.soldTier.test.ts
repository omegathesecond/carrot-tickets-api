import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';
import { Event } from '@models/event.model';

/**
 * Raising a tier's quantity is the one edit that is always safe once tickets
 * have sold — it only ever adds availability, and nobody holding a ticket is
 * affected. The guard used to reject the whole payload whenever it CARRIED a
 * name or price, without checking whether either had changed, so the dashboard
 * dialog (which resends every field, name/price disabled and therefore
 * identical) could never bump a quantity on a tier that had made a single sale.
 *
 * Renaming or repricing a sold tier stays an organizer-level refusal — that IS
 * a bait-and-switch on existing holders — but an administrator may do it, the
 * same carve-out deleteEvent and unpublishEvent already make.
 */
describe('EventService.updateTicketType — editing a tier that has already sold', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const VENDOR = '507f1f77bcf86cd799439011';

  /** An event with one 100-cap tier, 40 of them already sold. */
  const makeEventWithSales = async () => {
    const created = await EventService.createEvent({
      vendorId: VENDOR,
      name: 'Sold Event',
      venue: 'Venue',
      eventDate: new Date('2030-01-01'),
      startTime: new Date('2030-01-01T18:00:00Z'),
      endTime: new Date('2030-01-01T22:00:00Z'),
      ticketTypes: [{ name: 'General', price: 150, quantity: 100 }],
    } as any);

    await Event.updateOne(
      { _id: created._id },
      { $set: { 'ticketTypes.0.sold': 40, 'ticketTypes.0.available': 60, totalTicketsSold: 40 } }
    );
    return String(created._id);
  };

  const tierOf = async (id: string) => {
    const e = await Event.findById(id);
    return e!.ticketTypes[0]!;
  };

  it('lets the organizer raise the quantity of a tier that has sales', async () => {
    const id = await makeEventWithSales();

    await EventService.updateTicketType(id, VENDOR, 'General', { quantity: 1100 }, false);

    const tier = await tierOf(id);
    expect(tier.quantity).toBe(1100);
    expect(tier.available).toBe(1060);
  });

  it('accepts a payload that resends the unchanged name and price alongside a new quantity', async () => {
    const id = await makeEventWithSales();

    // Exactly what TicketTypeDialog submits: every field, name/price untouched.
    await EventService.updateTicketType(
      id, VENDOR, 'General', { name: 'General', price: 150, quantity: 1000 }, false
    );

    const tier = await tierOf(id);
    expect(tier.quantity).toBe(1000);
  });

  it('still refuses an organizer renaming a tier that has sales', async () => {
    const id = await makeEventWithSales();

    await expect(
      EventService.updateTicketType(id, VENDOR, 'General', { name: 'Early Bird' }, false)
    ).rejects.toThrow(/name or price/i);

    expect((await tierOf(id)).name).toBe('General');
  });

  it('still refuses an organizer repricing a tier that has sales', async () => {
    const id = await makeEventWithSales();

    await expect(
      EventService.updateTicketType(id, VENDOR, 'General', { price: 250 }, false)
    ).rejects.toThrow(/name or price/i);

    expect((await tierOf(id)).price).toBe(150);
  });

  it('lets a super-admin reprice a tier that has sales', async () => {
    const id = await makeEventWithSales();

    await EventService.updateTicketType(id, VENDOR, 'General', { price: 250 }, true);

    expect((await tierOf(id)).price).toBe(250);
  });

  it('refuses dropping the quantity below the sold count, super-admin included', async () => {
    const id = await makeEventWithSales();

    await expect(
      EventService.updateTicketType(id, VENDOR, 'General', { quantity: 10 }, true)
    ).rejects.toThrow(/below sold count \(40\)/);

    expect((await tierOf(id)).quantity).toBe(100);
  });

  it('recalculates event capacity from the tiers after a quantity change', async () => {
    const id = await makeEventWithSales();
    await EventService.addTicketType(id, VENDOR, { name: 'VIP', price: 500, quantity: 20 }, false);

    await EventService.updateTicketType(id, VENDOR, 'General', { quantity: 1000 }, false);

    const event = await Event.findById(id);
    expect(event!.capacity).toBe(1020);
  });
});
