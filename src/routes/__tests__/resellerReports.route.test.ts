import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { seedOperator, seedReseller } from '../../__tests__/helpers/fixtures';
import { TicketSale } from '@models/ticketSale.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => { await TicketSale.deleteMany({}); });

async function tokenFor(role: string, opts?: { resellerId?: string; hubId?: string }) {
  const seeded = await seedOperator({ role, pin: '123456', ...opts });
  const login = await request(app)
    .post('/api/reseller/auth/login')
    .send({ loginCode: seeded.loginCode, pin: '123456' });
  return { token: login.body.data.accessToken as string, ...seeded };
}

/**
 * Seed a completed TicketSale attributed to a specific reseller/hub/operator.
 */
async function seedSale(params: {
  resellerId: string;
  hubId: string;
  operatorId: string;
  totalAmount: number;
  resellerCommissionAmount: number;
  quantity?: number;
}) {
  return TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: params.quantity ?? 1,
    totalAmount: params.totalAmount,
    paymentMethod: 'keshless_wallet',
    paymentStatus: 'completed',
    soldBy: new mongoose.Types.ObjectId(params.operatorId),
    soldByType: 'ResellerOperator',
    resellerId: new mongoose.Types.ObjectId(params.resellerId),
    hubId: new mongoose.Types.ObjectId(params.hubId),
    resellerCommissionAmount: params.resellerCommissionAmount,
    fundsCustody: 'carrot',
    soldAt: new Date(),
  });
}

describe('GET /api/reseller/reports', () => {
  it('hub_manager token → scope:"hub" with only their hub totals', async () => {
    // Create a reseller with two hubs
    const { resellerId } = await seedReseller();
    const hub2 = await (await import('@models/resellerHub.model')).ResellerHub.create({
      resellerId: new mongoose.Types.ObjectId(resellerId),
      name: 'Hub B',
    });

    // Seed hub manager under this reseller; seedOperator creates a hub for them
    const mgr = await tokenFor('reseller_hub_manager', { resellerId });
    const hub1Id2 = mgr.hubId;
    const hub2Id = hub2._id.toString();

    // Seed sales in hub1 (mgr's hub): 2 sales — revenue=150, commission=15
    await seedSale({ resellerId, hubId: hub1Id2, operatorId: mgr.operator._id.toString(), totalAmount: 100, resellerCommissionAmount: 10, quantity: 2 });
    await seedSale({ resellerId, hubId: hub1Id2, operatorId: mgr.operator._id.toString(), totalAmount: 50, resellerCommissionAmount: 5, quantity: 1 });

    // Seed sales in hub2 (different hub, same reseller): revenue=200, commission=20
    await seedSale({ resellerId, hubId: hub2Id, operatorId: new mongoose.Types.ObjectId().toString(), totalAmount: 200, resellerCommissionAmount: 20, quantity: 3 });

    const res = await request(app)
      .get('/api/reseller/reports')
      .set('Authorization', `Bearer ${mgr.token}`);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.scope).toBe('hub');
    // Hub manager sees only their hub: revenue=150, ticketsSold=3, commission=15
    expect(data.totals.revenue).toBe(150);
    expect(data.totals.ticketsSold).toBe(3);
    expect(data.totals.commission).toBe(15);
    // byHub should only contain hub1
    expect(data.byHub).toHaveLength(1);
    expect(data.byHub[0].hubId).toBe(hub1Id2);
    // Shape checks
    expect(Array.isArray(data.byEvent)).toBe(true);
    expect(Array.isArray(data.byOperator)).toBe(true);
  });

  it('admin token → scope:"reseller" with totals summed across both hubs', async () => {
    // Fresh reseller with two hubs
    const { resellerId, hubId: hub1Id } = await seedReseller();
    const hub2 = await (await import('@models/resellerHub.model')).ResellerHub.create({
      resellerId: new mongoose.Types.ObjectId(resellerId),
      name: 'Hub B Admin Test',
    });
    const hub2Id = hub2._id.toString();

    // Create admin for this reseller
    const admin = await tokenFor('reseller_admin', { resellerId, hubId: hub1Id });

    // Hub1 sales: revenue=300, commission=30, tickets=4
    await seedSale({ resellerId, hubId: hub1Id, operatorId: admin.operator._id.toString(), totalAmount: 300, resellerCommissionAmount: 30, quantity: 4 });

    // Hub2 sales: revenue=200, commission=20, tickets=2
    await seedSale({ resellerId, hubId: hub2Id, operatorId: new mongoose.Types.ObjectId().toString(), totalAmount: 200, resellerCommissionAmount: 20, quantity: 2 });

    const res = await request(app)
      .get('/api/reseller/reports')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.scope).toBe('reseller');
    // Admin sees sum across both hubs: revenue=500, tickets=6, commission=50
    expect(data.totals.revenue).toBe(500);
    expect(data.totals.ticketsSold).toBe(6);
    expect(data.totals.commission).toBe(50);
    // byHub should contain both hubs
    expect(data.byHub).toHaveLength(2);
    expect(Array.isArray(data.byEvent)).toBe(true);
    expect(Array.isArray(data.byOperator)).toBe(true);
  });

  it('operator token (lacks VIEW_REPORTS) → 403', async () => {
    const op = await tokenFor('reseller_operator');
    const res = await request(app)
      .get('/api/reseller/reports')
      .set('Authorization', `Bearer ${op.token}`);
    expect(res.status).toBe(403);
  });
});
