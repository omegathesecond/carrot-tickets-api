import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { getActivityFeed } from '../index';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Follow } from '@models/follow.model';
import { EventReaction } from '@models/eventReaction.model';
import { EventStatus } from '@interfaces/event.interface';

const DAY = 86400000;

async function seedVendorEvent(name: string) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  const event = await Event.create({
    vendorId: vendor._id, name, venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED, publishedAt: new Date(Date.now() - DAY),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
  return { vendor, event };
}

describe('getActivityFeed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns rows newest-first across sources', async () => {
    const { event } = await seedVendorEvent('E1');
    const a = await Buyer.create({ phone: '+26878300001', password: 'password123', username: 'usr_a' });
    const b = await Buyer.create({ phone: '+26878300002', password: 'password123', username: 'usr_b' });
    await EventReaction.create({ eventId: event._id, buyerId: a._id, actorType: 'buyer', type: 'like' });
    await Follow.create({ followerType: 'buyer', followerId: b._id, targetType: 'buyer', targetId: a._id });

    const { items } = await getActivityFeed({ tab: 'everyone', limit: 30 });
    const types = items.map((i) => i.type);
    expect(types).toContain('like_event');
    expect(types).toContain('follow');
    expect(types).toContain('event');
    const stamps = items.map((i) => Date.parse(i.sortAt));
    expect([...stamps].sort((x, y) => y - x)).toEqual(stamps);
  });

  it('pages without duplicates or gaps', async () => {
    const { event } = await seedVendorEvent('E2');
    for (let i = 0; i < 12; i++) {
      const buyer = await Buyer.create({ phone: `+2687840${String(i).padStart(4, '0')}`, password: 'password123', username: `usr${i}` });
      await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res: any = await getActivityFeed({ tab: 'everyone', limit: 5, cursor });
      seen.push(...res.items.map((i: any) => i.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);            // no duplicates
    expect(seen.filter((id) => id.startsWith('like_event:'))).toHaveLength(12); // no gaps
  });

  it('treats a malformed cursor as "start from newest"', async () => {
    const { event } = await seedVendorEvent('E3');
    const buyer = await Buyer.create({ phone: '+26878300003', password: 'password123', username: 'usr_m' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const { items } = await getActivityFeed({ tab: 'everyone', limit: 30, cursor: 'not-base64-json' });
    expect(items.length).toBeGreaterThan(0);
  });

  it('clamps limit to 50', async () => {
    const res = await getActivityFeed({ tab: 'everyone', limit: 5000 });
    expect(res.items.length).toBeLessThanOrEqual(50);
  });

  it('following tab returns only followed actors, buyers AND organizers', async () => {
    const { vendor, event } = await seedVendorEvent('E4');
    const viewer = await Buyer.create({ phone: '+26878300004', password: 'password123', username: 'usr_v' });
    const friend = await Buyer.create({ phone: '+26878300005', password: 'password123', username: 'usr_f' });
    const stranger = await Buyer.create({ phone: '+26878300006', password: 'password123', username: 'usr_s' });
    await Follow.create({ followerType: 'buyer', followerId: viewer._id, targetType: 'buyer', targetId: friend._id });
    await Follow.create({ followerType: 'buyer', followerId: viewer._id, targetType: 'organizer', targetId: vendor._id });
    await EventReaction.create({ eventId: event._id, buyerId: friend._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: event._id, buyerId: stranger._id, actorType: 'buyer', type: 'like' });

    const { items } = await getActivityFeed({
      tab: 'following', limit: 30, viewer: { type: 'buyer', id: String(viewer._id) },
    });
    const actorIds = items.map((i) => i.actor.id);
    expect(actorIds).toContain(String(friend._id));
    expect(actorIds).toContain(String(vendor._id)); // the organizer's own "announced" row
    expect(actorIds).not.toContain(String(stranger._id));
  });

  it('nextCursor is null when history is exhausted', async () => {
    const { event } = await seedVendorEvent('E5');
    const buyer = await Buyer.create({ phone: '+26878300007', password: 'password123', username: 'usr_x' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    let cursor: string | undefined;
    let last: any;
    for (let page = 0; page < 10; page++) {
      last = await getActivityFeed({ tab: 'everyone', limit: 30, cursor });
      if (!last.nextCursor) break;
      cursor = last.nextCursor;
    }
    expect(last.nextCursor).toBeNull();
  });
});
