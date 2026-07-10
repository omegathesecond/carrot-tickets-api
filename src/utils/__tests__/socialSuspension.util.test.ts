import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { assertNotSuspended } from '@utils/socialSuspension.util';

describe('assertNotSuspended', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('is a no-op for a buyer with no socialSuspendedAt', async () => {
    const buyer = await Buyer.create({ phone: '+26878000001', password: 'secret1' });
    expect(() => assertNotSuspended(buyer)).not.toThrow();
  });

  it('throws 403 "Your community access is suspended" for a suspended buyer', async () => {
    const buyer = await Buyer.create({
      phone: '+26878000002',
      password: 'secret1',
      socialSuspendedAt: new Date(),
    });
    expect(() => assertNotSuspended(buyer)).toThrow(
      expect.objectContaining({ statusCode: 403, message: 'Your community access is suspended' })
    );
  });
});
