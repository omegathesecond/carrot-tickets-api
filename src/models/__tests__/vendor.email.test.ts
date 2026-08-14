import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('Vendor.email regex', () => {
  const validEmails = [
    'laslie+carrotbiz@hiyebo.com',
    'name@domain.info',
    'a.b-c_d@sub.example.co.uk',
    'x@y.io'
  ];

  it.each(validEmails)('accepts %s', async (email) => {
    const v = await Vendor.create({ businessName: 'Acme', password: 'secret1', email });
    expect(v.email).toBe(email.toLowerCase());
  });

  const invalidEmails = ['notanemail', 'foo@bar', '@nolocal.com', 'has space@email.com'];

  it.each(invalidEmails)('rejects %s', async (email) => {
    await expect(
      Vendor.create({ businessName: 'Acme', password: 'secret1', email })
    ).rejects.toThrow();
  });
});
