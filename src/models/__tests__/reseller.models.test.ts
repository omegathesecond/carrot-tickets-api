import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('creates reseller -> hub -> operator with hashed PIN and login code', async () => {
  const r = await Reseller.create({ businessName: 'Pick n Pay', commissionPercent: null });
  expect(r.status).toBe('active');

  const hub = await ResellerHub.create({ resellerId: r._id, name: 'Mbabane Branch' });
  const op = await ResellerOperator.create({
    hubId: hub._id, resellerId: r._id, fullName: 'Till One',
    loginCode: '123456', pin: '654321', role: 'reseller_operator',
  });

  const fetched = await ResellerOperator.findById(op._id).select('+pin');
  expect(fetched!.pin).not.toBe('654321');                 // hashed
  expect(await fetched!.comparePin('654321')).toBe(true);
  expect(await fetched!.comparePin('000000')).toBe(false);
});

it('hides pin from toJSON and enforces unique login code', async () => {
  const r = await Reseller.create({ businessName: 'Spar', commissionPercent: null });
  const hub = await ResellerHub.create({ resellerId: r._id, name: 'CBD' });
  const op = await ResellerOperator.create({
    hubId: hub._id, resellerId: r._id, fullName: 'Till Two',
    loginCode: '222333', pin: '111111', role: 'reseller_operator',
  });
  expect((op.toJSON() as any).pin).toBeUndefined();

  await expect(ResellerOperator.create({
    hubId: hub._id, resellerId: r._id, fullName: 'Dup',
    loginCode: '222333', pin: '999999', role: 'reseller_operator',
  })).rejects.toThrow();
});
