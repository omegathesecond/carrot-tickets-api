import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const PHONE = '+26878422613';

async function seedServicesVendor() {
  return Vendor.create({
    businessName: 'Luxe Decor',
    phoneNumber: '+26876500' + Math.floor(Math.random() * 10000),
    password: 'secret1',
    operatorType: OperatorType.SERVICES,
    serviceCategory: 'furniture_decor',
    verificationStatus: VerificationStatus.VERIFIED,
    bio: 'Elegant furniture & styling',
  });
}

function inboxAuth(vendorId: string) {
  return `Bearer ${signVendorToken(vendorId, { permissions: [TicketsPermission.MANAGE_ENQUIRIES] })}`;
}

describe('enquiry routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('buyer creates an enquiry, business inbox lists + updates it, a buyer token 403s the inbox', async () => {
    const biz = await seedServicesVendor();
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Curious Buyer' });
    const buyerAuth = `Bearer ${signBuyerToken(PHONE)}`;

    const created = await request(app)
      .post(`/api/public/services/${biz._id}/enquiries`)
      .set('Authorization', buyerAuth)
      .send({ message: 'Do you do weddings?', eventType: 'wedding' })
      .expect(201);
    expect(created.body.data.message).toBe('Do you do weddings?');
    const enquiryId = created.body.data._id ?? created.body.data.id;
    expect(enquiryId).toBeTruthy();

    // Business (services vendor with MANAGE_ENQUIRIES) reads its inbox.
    const inbox = await request(app)
      .get('/api/tickets/services/enquiries')
      .set('Authorization', inboxAuth(String(biz._id)))
      .expect(200);
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0].message).toBe('Do you do weddings?');
    expect(inbox.body.data[0].status).toBe('new');

    // Business updates the enquiry status.
    const patched = await request(app)
      .patch(`/api/tickets/services/enquiries/${enquiryId}/status`)
      .set('Authorization', inboxAuth(String(biz._id)))
      .send({ status: 'read' })
      .expect(200);
    expect(patched.body.data.status).toBe('read');

    // A buyer token lacks MANAGE_ENQUIRIES — the inbox is forbidden, not just unauthenticated.
    await request(app)
      .get('/api/tickets/services/enquiries')
      .set('Authorization', buyerAuth)
      .expect(403);
  });

  it('create requires buyer auth (401), a message (400), and a real business (404)', async () => {
    const biz = await seedServicesVendor();
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Curious Buyer' });
    const buyerAuth = `Bearer ${signBuyerToken(PHONE)}`;

    await request(app)
      .post(`/api/public/services/${biz._id}/enquiries`)
      .send({ message: 'hi' })
      .expect(401);

    await request(app)
      .post(`/api/public/services/${biz._id}/enquiries`)
      .set('Authorization', buyerAuth)
      .send({})
      .expect(400);

    await request(app)
      .post('/api/public/services/0123456789abcdef01234567/enquiries')
      .set('Authorization', buyerAuth)
      .send({ message: 'hi' })
      .expect(404);
  });

  it('malformed ids are clean 400s, never 500s', async () => {
    const biz = await seedServicesVendor();
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Curious Buyer' });
    await request(app)
      .post('/api/public/services/not-an-id/enquiries')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ message: 'hi' })
      .expect(400);

    await request(app)
      .patch('/api/tickets/services/enquiries/not-an-id/status')
      .set('Authorization', inboxAuth(String(biz._id)))
      .send({ status: 'read' })
      .expect(400);

    await request(app)
      .patch(`/api/tickets/services/enquiries/0123456789abcdef01234567/status`)
      .set('Authorization', inboxAuth(String(biz._id)))
      .send({ status: 'read' })
      .expect(404);
  });
});
