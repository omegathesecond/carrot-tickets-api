import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('Vendor — services fields', () => {
  it('persists a services vendor with category and starting price', async () => {
    const v = await Vendor.create({
      businessName: 'Luxe Decor', phoneNumber: '+26876000001', password: 'secret1',
      operatorType: OperatorType.SERVICES, serviceCategory: 'furniture_decor',
      startingPrice: { amountCents: 18000, unit: 'day' },
    });
    expect(v.operatorType).toBe('services');
    expect(v.serviceCategory).toBe('furniture_decor');
    expect(v.startingPrice?.amountCents).toBe(18000);
    expect(v.startingPrice?.unit).toBe('day');
  });

  it('rejects an unknown service category', async () => {
    await expect(Vendor.create({
      businessName: 'X', phoneNumber: '+26876000002', password: 'secret1',
      operatorType: OperatorType.SERVICES, serviceCategory: 'bouncy_castle' as any,
    })).rejects.toThrow();
  });

  it('requires a category when operatorType is services', async () => {
    await expect(Vendor.create({
      businessName: 'NoCat', phoneNumber: '+26876000003', password: 'secret1',
      operatorType: OperatorType.SERVICES,
    })).rejects.toThrow();
  });

  it('rejects a non-integer amountCents', async () => {
    await expect(Vendor.create({
      businessName: 'FloatyCents', phoneNumber: '+26876000004', password: 'secret1',
      operatorType: OperatorType.SERVICES, serviceCategory: 'catering',
      startingPrice: { amountCents: 180.5, unit: 'day' },
    })).rejects.toThrow();
  });
});
