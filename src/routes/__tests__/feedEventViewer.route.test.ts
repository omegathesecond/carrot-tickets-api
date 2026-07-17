import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
import { EventStatus } from '@interfaces/event.interface';
import { toggleEventLike } from '@services/eventReaction.service';

const BUYER_PHONE = '+26878422613';

async function seedEvent(name: string) {
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(), name, venue: 'V',
    eventDate: new Date(Date.now() + 86400000),
    startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status: EventStatus.PUBLISHED,
  });
}

describe('GET /api/public/feed — event viewer reactions', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  beforeEach(async () => {
    await Buyer.create({ phone: BUYER_PHONE, password: 'secret123', username: 'tester' });
  });

  it('marks viewerReactions.liked=true for an event the viewing buyer liked', async () => {
    const e = await seedEvent('Liked Show');
    await toggleEventLike(e.id, { type: 'buyer', id: (await Buyer.findOne({ phone: BUYER_PHONE }))!.id });

    const res = await request(app)
      .get('/api/public/feed?tab=events')
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .expect(200);

    const slide = res.body.data.items.find((i: any) => i.type === 'event' && i.id === e.id);
    expect(slide).toBeTruthy();
    expect(slide.viewerReactions).toEqual({ liked: true });
  });

  // The events tab returns ONLY event slides — zero update slides. This is
  // exactly the window (feed pattern: u u u e u u a e) where nesting the
  // event-reaction attach inside `if (updateIds.length)` would silently skip
  // it. Asserting viewerReactions is present here proves the attach runs as
  // a sibling, not nested.
  it('attaches viewerReactions to event slides even when the window has zero update slides', async () => {
    await seedEvent('Unliked Show');

    const res = await request(app)
      .get('/api/public/feed?tab=events')
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .expect(200);

    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.items.every((i: any) => i.type === 'event')).toBe(true);
    for (const slide of res.body.data.items) {
      expect(slide.viewerReactions).toEqual({ liked: false });
    }
  });

  it('omits viewerReactions for an anonymous (unauthenticated) request', async () => {
    await seedEvent('Anon Show');

    const res = await request(app).get('/api/public/feed?tab=events').expect(200);
    const slide = res.body.data.items.find((i: any) => i.type === 'event');
    expect(slide).toBeTruthy();
    expect(slide.viewerReactions).toBeUndefined();
  });
});
