import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { ResellerAuthService } from '@services/resellerAuth.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('logs in an operator and issues a reseller-scoped token', async () => {
  const r = await Reseller.create({ businessName: 'PnP', commissionPercent: null });
  const hub = await ResellerHub.create({ resellerId: r._id, name: 'CBD' });
  await ResellerOperator.create({ hubId: hub._id, resellerId: r._id, fullName: 'Op',
    phoneNumber: '+26878111111', password: 'secret123', role: 'reseller_operator' });

  const { accessToken, operator } = await ResellerAuthService.login('+26878111111', 'secret123');
  expect(operator.role).toBe('reseller_operator');
  const decoded = ResellerAuthService.verifyToken(accessToken);
  expect(decoded.scope).toBe('reseller');
  expect(decoded.resellerId).toBe(r._id.toString());
  expect(decoded.permissions).toContain('reseller:sell_tickets');
});

it('rejects bad credentials', async () => {
  await expect(ResellerAuthService.login('+26878111111', 'wrong')).rejects.toThrow();
});
