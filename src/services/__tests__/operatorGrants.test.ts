import {
  OperatorGrant,
  sanitizeGrants,
  grantedTicketsPermissions,
  grantedCashierPermissions,
} from '@interfaces/operatorGrant.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { CashierPermission, CASHIER_PERMISSIONS } from '@interfaces/cashier.interface';
import { TICKETS_ROLE_PERMISSIONS, TicketsRole } from '@interfaces/ticketsPermission.interface';

/**
 * Grants are per-person extras on top of a role's fixed set. The filtering
 * matters more than the mapping: this is the path by which a value on an
 * operator row becomes a permission in a signed token.
 */
describe('operator grants', () => {
  it('translates a grant into each namespace', () => {
    expect(grantedTicketsPermissions([OperatorGrant.ISSUE_TAGS])).toEqual([
      TicketsPermission.ISSUE_TAGS,
    ]);
    expect(grantedCashierPermissions([OperatorGrant.ISSUE_TAGS])).toEqual([
      CashierPermission.ISSUE_TAGS,
    ]);
  });

  it('drops values that are not grants, so a stale row cannot widen a token', () => {
    const rogue = ['issue_tags', 'tickets:manage_stock', 'admin', ''];
    expect(grantedTicketsPermissions(rogue)).toEqual([TicketsPermission.ISSUE_TAGS]);
    expect(grantedCashierPermissions(rogue)).toEqual([CashierPermission.ISSUE_TAGS]);
  });

  it('treats a missing or empty grants list as no extras', () => {
    expect(grantedTicketsPermissions(undefined)).toEqual([]);
    expect(grantedTicketsPermissions(null)).toEqual([]);
    expect(grantedCashierPermissions([])).toEqual([]);
  });

  describe('sanitizeGrants', () => {
    it('keeps known grants and drops the rest', () => {
      expect(sanitizeGrants(['issue_tags', 'tickets:manage_stock'])).toEqual([OperatorGrant.ISSUE_TAGS]);
    });

    it('de-duplicates', () => {
      expect(sanitizeGrants(['issue_tags', 'issue_tags'])).toEqual([OperatorGrant.ISSUE_TAGS]);
    });

    it('returns nothing for a non-array', () => {
      expect(sanitizeGrants('issue_tags')).toEqual([]);
      expect(sanitizeGrants(undefined)).toEqual([]);
      expect(sanitizeGrants({ 0: 'issue_tags' })).toEqual([]);
    });
  });

  describe('the clean break from scan_tickets', () => {
    it('leaves tag issuing out of the scanner role, so it must be granted', () => {
      expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SCANNER]).not.toContain(
        TicketsPermission.ISSUE_TAGS,
      );
    });

    it('leaves it out of the default cashier set too', () => {
      expect(CASHIER_PERMISSIONS).not.toContain(CashierPermission.ISSUE_TAGS);
    });

    it('still gives an owner every non-platform permission, tag issuing included', () => {
      expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.ISSUE_TAGS);
    });
  });
});
