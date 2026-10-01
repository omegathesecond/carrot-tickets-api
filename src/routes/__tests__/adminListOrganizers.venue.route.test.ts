import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('GET /api/tickets/admin/organizers — venue', () => {
  it('each organizer row carries its venue summary, or null', async () => {
    const withVenue = await Vendor.create({ businessName: 'Rooftop', email: 'roof@x.co', password: 'secret1', businessType: 'venue' });
    const without = await Vendor.create({ businessName: 'Gigs Co', email: 'gigs@x.co', password: 'secret1' });
    await Venue.create({ vendorId: withVenue._id, name: 'Rooftop', currency: 'ZAR', activatedBy: 'admin' });

    const res = await request(app).get('/api/tickets/admin/organizers').set('Authorization', `Bearer ${signSuperAdminToken()}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.organizers as Array<{ id: string; venue: unknown }>;
    expect(rows.find((r) => r.id === String(withVenue._id))?.venue).toMatchObject({ name: 'Rooftop', currency: 'ZAR', status: 'active' });
    expect(rows.find((r) => r.id === String(without._id))?.venue).toBeNull();
  });
});
