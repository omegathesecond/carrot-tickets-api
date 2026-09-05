// src/routes/__tests__/merchantAdmin.route.test.ts
//
// GET /api/tickets/merchants (the stall list) is the stall picker's data
// source for the dashboard Catalogue tab, which is gated on MANAGE_STOCK.
// The route itself was gated on MANAGE_ACCESS only, so a MANAGER-role
// organizer (who has MANAGE_STOCK but not MANAGE_ACCESS — see
// TICKETS_ROLE_PERMISSIONS) saw the tab but got a 403 fetching the stall
// list, and silently created products allocated to no stall.
//
// This suite pins the fix's exact scope: GET /merchants now accepts
// MANAGE_ACCESS OR MANAGE_STOCK, while POST /merchants and PATCH
// /merchants/:id (real access-management actions — creating/editing a
// stall) stay MANAGE_ACCESS-only. A stock manager may look, not touch.
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('GET /api/tickets/merchants', () => {
  it('a token with only MANAGE_STOCK reaches the stall list', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(vendorId, { permissions: [TicketsPermission.MANAGE_STOCK] });

    const res = await request(app)
      .get(`/api/tickets/merchants?eventId=${eventId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('a token with only MANAGE_ACCESS still reaches the stall list (no regression)', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(vendorId, { permissions: [TicketsPermission.MANAGE_ACCESS] });

    const res = await request(app)
      .get(`/api/tickets/merchants?eventId=${eventId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('a token with neither permission is refused', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(vendorId, { permissions: [] });

    const res = await request(app)
      .get(`/api/tickets/merchants?eventId=${eventId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe('scope of the relaxation — MANAGE_STOCK alone does not become MANAGE_ACCESS', () => {
  it('POST /api/tickets/merchants still refuses a MANAGE_STOCK-only token', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(vendorId, { permissions: [TicketsPermission.MANAGE_STOCK] });

    const res = await request(app)
      .post('/api/tickets/merchants')
      .set('Authorization', `Bearer ${token}`)
      .send({ eventId, name: 'New Stall' });

    expect(res.status).toBe(403);
  });

  it('PATCH /api/tickets/merchants/:id still refuses a MANAGE_STOCK-only token', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const merchant = await Merchant.create({ name: 'Existing Stall', eventId });
    const token = signVendorToken(vendorId, { permissions: [TicketsPermission.MANAGE_STOCK] });

    const res = await request(app)
      .patch(`/api/tickets/merchants/${merchant._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed Stall' });

    expect(res.status).toBe(403);
  });
});
