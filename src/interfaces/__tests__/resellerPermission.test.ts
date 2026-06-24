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

it('grants reports to manager and admin, payout to admin only', () => {
  expect(RESELLER_ROLE_PERMISSIONS[ResellerRole.OPERATOR]).not.toContain(ResellerPermission.VIEW_REPORTS);
  expect(RESELLER_ROLE_PERMISSIONS[ResellerRole.HUB_MANAGER]).toContain(ResellerPermission.VIEW_REPORTS);
  expect(RESELLER_ROLE_PERMISSIONS[ResellerRole.HUB_MANAGER]).not.toContain(ResellerPermission.REQUEST_PAYOUT);
  expect(RESELLER_ROLE_PERMISSIONS[ResellerRole.ADMIN]).toContain(ResellerPermission.VIEW_REPORTS);
  expect(RESELLER_ROLE_PERMISSIONS[ResellerRole.ADMIN]).toContain(ResellerPermission.REQUEST_PAYOUT);
});
