import { ResellerPermission, ResellerRole, RESELLER_ROLE_PERMISSIONS } from '@interfaces/resellerPermission.interface';

it('CASH_TOPUP exists and OPERATOR role has it', () => {
  expect(ResellerPermission.CASH_TOPUP).toBe('reseller:cash_topup');
  expect(RESELLER_ROLE_PERMISSIONS[ResellerRole.OPERATOR]).toContain(ResellerPermission.CASH_TOPUP);
});
