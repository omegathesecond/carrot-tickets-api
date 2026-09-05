import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { R2Service } from '@utils/r2.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// R2 is not reachable from a test run, and this suite is about routing,
// ownership and file validation — not about object storage. Stub the one
// call the controller makes and assert on what it was asked to store.
jest.mock('@utils/r2.service', () => {
  const actual = jest.requireActual('@utils/r2.service');
  return {
    ...actual,
    R2Service: {
      ...actual.R2Service,
      uploadEventMedia: jest.fn().mockResolvedValue({
        key: 'events/e1/menu-item/123-burger.jpg',
        url: 'https://cdn.example/events/e1/menu-item/123-burger.jpg',
      }),
      deleteEventMediaByUrl: jest.fn().mockResolvedValue(undefined),
    },
  };
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe.each([
  ['menu-item', 'menu-item'],
  ['product', 'product'],
])('POST /api/media/events/:eventId/%s', (segment, mediaType) => {
  it('stores the file under its own media type and returns the url', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(String(vendorId));

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, 'burger.png');

    expect(res.status).toBe(200);
    expect(res.body.data.media.url).toMatch(/^https?:\/\//);
    // The media type is what keeps a product photo out of the menu folder.
    expect(R2Service.uploadEventMedia).toHaveBeenCalledWith(
      String(eventId), mediaType, 'burger.png', expect.any(Buffer), 'image/png',
    );
  });

  it('never writes the url onto a document — it only returns it', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(String(vendorId));

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, 'burger.png');

    // Saving the url is the caller's next request, not this one's business.
    expect(res.body.data.menuItem).toBeUndefined();
    expect(res.body.data.product).toBeUndefined();
  });

  it('refuses an event the caller does not own', async () => {
    const { eventId } = await seedPublishedEvent({});
    const someoneElse = signVendorToken('64b000000000000000000a01');

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${someoneElse}`)
      .attach('image', png, 'burger.png');

    expect([403, 404]).toContain(res.status);
  });

  it('rejects a non-image file', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(String(vendorId));

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('not an image'), 'notes.txt');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects a request with no file at all', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(String(vendorId));

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

it('keeps the two media types in separate folders', () => {
  const actual = jest.requireActual('@utils/r2.service').R2Service;
  expect(actual.getEventMediaFolder('e1', 'menu-item'))
    .not.toEqual(actual.getEventMediaFolder('e1', 'product'));
});
