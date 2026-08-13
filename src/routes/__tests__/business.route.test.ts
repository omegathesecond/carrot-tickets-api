import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { AccountKind } from '@interfaces/vendor.interface';
import { BusinessReview } from '@models/businessReview.model';
import { BuyerOtp } from '@models/buyerOtp.model';

jest.mock('@services/email.service', () => ({ EmailService: { sendOtp: jest.fn().mockResolvedValue(true) } }));

describe('Business directory + profile + reviews routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('GET /api/public/businesses lists only BUSINESS-kind vendors, filterable by category', async () => {
    await Vendor.create({
      businessName: 'Loud Sound Hire', password: 'secret6', email: 'sound@x.com',
      accountKind: AccountKind.BUSINESS, serviceCategory: 'Sound Hire',
    });
    await Vendor.create({
      businessName: 'Decor Delights', password: 'secret6', email: 'decor@x.com',
      accountKind: AccountKind.BUSINESS, serviceCategory: 'Furniture & Decor',
    });
    // Noise: an ordinary event organizer must never show up in the directory.
    await Vendor.create({ businessName: 'Big Events Co', password: 'secret6', email: 'org@x.com' });

    const all = await request(app).get('/api/public/businesses');
    expect(all.status).toBe(200);
    expect(all.body.data.items).toHaveLength(2);

    const filtered = await request(app).get('/api/public/businesses').query({ category: 'Sound Hire' });
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.items[0].businessName).toBe('Loud Sound Hire');
  });

  it('GET /api/public/businesses/:id returns bio/category/contact but 404s for an organizer id', async () => {
    const business = await Vendor.create({
      businessName: 'Loud Sound Hire', password: 'secret6', email: 'sound@x.com', phoneNumber: '+26878400001',
      accountKind: AccountKind.BUSINESS, serviceCategory: 'Sound Hire', bio: 'We bring the noise.',
    });
    const organizer = await Vendor.create({ businessName: 'Big Events Co', password: 'secret6', email: 'org@x.com' });

    const res = await request(app).get(`/api/public/businesses/${business._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      businessName: 'Loud Sound Hire',
      serviceCategory: 'Sound Hire',
      bio: 'We bring the noise.',
      email: 'sound@x.com',
      phoneNumber: '+26878400001',
    });

    const notFound = await request(app).get(`/api/public/businesses/${organizer._id}`);
    expect(notFound.status).toBe(404);
  });

  it('a signed-in buyer can submit one review per business; a second attempt 409s', async () => {
    const business = await Vendor.create({
      businessName: 'Loud Sound Hire', password: 'secret6', email: 'sound@x.com',
      accountKind: AccountKind.BUSINESS, serviceCategory: 'Sound Hire',
    });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret6' });
    const token = signBuyerToken(buyer.phone!);

    const submit = await request(app)
      .post(`/api/public/businesses/${business._id}/reviews`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rating: 5, text: 'Great sound!' });
    expect(submit.status).toBe(201);
    expect(submit.body.data.rating).toBe(5);

    const dup = await request(app)
      .post(`/api/public/businesses/${business._id}/reviews`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rating: 4 });
    expect(dup.status).toBe(409);

    const list = await request(app).get(`/api/public/businesses/${business._id}/reviews`);
    expect(list.status).toBe(200);
    expect(list.body.data.aggregate).toEqual({ average: 5, count: 1 });
    expect(list.body.data.reviews).toHaveLength(1);
  });

  it('rejects an unauthenticated review submission', async () => {
    const business = await Vendor.create({
      businessName: 'Loud Sound Hire', password: 'secret6', email: 'sound@x.com',
      accountKind: AccountKind.BUSINESS, serviceCategory: 'Sound Hire',
    });
    const res = await request(app)
      .post(`/api/public/businesses/${business._id}/reviews`)
      .send({ rating: 5 });
    expect(res.status).toBe(401);
    expect(await BusinessReview.countDocuments({})).toBe(0);
  });

  it('rejects registration query on a non-hex id', async () => {
    const res = await request(app).get(`/api/public/businesses/${new mongoose.Types.ObjectId()}notahexid`);
    expect(res.status).toBe(400);
  });

  it('full signup: request-otp then register creates a BUSINESS vendor and signs it in', async () => {
    const { EmailService } = require('@services/email.service');

    const requestOtp = await request(app)
      .post('/api/public/businesses/register/request-otp')
      .send({ identifier: 'newbiz@x.com' });
    expect(requestOtp.status).toBe(200);
    expect(requestOtp.body.data.channel).toBe('email');

    const code = (EmailService.sendOtp as jest.Mock).mock.calls[0][1];
    const otpBefore = await BuyerOtp.findOne({ destination: 'newbiz@x.com' });
    expect(otpBefore!.consumed).toBe(false);

    const register = await request(app)
      .post('/api/public/businesses/register')
      .send({
        identifier: 'newbiz@x.com',
        code,
        password: 'secret6',
        businessName: 'Fresh Bites Catering',
        serviceCategory: 'Catering',
      });
    expect(register.status).toBe(200);
    expect(register.body.data.accessToken).toBeTruthy();
    expect(register.body.data.refreshToken).toBeTruthy();

    const vendor = await Vendor.findOne({ email: 'newbiz@x.com' });
    expect(vendor!.accountKind).toBe(AccountKind.BUSINESS);
    expect(vendor!.serviceCategory).toBe('Catering');
  });
});
