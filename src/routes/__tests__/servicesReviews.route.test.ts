// api/src/routes/__tests__/servicesReviews.route.test.ts
//
// Task E2: HTTP wiring for enquiry-gated service reviews —
// GET/POST /api/public/services/:businessId/reviews. Service-layer behavior
// (the enquiry gate, 409 on dup, the { $exists: false } list filter) is
// covered by src/services/__tests__/review.serviceGate.test.ts; this file
// only checks the route/controller plumbing (auth, validation, status codes).
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';
import { Review } from '@models/review.model';

const PHONE = '+26878422613';

async function seedServicesVendor() {
  return Vendor.create({
    businessName: 'Luxe Decor',
    phoneNumber: '+26876500' + Math.floor(Math.random() * 10000),
    password: 'secret1',
    operatorType: OperatorType.SERVICES,
    serviceCategory: 'furniture_decor',
    verificationStatus: VerificationStatus.VERIFIED,
  });
}

describe('services review routes', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Review.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('403s without an enquiry, then buyer posts after enquiring, public reads it, a second post 409s', async () => {
    const biz = await seedServicesVendor();
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Curious Buyer', username: 'curious_buyer' });
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    await request(app)
      .post(`/api/public/services/${biz._id}/reviews`)
      .set('Authorization', auth)
      .send({ rating: 5, text: 'Gorgeous setup' })
      .expect(403);

    await request(app)
      .post(`/api/public/services/${biz._id}/enquiries`)
      .set('Authorization', auth)
      .send({ message: 'Do you do weddings?' })
      .expect(201);

    const posted = await request(app)
      .post(`/api/public/services/${biz._id}/reviews`)
      .set('Authorization', auth)
      .send({ rating: 5, text: 'Gorgeous setup' })
      .expect(201);
    expect(posted.body.data.reviewer.username).toBe('curious_buyer');

    const pub = await request(app).get(`/api/public/services/${biz._id}/reviews`).expect(200);
    expect(pub.body.data.reviews).toHaveLength(1);
    expect(pub.body.data.reviews[0].text).toBe('Gorgeous setup');

    await request(app)
      .post(`/api/public/services/${biz._id}/reviews`)
      .set('Authorization', auth)
      .send({ rating: 4 })
      .expect(409);
  });

  it('write requires auth (401) and a valid rating (400); malformed businessId is a clean 400', async () => {
    const biz = await seedServicesVendor();
    await Buyer.create({ phone: PHONE, password: 'secret1' });
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    await request(app).post(`/api/public/services/${biz._id}/reviews`).send({ rating: 5 }).expect(401);
    await request(app)
      .post(`/api/public/services/${biz._id}/reviews`)
      .set('Authorization', auth)
      .send({ rating: 6 })
      .expect(400);

    await request(app)
      .post('/api/public/services/not-an-id/reviews')
      .set('Authorization', auth)
      .send({ rating: 5 })
      .expect(400);
    await request(app).get('/api/public/services/not-an-id/reviews').expect(400);
  });
});
