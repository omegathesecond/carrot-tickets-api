import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { R2Service } from '@utils/r2.service';

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});
afterAll(disconnectTestDb);

// R2 is not reachable from a test run, and this suite is about routing,
// scope resolution and where the file is filed — not about object storage.
// Stub the one call the controller makes and assert on what it was asked to
// store. (Static class methods are not enumerable, so only the stub survives
// the spread — exactly as in mediaItemImage.route.test.ts.)
jest.mock('@utils/r2.service', () => {
  const actual = jest.requireActual('@utils/r2.service');
  return {
    ...actual,
    R2Service: {
      ...actual.R2Service,
      uploadFile: jest.fn(),
    },
  };
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let seq = 0;
async function vendorAccount(withVenue: boolean, permissions: string[] = [TicketsPermission.MANAGE_STOCK]) {
  seq += 1;
  const vendor = await Vendor.create({ businessName: `Lounge ${seq}`, email: `img${seq}@x.co`, password: 'secret1', businessType: 'venue' });
  const venue = withVenue
    ? await Venue.create({ vendorId: vendor._id, name: `Lounge ${seq}`, currency: 'SZL', activatedBy: 'admin' })
    : null;
  const token = signVendorToken(String(vendor._id), { permissions });
  return { venueId: venue ? String(venue._id) : null, auth: `Bearer ${token}` };
}

describe('POST /api/media/venue/product', () => {
  it('uploads a venue product image under venues/<venueId>/product', async () => {
    const v = await vendorAccount(true);
    (R2Service.uploadFile as jest.Mock).mockResolvedValue({ key: 'venues/x/product/1-a.png', url: 'https://cdn/x.png' });

    const res = await request(app).post('/api/media/venue/product').set('Authorization', v.auth)
      .attach('image', png, 'a.png');

    expect(res.status).toBe(200);
    expect(res.body.data.media).toEqual({ key: 'venues/x/product/1-a.png', url: 'https://cdn/x.png', type: 'product' });
    expect(R2Service.uploadFile).toHaveBeenCalledTimes(1);
    expect((R2Service.uploadFile as jest.Mock).mock.calls[0][0]).toBe(`venues/${v.venueId}/product`);
    // Like the event routes, this only returns the url — it writes no record.
    expect(Object.keys(res.body.data)).toEqual(['media']);
  });

  it('refuses an account with no venue (404) before touching R2', async () => {
    const organizer = await vendorAccount(false);

    const res = await request(app).post('/api/media/venue/product').set('Authorization', organizer.auth)
      .attach('image', png, 'a.png');

    expect(res.status).toBe(404);
    expect(R2Service.uploadFile).not.toHaveBeenCalled();
  });

  it('refuses a caller without tickets:manage_stock (403) before touching R2', async () => {
    const v = await vendorAccount(true, []);

    const res = await request(app).post('/api/media/venue/product').set('Authorization', v.auth)
      .attach('image', png, 'a.png');

    expect(res.status).toBe(403);
    expect(R2Service.uploadFile).not.toHaveBeenCalled();
  });
});
