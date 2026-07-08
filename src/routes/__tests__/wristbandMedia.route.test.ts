import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';

jest.mock('@utils/r2.service', () => ({
  R2Service: {
    generateMediaKey: jest.fn((folder: string, name: string) => `${folder}/123-${name}`),
    uploadBufferToR2: jest.fn(async () => ({})),
    getPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
  },
}));

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const superAdmin = () => jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [], isSuperAdmin: true }, JWT_SECRET);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('uploads artwork to the event wristbands folder and returns the CDN url', async () => {
  const { eventId } = await seedPublishedEvent({});
  const res = await request(app)
    .post(`/api/media/events/${eventId}/wristband`)
    .set('Authorization', `Bearer ${superAdmin()}`)
    .attach('artwork', PNG, { filename: 'bg.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  expect(res.body.data.url).toBe(`https://cdn.test/events/${eventId}/wristbands/123-bg.png`);
});

it('403s for a plain organizer token', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  const t = jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [], vendorId }, JWT_SECRET);
  const res = await request(app)
    .post(`/api/media/events/${eventId}/wristband`)
    .set('Authorization', `Bearer ${t}`)
    .attach('artwork', PNG, { filename: 'bg.png', contentType: 'image/png' });
  expect(res.status).toBe(403);
});
