import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventReaction } from '@models/eventReaction.model';
import { EventStatus } from '@interfaces/event.interface';

describe('GET /api/social/recommendations', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('recommends other upcoming events by the organizer of a saved event', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    const v = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret1' });
    const saved = await Event.create({ vendorId: v._id, name: 'Saved', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const rec = await Event.create({ vendorId: v._id, name: 'Recommended', venue: 'V', eventDate: new Date(Date.now() + 1.7e8), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    await EventReaction.create({ eventId: saved._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const res = await request(app).get('/api/social/recommendations').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    expect(res.body.data.basisEvent.name).toBe('Saved');
    const names = res.body.data.events.map((c: any) => c.name);
    expect(names).toContain('Recommended');
    expect(names).not.toContain('Saved'); // never recommend the basis itself
  });

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/recommendations').expect(401);
  });

  it('returns a null basisEvent and empty events when the buyer has saved nothing', async () => {
    await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    const res = await request(app).get('/api/social/recommendations').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    expect(res.body.data.basisEvent).toBeNull();
    expect(res.body.data.events).toEqual([]);
  });
});
