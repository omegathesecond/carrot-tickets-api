import { MerchantPermission } from '@interfaces/merchant.interface';
import {
  OperatorGrant,
  grantedMerchantPermissions,
  grantedTicketsPermissions,
  grantedCashierPermissions,
  sanitizeGrants,
} from '@interfaces/operatorGrant.interface';

describe('manage_stock grant', () => {
  it('translates into the merchant namespace', () => {
    expect(grantedMerchantPermissions([OperatorGrant.MANAGE_STOCK]))
      .toEqual([MerchantPermission.MANAGE_STOCK]);
  });

  it('grants nothing in the tickets or cashier namespaces — stock is stall-scoped', () => {
    expect(grantedTicketsPermissions([OperatorGrant.MANAGE_STOCK])).toEqual([]);
    expect(grantedCashierPermissions([OperatorGrant.MANAGE_STOCK])).toEqual([]);
  });

  it('gives a stall operator nothing for issue_tags', () => {
    expect(grantedMerchantPermissions([OperatorGrant.ISSUE_TAGS])).toEqual([]);
  });

  it('ignores unknown and duplicate values', () => {
    expect(grantedMerchantPermissions(['not_a_grant', OperatorGrant.MANAGE_STOCK]))
      .toEqual([MerchantPermission.MANAGE_STOCK]);
    expect(grantedMerchantPermissions(null)).toEqual([]);
    expect(sanitizeGrants([OperatorGrant.MANAGE_STOCK, OperatorGrant.MANAGE_STOCK]))
      .toEqual([OperatorGrant.MANAGE_STOCK]);
  });
});
