import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '../event.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const DAY = 86400000;

/** Midnight UTC, the same day marker the event records use. */
function dayOffset(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function seedEvent(
  vendorId: any,
  name: string,
  dayFromToday: number,
  opts: { endsDaysLater?: number } = {}
) {
  const eventDate = dayOffset(dayFromToday);
  const endTime = new Date(dayOffset(dayFromToday + (opts.endsDaysLater ?? 0)).getTime() + 22 * 3600000);
  return Event.create({
    vendorId,
    name,
    venue: 'V',
    eventDate,
    startTime: new Date(eventDate.getTime() + 18 * 3600000),
    endTime,
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'GA', price: 100, quantity: 100, sold: 0 }],
  });
}

const names = (result: { data: any[] }) => result.data.map((e: any) => e.name);

describe('EventService.getEvents — relevance ordering for the POS scanner', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it("puts today's event first, then upcoming soonest-first, then past newest-first", async () => {
    const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-order' });

    // Seeded out of order on purpose so a stable sort can't fake the result.
    await seedEvent(vendor._id, 'next-month', 30);
    await seedEvent(vendor._id, 'last-week', -7);
    await seedEvent(vendor._id, 'today', 0);
    await seedEvent(vendor._id, 'next-week', 7);
    await seedEvent(vendor._id, 'last-month', -30);
    await seedEvent(vendor._id, 'tomorrow', 1);

    const result = await EventService.getEvents({ vendorId: String(vendor._id) });

    expect(names(result)).toEqual([
      'today',
      'tomorrow',
      'next-week',
      'next-month',
      'last-week',
      'last-month',
    ]);
  });

  it("keeps today's event on page one when future events would fill it", async () => {
    // The regression: sorting newest-first pushed a live event onto page 2,
    // where the POS never looks, so the operator could not select it at all.
    const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-page' });

    for (let i = 1; i <= 25; i++) await seedEvent(vendor._id, `future-${i}`, i + 1);
    await seedEvent(vendor._id, 'today', 0);

    const result = await EventService.getEvents({ vendorId: String(vendor._id) });

    expect(result.data).toHaveLength(20);
    expect(names(result)[0]).toBe('today');
  });

  it('ranks a multi-day event that is still running above one starting later today', async () => {
    const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-multi' });

    await seedEvent(vendor._id, 'starts-today', 0);
    await seedEvent(vendor._id, 'festival-day-3', -2, { endsDaysLater: 3 });

    const result = await EventService.getEvents({ vendorId: String(vendor._id) });

    expect(names(result)).toEqual(['festival-day-3', 'starts-today']);
  });

  it('still scopes to the vendor once the filter is cast for the aggregation', async () => {
    const mine = await Vendor.create({ businessName: 'Mine', password: 'password123', slug: 'org-mine' });
    const theirs = await Vendor.create({ businessName: 'Theirs', password: 'password123', slug: 'org-theirs' });

    await seedEvent(mine._id, 'mine', 0);
    await seedEvent(theirs._id, 'theirs', 0);

    const result = await EventService.getEvents({ vendorId: String(mine._id) });

    expect(names(result)).toEqual(['mine']);
    expect(result.pagination.total).toBe(1);
  });
});
