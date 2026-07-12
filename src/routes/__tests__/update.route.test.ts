import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined), reconcileStuckUpdates: jest.fn() }));

const PHONE = '+26878422613';

describe('POST /api/public/updates', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a processing video update and returns a presigned upload url', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Poster' });
    const res = await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'video', caption: 'my clip', ext: 'mp4', contentType: 'video/mp4' })
      .expect(201);
    expect(res.body.data.uploadUrl).toContain('https://r2.example/put');
    expect(res.body.data.updateId).toBeTruthy();
  });

  it('rejects a mismatched kind/contentType', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1' });
    await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'video', caption: '', ext: 'jpg', contentType: 'image/jpeg' })
      .expect(400);
  });

  it('401s without a token', async () => {
    await request(app).post('/api/public/updates').send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' }).expect(401);
  });
});
