import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

describe('/api/tickets/social/notifications (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lists follow notifications and marks them read', async () => {
    const brand = await Vendor.create({ businessName: 'Notif Brand', email: 'notif@example.com', phoneNumber: '+26878001001', password: 'secret123' });
    await Buyer.create({ phone: '+26878001002', password: 'secret1', name: 'Fan', username: 'fan_one' });
    const brandToken = `Bearer ${signVendorToken(String(brand._id))}`;

    await request(app).post('/api/social/follow').set('Authorization', `Bearer ${signBuyerToken('+26878001002')}`).send({ targetType: 'organizer', targetId: String(brand._id) }).expect(200);

    const list = await request(app).get('/api/tickets/social/notifications').set('Authorization', brandToken).expect(200);
    expect(list.body.data.unreadCount).toBe(1);
    expect(list.body.data.items[0].type).toBe('follow');

    await request(app).post('/api/tickets/social/notifications/read').set('Authorization', brandToken).send({}).expect(200);
    const after = await request(app).get('/api/tickets/social/notifications').set('Authorization', brandToken).expect(200);
    expect(after.body.data.unreadCount).toBe(0);
  });

  it('401s a buyer token', async () => {
    await request(app).get('/api/tickets/social/notifications').set('Authorization', `Bearer ${signBuyerToken('+26878001002')}`).expect(401);
  });

  it('400s a non-numeric limit (shared cursor-param parser, not hand-rolled NaN)', async () => {
    const brand = await Vendor.create({ businessName: 'Notif Brand 2', email: 'notif2@example.com', phoneNumber: '+26878001003', password: 'secret123' });
    const brandToken = `Bearer ${signVendorToken(String(brand._id))}`;
    await request(app).get('/api/tickets/social/notifications?limit=abc').set('Authorization', brandToken).expect(400);
  });
});
