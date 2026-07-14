import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('Vendor.operatorType', () => {
  it('defaults to events', async () => {
    const v = await Vendor.create({ businessName: 'Acme', email: 'a@b.co', password: 'secret1' });
    expect(v.operatorType).toBe(OperatorType.EVENTS);
  });

  it('accepts transport and both', async () => {
    const v = await Vendor.create({ businessName: 'Bus Co', phoneNumber: '+268760000001', password: 'secret1', operatorType: OperatorType.TRANSPORT });
    expect(v.operatorType).toBe('transport');
  });

  it('rejects an invalid operatorType', async () => {
    await expect(
      Vendor.create({ businessName: 'Bad', email: 'x@y.co', password: 'secret1', operatorType: 'aviation' as any }),
    ).rejects.toThrow();
  });
});
