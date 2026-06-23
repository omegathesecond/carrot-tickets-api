import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('creates reseller -> hub -> operator with hashed password', async () => {
  const r = await Reseller.create({ businessName: 'Pick n Pay', commissionPercent: null });
  expect(r.status).toBe('active');
  expect(r.commissionPercent).toBeNull();

  const hub = await ResellerHub.create({ resellerId: r._id, name: 'Mbabane Branch' });
  const op = await ResellerOperator.create({
    hubId: hub._id, resellerId: r._id, fullName: 'Till One',
    phoneNumber: '+26878000000', password: 'secret123', role: 'reseller_operator',
  });
  const fetched = await ResellerOperator.findById(op._id).select('+password');
  expect(fetched!.password).not.toBe('secret123');         // hashed
  expect(await fetched!.comparePassword('secret123')).toBe(true);
});
