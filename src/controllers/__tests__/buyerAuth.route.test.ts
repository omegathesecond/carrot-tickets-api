import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Ticket } from '@models/ticket.model';
import { EmailService } from '@services/email.service';
import { JWT_SECRET } from '@config/jwt.config';

jest.mock('@services/email.service');

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});
afterAll(disconnectTestDb);

describe('POST /api/public/auth/login', () => {
  it('logs in by email', async () => {
    await Buyer.create({ email: 'r@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    const res = await request(app).post('/api/public/auth/login').send({ identifier: 'r@x.com', password: 'secret6' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.identity.email).toBe('r@x.com');
  });

  it('reports requiresRegistration for an unknown email', async () => {
    const res = await request(app).post('/api/public/auth/login').send({ identifier: 'no@x.com', password: 'secret6' });
    expect(res.status).toBe(200);
    expect(res.body.data.requiresRegistration).toBe(true);
    expect(res.body.data.channel).toBe('email');
  });
});

describe('POST /api/public/auth/request-otp + /auth/register', () => {
  it('sends an email OTP and registers the buyer', async () => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);

    const otpRes = await request(app).post('/api/public/auth/request-otp').send({ identifier: 'new@x.com' });
    expect(otpRes.status).toBe(200);
    expect(otpRes.body.data.channel).toBe('email');
    expect(otpRes.body.data.identifier).toBe('new@x.com');

    const code = (EmailService.sendOtp as jest.Mock).mock.calls[0][1];

    const registerRes = await request(app)
      .post('/api/public/auth/register')
      .send({ identifier: 'new@x.com', code, password: 'secret6', name: 'New Buyer' });
    expect(registerRes.status).toBe(200);
    expect(registerRes.body.data.accessToken).toBeTruthy();
    expect(registerRes.body.data.identity.email).toBe('new@x.com');
  });
});

describe('GET /api/public/my-tickets', () => {
  it('returns tickets for an email-only buyer, resolved by buyerId', async () => {
    const buyer = await Buyer.create({ email: 'mt@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    await Ticket.create({
      eventId: new mongoose.Types.ObjectId(),
      vendorId: new mongoose.Types.ObjectId(),
      ticketType: 'GA',
      price: 0,
      ticketId: 'Z',
      buyerId: buyer._id,
    } as any);
    const token = jwt.sign(
      { userType: 'buyer', app: 'tickets', buyerId: String(buyer._id), userEmail: 'mt@x.com' },
      JWT_SECRET
    );

    const res = await request(app).get('/api/public/my-tickets').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((t: any) => t.ticketId)).toContain('Z');
  });

  it('401s when no buyer can be resolved from the token', async () => {
    const res = await request(app).get('/api/public/my-tickets');
    expect(res.status).toBe(401);
  });
});
