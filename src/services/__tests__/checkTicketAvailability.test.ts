import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '../event.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const DAY = 86400000;

async function seedEventWithTier(tier: { isSoldOut?: boolean; quantity?: number; sold?: number }) {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-avail' });
  const event = await Event.create({
    vendorId: vendor._id,
    name: 'Piano Republic',
    venue: 'V',
    eventDate: new Date(Date.now() + DAY),
    startTime: new Date(Date.now() + DAY),
    endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      { name: 'Presale VIP', price: 350, quantity: tier.quantity ?? 999, sold: tier.sold ?? 0, isSoldOut: tier.isSoldOut ?? false },
    ],
  });
  const ticketTypeId = String(event.ticketTypes[0]!._id);
  return { event, ticketTypeId };
}

describe('EventService.checkTicketAvailability — honours the manual sold-out flag', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('refuses a tier the organizer manually marked sold out, even with stock remaining', async () => {
    // The dashboard "mark sold out" only flips the flag; the count stays high.
    const { event, ticketTypeId } = await seedEventWithTier({ isSoldOut: true, quantity: 999, sold: 0 });

    const result = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1);

    expect(result.available).toBe(false);
    expect(result.message).toMatch(/sold out/i);
  });

  it('allows a tier that is not sold out and has stock', async () => {
    const { event, ticketTypeId } = await seedEventWithTier({ isSoldOut: false, quantity: 50, sold: 0 });

    const result = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 2);

    expect(result.available).toBe(true);
  });

  it('still refuses when genuinely depleted (flag clear, sold out of stock)', async () => {
    const { event, ticketTypeId } = await seedEventWithTier({ isSoldOut: false, quantity: 5, sold: 5 });

    const result = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1);

    expect(result.available).toBe(false);
  });
});
