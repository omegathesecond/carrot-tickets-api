import { ResellerRole, RESELLER_ROLE_PERMISSIONS, ResellerPermission } from '@interfaces/resellerPermission.interface';

it('operator can sell but cannot manage operators', () => {
  const perms = RESELLER_ROLE_PERMISSIONS[ResellerRole.OPERATOR];
  expect(perms).toContain(ResellerPermission.SELL_TICKETS);
  expect(perms).not.toContain(ResellerPermission.MANAGE_OPERATORS);
});

it('admin can manage hubs and operators and view hub sales', () => {
  const perms = RESELLER_ROLE_PERMISSIONS[ResellerRole.ADMIN];
  expect(perms).toEqual(expect.arrayContaining([
    ResellerPermission.MANAGE_HUB, ResellerPermission.MANAGE_OPERATORS, ResellerPermission.VIEW_HUB_SALES,
  ]));
});
