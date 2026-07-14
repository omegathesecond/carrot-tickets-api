import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';

describe('social SSO handoff', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('mints a handoff from a dashboard session and exchanges it for a working vendor token, once', async () => {
    const vendor = await Vendor.create({ businessName: 'Handoff Co', email: 'ho@example.com', phoneNumber: '+26878006001', password: 'secret123' });
    const dashTok = `Bearer ${signVendorToken(String(vendor._id))}`;

    const mint = await request(app).post('/api/tickets/auth/handoff').set('Authorization', dashTok).expect(200);
    const handoff = mint.body.data.handoff;
    expect(typeof handoff).toBe('string');

    const ex = await request(app).post('/api/tickets/auth/handoff/exchange').send({ handoff }).expect(200);
    const accessToken = ex.body.data.accessToken;
    expect(typeof accessToken).toBe('string');

    // The exchanged token works as a real vendor session.
    const me = await request(app).get('/api/tickets/social/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(me.body.data.id).toBe(String(vendor._id));

    // Single-use: a second exchange of the same handoff is rejected.
    await request(app).post('/api/tickets/auth/handoff/exchange').send({ handoff }).expect(401);
  });

  it('rejects a forged/garbage handoff and requires a vendor token to mint', async () => {
    await request(app).post('/api/tickets/auth/handoff/exchange').send({ handoff: 'not.a.jwt' }).expect(401);
    // A buyer token has no vendorId → cannot mint a brand handoff.
    await request(app).post('/api/tickets/auth/handoff').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
    // Missing body.
    await request(app).post('/api/tickets/auth/handoff/exchange').send({}).expect(400);
    void new mongoose.Types.ObjectId();
  });
});
