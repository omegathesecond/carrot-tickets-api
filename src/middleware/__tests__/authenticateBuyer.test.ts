import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { Buyer } from '@models/buyer.model';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

const mockRes = () => {
  const res: any = { req: { originalUrl: '/test' } };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('authenticateBuyer', () => {
  it('accepts a buyerId-only (email buyer) token', async () => {
    const buyer = await Buyer.create({ email: 'e@x.com', password: 'secret123' });
    const token = BuyerAuthService.signToken(buyer);
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();
    await authenticateBuyer(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.ticketsUser.buyerId).toBe(String(buyer._id));
  });

  it('rejects an obsolete userPhone-only token without a persisted session version', async () => {
    const token = jwt.sign({ userType: 'buyer', app: 'tickets', userPhone: '+26878422613' }, JWT_SECRET);
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();
    const res = mockRes();
    await authenticateBuyer(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a buyer token carrying neither buyerId nor userPhone', async () => {
    const token = jwt.sign({ userType: 'buyer', app: 'tickets' }, JWT_SECRET);
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();
    const res = mockRes();
    await authenticateBuyer(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('resolveBuyerFromRequest', () => {

  it('resolves an email-only buyer by buyerId', async () => {
    const buyer = await Buyer.create({
      email: 'buyerid@example.com',
      password: 'secret6',
      emailVerifiedAt: new Date(),
    });
    const req: any = { ticketsUser: { userType: 'buyer', buyerId: String(buyer._id) } };
    const resolved = await resolveBuyerFromRequest(req);
    expect(resolved).not.toBeNull();
    expect(String(resolved?._id)).toBe(String(buyer._id));
  });

  it('resolves a phone buyer via the userPhone fallback', async () => {
    const buyer = await Buyer.create({
      phone: '+26878422613',
      password: 'secret6',
      phoneVerifiedAt: new Date(),
    });
    const req: any = { ticketsUser: { userType: 'buyer', userPhone: buyer.phone } };
    const resolved = await resolveBuyerFromRequest(req);
    expect(resolved).not.toBeNull();
    expect(String(resolved?._id)).toBe(String(buyer._id));
  });
});
