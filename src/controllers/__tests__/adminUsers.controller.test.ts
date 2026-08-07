import { AdminUsersController } from '@controllers/adminUsers.controller';
import { Buyer } from '@models/buyer.model';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

/**
 * Regression coverage for the admin Users directory: email-only buyers carry an
 * `email` but no `phone`. The listing was built phone-only (select + search),
 * so those signups came back with no contact identifier and were unfindable by
 * email — they looked "missing" in the dashboard even though the row rendered.
 */
const mockRes = () => {
  const res: any = { req: { originalUrl: '/api/tickets/admin/users' } };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const listBody = async (query: Record<string, string> = {}) => {
  const req: any = { query };
  const res = mockRes();
  await AdminUsersController.listUsers(req, res);
  expect(res.status).toHaveBeenCalledWith(200);
  return res.json.mock.calls[0][0].data;
};

describe('AdminUsersController.listUsers', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns email-only buyers with their email and a null phone', async () => {
    await Buyer.create({
      email: 'emailbuyer@example.com',
      password: 'secret6',
      emailVerifiedAt: new Date(),
      name: 'Email Buyer',
    });

    const { users } = await listBody();

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      name: 'Email Buyer',
      phone: null,
      email: 'emailbuyer@example.com',
    });
  });

  it('finds an email-only buyer when searching by (part of) their email', async () => {
    await Buyer.create({
      email: 'teyise.dlamini@gmail.com',
      password: 'secret6',
      emailVerifiedAt: new Date(),
      name: 'Teyise Dlamini',
    });
    await Buyer.create({
      phone: '+26878422613',
      password: 'secret6',
      phoneVerifiedAt: new Date(),
      name: 'Phone Person',
    });

    const { users } = await listBody({ search: 'teyise.dlamini' });

    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('teyise.dlamini@gmail.com');
  });

  it('still returns phone-only (legacy) buyers with a null email', async () => {
    await Buyer.create({
      phone: '+26878422613',
      password: 'secret6',
      phoneVerifiedAt: new Date(),
      name: 'Legacy Phone',
    });

    const { users } = await listBody();

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      name: 'Legacy Phone',
      phone: '+26878422613',
      email: null,
    });
  });
});
