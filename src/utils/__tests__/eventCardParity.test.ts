import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { buildEventCardFields } from '@/utils/eventCard.util';
import { getFeed } from '@services/feed.service';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { EventStatus } from '@interfaces/event.interface';

// Drift guard: toPublicEventCard and the feed EVENT slide both build on
// buildEventCardFields. This mapper has already dropped `ticketing` and then
// `category` in separate whole-branch-review findings because each
// serializer hand-built its own field list. This test asserts EVERY shared
// field actually lands on the feed slide — if a future edit stops spreading
// buildEventCardFields into the feed mapper (or starts omitting a key from
// it), this test fails.
describe('event card field parity: buildEventCardFields <-> feed event slide', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('feed event slide carries every shared event-card field', async () => {
    const vendor = await Vendor.create({ businessName: 'Parity Org', password: 'secret123', slug: 'parity-org' });
    const event = await Event.create({
      vendorId: vendor._id,
      name: 'Parity Show',
      description: 'd',
      venue: 'V',
      eventDate: new Date(Date.now() + 86400000),
      startTime: new Date(Date.now() + 86400000),
      endTime: new Date(Date.now() + 90000000),
      posterUrl: 'p', thumbnailUrl: 't',
      status: EventStatus.PUBLISHED,
      category: 'Music',
      ticketTypes: [
        { name: 'GA', price: 100, quantity: 5, available: 5 },
        { name: 'VIP', price: 300, quantity: 1, available: 0, isSoldOut: true },
      ],
    });

    const expectedFields = buildEventCardFields(await Event.findById(event._id).lean());

    const { items } = await getFeed({ tab: 'events', limit: 8 });
    const slide = items.find((i) => i.id === String(event._id));
    expect(slide).toBeDefined();

    for (const key of Object.keys(expectedFields)) {
      expect(slide).toHaveProperty(key);
      expect((slide as any)[key]).toEqual((expectedFields as any)[key]);
    }
  });

  it('fails loudly if a shared field were dropped (meta-check on the assertion itself)', async () => {
    // Sanity check that the loop above isn't vacuous: buildEventCardFields
    // must actually return a non-empty field set for a real event.
    const vendor = await Vendor.create({ businessName: 'Meta Org', password: 'secret123', slug: 'meta-org' });
    const event = await Event.create({
      vendorId: vendor._id, name: 'Meta Show', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketTypes: [{ name: 'GA', price: 10, quantity: 1, available: 1 }],
    });
    const fields = buildEventCardFields(await Event.findById(event._id).lean());
    expect(Object.keys(fields).length).toBeGreaterThan(5);
  });
});
