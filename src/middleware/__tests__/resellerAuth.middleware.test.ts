import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedOperator } from '@/__tests__/helpers/fixtures';
import { authenticateReseller, requireResellerPermission } from '@middleware/resellerAuth.middleware';
import { ResellerPermission } from '@interfaces/resellerPermission.interface';
import jwt from 'jsonwebtoken';

const mockRes = () => { const r: any = { req: { originalUrl: '/test' } }; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

it('rejects a vendor-scoped token (no reseller scope)', async () => {
  const vendorToken = jwt.sign({ vendorId: 'v1', userType: 'vendor' }, SECRET);
  const req: any = { headers: { authorization: `Bearer ${vendorToken}` } };
  const res = mockRes(); const next = jest.fn();
  await authenticateReseller(req, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
});

it('accepts a reseller token and enforces permission', async () => {
  const { resellerId, operator } = await seedOperator({ role: 'reseller_operator' });
  const token = jwt.sign({ scope: 'reseller', resellerId, hubId: null, operatorId: String(operator._id),
    role: 'reseller_operator', permissions: [ResellerPermission.SELL_TICKETS] }, SECRET);
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes(); let next = jest.fn();
  await authenticateReseller(req, res, next);
  expect(req.reseller.resellerId).toBe(resellerId);
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS)(req, res, next = jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);
});
