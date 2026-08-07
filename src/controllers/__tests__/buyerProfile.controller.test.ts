import { BuyerProfileController } from '@controllers/buyerProfile.controller';
import { Buyer } from '@models/buyer.model';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

/**
 * Regression coverage for the buyer-identity bug: an email-only buyer's token
 * carries buyerId but no userPhone, so a controller that resolves identity from
 * userPhone alone wrongly answered "Please sign in…" to a signed-in buyer.
 */
const mockRes = () => {
  const res: any = { req: { originalUrl: '/api/public/profile' } };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('BuyerProfileController.getProfile', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('resolves an email-only buyer (buyerId, no userPhone) instead of 401', async () => {
    const buyer = await Buyer.create({
      email: 'emailbuyer@example.com',
      password: 'secret6',
      emailVerifiedAt: new Date(),
      name: 'Email Buyer',
    });
    const req: any = { ticketsUser: { userType: 'buyer', buyerId: String(buyer._id) } };
    const res = mockRes();

    await BuyerProfileController.getProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.name).toBe('Email Buyer');
    expect(body.data.phone).toBeNull();
  });

  it('still resolves a phone-only (legacy) buyer', async () => {
    await Buyer.create({
      phone: '+26878422613',
      password: 'secret6',
      phoneVerifiedAt: new Date(),
    });
    const req: any = { ticketsUser: { userType: 'buyer', userPhone: '+26878422613' } };
    const res = mockRes();

    await BuyerProfileController.getProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.phone).toBe('+26878422613');
  });

  it('returns 401 when the token carries no buyer identity', async () => {
    const req: any = { ticketsUser: { userType: 'buyer' } };
    const res = mockRes();

    await BuyerProfileController.getProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
