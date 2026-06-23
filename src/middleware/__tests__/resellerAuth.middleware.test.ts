import { authenticateReseller, requireResellerPermission } from '@middleware/resellerAuth.middleware';
import { ResellerPermission } from '@interfaces/resellerPermission.interface';
import jwt from 'jsonwebtoken';

const mockRes = () => { const r: any = { req: { originalUrl: '/test' } }; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

it('rejects a vendor-scoped token (no reseller scope)', () => {
  const vendorToken = jwt.sign({ vendorId: 'v1', userType: 'vendor' }, SECRET);
  const req: any = { headers: { authorization: `Bearer ${vendorToken}` } };
  const res = mockRes(); const next = jest.fn();
  authenticateReseller(req, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
});

it('accepts a reseller token and enforces permission', () => {
  const token = jwt.sign({ scope: 'reseller', resellerId: 'r1', hubId: 'h1', operatorId: 'o1',
    role: 'reseller_operator', permissions: [ResellerPermission.SELL_TICKETS] }, SECRET);
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes(); let next = jest.fn();
  authenticateReseller(req, res, next);
  expect(req.reseller.resellerId).toBe('r1');
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS)(req, res, next = jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);
});
