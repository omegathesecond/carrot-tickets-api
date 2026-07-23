import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { EventReaction } from '@models/eventReaction.model';

const PHONE = '+26878422613';

describe('GET /api/social/me/saved', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns the buyer\'s saved updates and saved (liked) events', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    const author = await Buyer.create({ phone: '+26878000009', password: 'secret1', name: 'Author', username: 'author9' });
    const u = await Update.create({ authorType: 'buyer', authorId: author._id, kind: 'image', caption: 'saved post', media: { rawKey: 'k', status: 'ready', image: { url: 'https://cdn/i.jpg', width: 1, height: 1 } } });
    await UpdateReaction.create({ updateId: u._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });
    const e = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'Saved Event', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    await EventReaction.create({ eventId: e._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const res = await request(app).get('/api/social/me/saved').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.updates.map((s: any) => s.caption)).toEqual(['saved post']);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Saved Event']);
  });

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/me/saved').expect(401);
  });
});
