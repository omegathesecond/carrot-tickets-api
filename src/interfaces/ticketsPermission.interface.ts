/**
 * Keshless Tickets Permission System
 *
 * Modular permission system for Keshless Tickets event management.
 * Uses 'tickets:' namespace to avoid conflicts with other apps.
 */

export enum TicketsPermission {
  // Event Management
  CREATE_EVENT = 'tickets:create_event',
  EDIT_EVENT = 'tickets:edit_event',
  DELETE_EVENT = 'tickets:delete_event',
  VIEW_EVENTS = 'tickets:view_events',
  PUBLISH_EVENT = 'tickets:publish_event',

  // Ticket Sales
  SELL_TICKETS = 'tickets:sell_tickets',
  VIEW_SALES = 'tickets:view_sales',
  REFUND_TICKET = 'tickets:refund_ticket',

  // Entry Scanning
  SCAN_TICKETS = 'tickets:scan_tickets',
  VIEW_SCANS = 'tickets:view_scans',

  // Analytics & Reports
  VIEW_STATS = 'tickets:view_stats',
  VIEW_REVENUE = 'tickets:view_revenue',
  EXPORT_REPORTS = 'tickets:export_reports',

  // Access Management
  MANAGE_ACCESS = 'tickets:manage_access',

  // Platform User Management (Carrot admins/team only) — see the platform-wide
  // list of registered buyers + signup analytics. Super-admins pass via
  // middleware; everyone else needs this assigned explicitly. NEVER part of any
  // role's default set — organizers (OWNER) must not see other events' buyers.
  VIEW_USERS = 'tickets:view_users',

  // Wristband printing (Carrot admins/team only) — design + print Tyvek
  // wristbands from the dashboard and batch-issue zero-amount tickets for
  // scannable wristbands. NEVER part of any role's default set.
  PRINT_WRISTBANDS = 'tickets:print_wristbands'
}

export enum TicketsRole {
  OWNER = 'tickets_owner',
  MANAGER = 'tickets_manager',
  SALES = 'tickets_sales',
  SCANNER = 'tickets_scanner'
}

export const TICKETS_ROLE_PERMISSIONS: Record<TicketsRole, TicketsPermission[]> = {
  // Every permission EXCEPT the platform-staff-only ones (VIEW_USERS,
  // PRINT_WRISTBANDS). An organizer owns their vendor account, not the
  // Carrot platform.
  [TicketsRole.OWNER]: Object.values(TicketsPermission).filter(
    (p) => p !== TicketsPermission.VIEW_USERS && p !== TicketsPermission.PRINT_WRISTBANDS
  ),

  [TicketsRole.MANAGER]: [
    TicketsPermission.CREATE_EVENT,
    TicketsPermission.EDIT_EVENT,
    TicketsPermission.VIEW_EVENTS,
    TicketsPermission.PUBLISH_EVENT,
    TicketsPermission.SELL_TICKETS,
    TicketsPermission.VIEW_SALES,
    TicketsPermission.REFUND_TICKET,
    TicketsPermission.SCAN_TICKETS,
    TicketsPermission.VIEW_SCANS,
    TicketsPermission.VIEW_STATS,
    TicketsPermission.VIEW_REVENUE,
    TicketsPermission.EXPORT_REPORTS
  ],

  [TicketsRole.SALES]: [
    TicketsPermission.VIEW_EVENTS,
    TicketsPermission.SELL_TICKETS,
    TicketsPermission.VIEW_SALES,
    TicketsPermission.VIEW_STATS
  ],

  [TicketsRole.SCANNER]: [
    TicketsPermission.VIEW_EVENTS,
    TicketsPermission.SCAN_TICKETS,
    TicketsPermission.VIEW_SCANS
  ]
};

export interface TicketsUserToken {
  userId?: string;
  vendorId: string;
  userType: 'vendor' | 'sub-user';
  app: 'tickets';
  role: TicketsRole;
  permissions: TicketsPermission[];
  isSuperAdmin?: boolean;
}
