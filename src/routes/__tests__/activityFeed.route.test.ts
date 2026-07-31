import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventReaction } from '@models/eventReaction.model';
import { EventStatus } from '@interfaces/event.interface';

const DAY = 86400000;

async function seedLike() {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org' });
  const event = await Event.create({
    vendorId: vendor._id, name: 'Winter Fest', venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED, publishedAt: new Date(Date.now() - DAY),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10 }],
  });
  const buyer = await Buyer.create({ phone: '+26878500001', password: 'password123', username: 'sipho', name: 'Sipho' });
  await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
  return { buyer, event };
}

describe('GET /api/public/activity-feed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('serves the everyone tab to an anonymous visitor', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity-feed');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.items[0]).toHaveProperty('actor.href');
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('401s on the following tab without a session', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity-feed?tab=following');
    expect(res.status).toBe(401);
  });

  it('serves the following tab with a session', async () => {
    const { buyer } = await seedLike();
    const res = await request(app)
      .get('/api/public/activity-feed?tab=following')
      .set('Authorization', `Bearer ${signBuyerToken(buyer.phone)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('rejects an unknown tab value', async () => {
    const res = await request(app).get('/api/public/activity-feed?tab=nonsense');
    expect(res.status).toBe(400);
  });

  it('does not touch the legacy ticker endpoint', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('activity');
  });

  it('falls back to the default limit instead of 500ing on a non-numeric limit', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity-feed?limit=abc');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('clamps limit=0 up to a sane minimum instead of erroring', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity-feed?limit=0');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeLessThanOrEqual(50);
  });

  it('clamps a huge limit down to the service max instead of erroring', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity-feed?limit=9999');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeLessThanOrEqual(50);
  });

  it('falls back to the default limit instead of 500ing on a non-integer limit', async () => {
    await seedLike();
    const res = await request(app).get('/api/public/activity-feed?limit=2.5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });
});
