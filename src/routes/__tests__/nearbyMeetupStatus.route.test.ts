import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken } from '@/__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { MeetupRequest } from '@models/meetupRequest.model';

const auth = (phone: string) => ({ Authorization: `Bearer ${signBuyerToken(phone)}` });
const ME = '+26878422613';

describe('GET /api/social/nearby/people meetup status', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Buyer.init(); // 2dsphere index
    await MeetupRequest.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('reflects the viewer outgoing meetup status per person', async () => {
    const me = await Buyer.create({
      phone: ME, password: 'secret1', name: 'Me', username: 'me_one',
      location: { type: 'Point', coordinates: [31.13, -26.31] }, locationUpdatedAt: new Date(),
    });
    const near = await Buyer.create({
      phone: '+26878000001', password: 'secret1', name: 'Near', username: 'near_a',
      location: { type: 'Point', coordinates: [31.131, -26.311] }, locationUpdatedAt: new Date(),
    });
    await MeetupRequest.create({ requesterId: me._id, targetId: near._id, status: 'pending' });

    const res = await request(app)
      .get('/api/social/nearby/people?lat=-26.31&lng=31.13&radiusKm=25')
      .set(auth(ME))
      .expect(200);
    const row = res.body.data.people.find((p: any) => p.username === 'near_a');
    expect(row.meetupStatus).toBe('pending');
    expect(typeof row.meetupRequestId).toBe('string');
  });
});
