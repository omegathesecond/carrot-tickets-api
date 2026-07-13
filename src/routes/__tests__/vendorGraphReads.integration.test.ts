import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';

describe('vendor discovers, follows, then sees it in following', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('search → follow → following reflects the followed brand', async () => {
    const me = await Vendor.create({ businessName: 'Alpha Events', email: 'alpha@example.com', phoneNumber: '+26878000801', password: 'secret123' });
    const target = await Vendor.create({ businessName: 'Alpine Sound', email: 'alpine@example.com', phoneNumber: '+26878000802', password: 'secret123' });
    const token = `Bearer ${signVendorToken(String(me._id))}`;

    const search = await request(app).get('/api/tickets/social/users/search?q=alpine').set('Authorization', token).expect(200);
    const found = search.body.data.organizers.find((o: any) => o.id === String(target._id));
    expect(found).toBeTruthy();

    await request(app).post('/api/tickets/social/follow').set('Authorization', token).send({ targetType: 'organizer', targetId: found.id }).expect(200);

    const following = await request(app).get('/api/tickets/social/me/following').set('Authorization', token).expect(200);
    expect(following.body.data.organizers.map((o: any) => o.id)).toContain(String(target._id));
  });
});
