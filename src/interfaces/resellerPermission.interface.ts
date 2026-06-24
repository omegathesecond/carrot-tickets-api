/**
 * Keshless Tickets Reseller Permission System
 *
 * Modular permission system for resellers on the Keshless Tickets POS.
 * Uses 'reseller:' namespace to avoid conflicts with other permission scopes.
 */

export enum ResellerPermission {
  SELL_TICKETS = 'reseller:sell_tickets',
  VIEW_OWN_SALES = 'reseller:view_own_sales',
  VIEW_EVENTS = 'reseller:view_events',
  MANAGE_HUB = 'reseller:manage_hub',
  MANAGE_OPERATORS = 'reseller:manage_operators',
  VIEW_HUB_SALES = 'reseller:view_hub_sales',
  VIEW_REPORTS = 'reseller:view_reports',
  REQUEST_PAYOUT = 'reseller:request_payout',
}

export enum ResellerRole {
  ADMIN = 'reseller_admin',
  HUB_MANAGER = 'reseller_hub_manager',
  OPERATOR = 'reseller_operator',
}

export const RESELLER_ROLE_PERMISSIONS: Record<ResellerRole, ResellerPermission[]> = {
  [ResellerRole.ADMIN]: Object.values(ResellerPermission),

  [ResellerRole.HUB_MANAGER]: [
    ResellerPermission.VIEW_EVENTS,
    ResellerPermission.SELL_TICKETS,
    ResellerPermission.VIEW_OWN_SALES,
    ResellerPermission.VIEW_HUB_SALES,
    ResellerPermission.MANAGE_OPERATORS,
    ResellerPermission.VIEW_REPORTS,
  ],

  [ResellerRole.OPERATOR]: [
    ResellerPermission.VIEW_EVENTS,
    ResellerPermission.SELL_TICKETS,
    ResellerPermission.VIEW_OWN_SALES,
  ],
};

export interface ResellerToken {
  scope: 'reseller';
  resellerId: string;
  hubId: string | null;
  operatorId: string;
  role: ResellerRole;
  permissions: ResellerPermission[];
}
