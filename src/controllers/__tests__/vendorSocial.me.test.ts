import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { TicketsPermission, TicketsRole, TICKETS_ROLE_PERMISSIONS } from '@interfaces/ticketsPermission.interface';
import vendorSocialRoutes from '@routes/vendorSocial.route';
import { Vendor } from '@models/vendor.model';

const SECRET = process.env['JWT_SECRET'] || 'test-secret-key';

const app = express();
app.use(express.json());
app.use('/api/tickets/social', vendorSocialRoutes);

let vendorId: string;

beforeAll(async () => {
  await connectTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearTestDb();
  const vendor = await Vendor.create({
    email: 'brand@example.com',
    password: 'secret123',
    businessName: 'Carrot Live',
  });
  vendorId = String(vendor._id);
});

function tokenFor(role: TicketsRole, permissions: TicketsPermission[]): string {
  return jwt.sign(
    { app: 'tickets', vendorId, userType: 'sub-user', role, permissions },
    SECRET
  );
}

/**
 * GET /api/tickets/social/me sits behind authenticateTickets only, but the
 * ONLY way to satisfy the PhotoGate (POST /organizer/profile/logo) requires
 * EDIT_BRAND. `canEditBrand` tells the client whether this session could ever
 * clear the gate, so a SALES/SCANNER sub-user is never shown an exit it will
 * be 403'd out of. See the C1 finding.
 *
 * EDIT_BRAND is vertical-neutral (belongs to neither EVENT_PERMISSIONS nor
 * TRANSPORT_PERMISSIONS — see permissions.util.test.ts), granted only to the
 * brand-owner roles (OWNER/MANAGER), so this holds for events, transport,
 * and BOTH operators alike; SALES/SCANNER never get it regardless of vertical.
 */
describe('GET /api/tickets/social/me — canEditBrand', () => {
  it('is false for a SALES sub-user token (no EDIT_BRAND)', async () => {
    const res = await request(app)
      .get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${tokenFor(TicketsRole.SALES, TICKETS_ROLE_PERMISSIONS[TicketsRole.SALES])}`);

    expect(res.status).toBe(200);
    expect(res.body.data.canEditBrand).toBe(false);
  });

  it('is false for a SCANNER sub-user token (no EDIT_BRAND)', async () => {
    const res = await request(app)
      .get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${tokenFor(TicketsRole.SCANNER, TICKETS_ROLE_PERMISSIONS[TicketsRole.SCANNER])}`);

    expect(res.status).toBe(200);
    expect(res.body.data.canEditBrand).toBe(false);
  });

  it('is true for an OWNER token (has EDIT_BRAND)', async () => {
    const res = await request(app)
      .get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${tokenFor(TicketsRole.OWNER, TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER])}`);

    expect(res.status).toBe(200);
    expect(res.body.data.canEditBrand).toBe(true);
  });

  it('is true for a MANAGER token (has EDIT_BRAND)', async () => {
    const res = await request(app)
      .get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${tokenFor(TicketsRole.MANAGER, TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER])}`);

    expect(res.status).toBe(200);
    expect(res.body.data.canEditBrand).toBe(true);
  });

  it('is true for a token carrying EDIT_BRAND explicitly, regardless of role', async () => {
    const res = await request(app)
      .get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${tokenFor(TicketsRole.SALES, [TicketsPermission.EDIT_BRAND])}`);

    expect(res.status).toBe(200);
    expect(res.body.data.canEditBrand).toBe(true);
  });

  it('is false for a SALES sub-user even if it somehow carries EDIT_EVENT but not EDIT_BRAND (axis is brand, not events)', async () => {
    const res = await request(app)
      .get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${tokenFor(TicketsRole.SALES, [TicketsPermission.EDIT_EVENT])}`);

    expect(res.status).toBe(200);
    expect(res.body.data.canEditBrand).toBe(false);
  });

  it('is false when the token carries no permissions array at all', async () => {
    const token = jwt.sign({ app: 'tickets', vendorId, userType: 'sub-user' }, SECRET);
    const res = await request(app).get('/api/tickets/social/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.canEditBrand).toBe(false);
  });

  it('still returns the brand identity alongside the flag', async () => {
    const res = await request(app)
      .get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${tokenFor(TicketsRole.SALES, TICKETS_ROLE_PERMISSIONS[TicketsRole.SALES])}`);

    expect(res.body.data).toMatchObject({
      id: vendorId,
      businessName: 'Carrot Live',
      logoUrl: null,
      canEditBrand: false,
    });
  });
});
