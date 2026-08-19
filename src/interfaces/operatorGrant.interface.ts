// api/src/interfaces/operatorGrant.interface.ts
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { CashierPermission } from '@interfaces/cashier.interface';

/**
 * Capabilities an organizer can grant to an INDIVIDUAL operator, on top of
 * whatever their role already carries. Roles stay the floor (a gate operator
 * always scans, a cashier always tops up); grants are the per-person extras,
 * which is what makes this RBAC rather than four fixed job descriptions.
 *
 * Stored namespace-free on the operator row because the same capability means
 * the same thing to a gate operator and a cashier — but the two log in through
 * different middleware with different permission vocabularies, so each auth
 * service translates a grant into its own namespace when minting the token.
 */
export enum OperatorGrant {
  /** Bind a blank tag to an attendee's ticket (the tag desk). */
  ISSUE_TAGS = 'issue_tags',
}

export const OPERATOR_GRANTS: OperatorGrant[] = Object.values(OperatorGrant);

/** Grants → the tickets namespace (gate operators). */
const TICKETS_BY_GRANT: Record<OperatorGrant, TicketsPermission> = {
  [OperatorGrant.ISSUE_TAGS]: TicketsPermission.ISSUE_TAGS,
};

/** Grants → the cashier namespace (cashiers log in through their own middleware). */
const CASHIER_BY_GRANT: Record<OperatorGrant, CashierPermission> = {
  [OperatorGrant.ISSUE_TAGS]: CashierPermission.ISSUE_TAGS,
};

/**
 * Only known grants survive. A row carrying a value that is no longer a grant
 * (renamed capability, hand-edited document) must not widen a token — the
 * filter is here rather than at write time so a stale document can't outlive
 * the validation that let it in.
 */
export function grantedTicketsPermissions(grants?: string[] | null): TicketsPermission[] {
  return (grants ?? [])
    .filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant))
    .map((g) => TICKETS_BY_GRANT[g]);
}

export function grantedCashierPermissions(grants?: string[] | null): CashierPermission[] {
  return (grants ?? [])
    .filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant))
    .map((g) => CASHIER_BY_GRANT[g]);
}

/** Normalize an admin-supplied list: known values only, no duplicates. */
export function sanitizeGrants(input: unknown): OperatorGrant[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant)))];
}
