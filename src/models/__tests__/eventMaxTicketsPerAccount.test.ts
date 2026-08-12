import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const DAY = 86400000;

async function seedEvent(extra: Record<string, unknown>) {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-cap' });
  return Event.create({
    vendorId: vendor._id,
    name: 'Cap Event',
    venue: 'V',
    eventDate: new Date(Date.now() + DAY),
    startTime: new Date(Date.now() + DAY),
    endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'GA', price: 100, quantity: 500, sold: 0 }],
    ...extra,
  });
}

describe('Event.maxTicketsPerAccount', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('persists the cap when set', async () => {
    const event = await seedEvent({ maxTicketsPerAccount: 1 });
    const reloaded = await Event.findById(event._id);
    expect(reloaded!.maxTicketsPerAccount).toBe(1);
  });

  it('is undefined by default (unlimited)', async () => {
    const event = await seedEvent({});
    const reloaded = await Event.findById(event._id);
    expect(reloaded!.maxTicketsPerAccount).toBeUndefined();
  });

  it('rejects a cap below 1', async () => {
    await expect(seedEvent({ maxTicketsPerAccount: 0 })).rejects.toThrow();
  });
});
