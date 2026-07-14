import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

describe('GET /api/tickets/social/users/search (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('finds buyers by username prefix and brands by name, excluding self', async () => {
    const me = await Vendor.create({ businessName: 'Bhora Fest', email: 'me-search@example.com', phoneNumber: '+26878000701', password: 'secret123' });
    const other = await Vendor.create({ businessName: 'Bhora Nights', email: 'other-search@example.com', phoneNumber: '+26878000702', password: 'secret123' });
    await Buyer.create({ phone: '+26878000703', password: 'secret1', name: 'Bo', username: 'bhora_fan' });
    const token = `Bearer ${signVendorToken(String(me._id))}`;

    const res = await request(app).get('/api/tickets/social/users/search?q=bho').set('Authorization', token).expect(200);
    expect(res.body.data.buyers.map((b: any) => b.username)).toContain('bhora_fan');
    const orgIds = res.body.data.organizers.map((o: any) => o.id);
    expect(orgIds).toContain(String(other._id)); // matches "Bhora Nights"
    expect(orgIds).not.toContain(String(me._id)); // self excluded
  });

  it('400s a too-short query', async () => {
    const me = await Vendor.create({ businessName: 'Solo Brand', email: 'solo@example.com', phoneNumber: '+26878000704', password: 'secret123' });
    await request(app).get('/api/tickets/social/users/search?q=b').set('Authorization', `Bearer ${signVendorToken(String(me._id))}`).expect(400);
  });

  it('401s a buyer token (no vendorId)', async () => {
    await request(app).get('/api/tickets/social/users/search?q=test')
      .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
  });
});
