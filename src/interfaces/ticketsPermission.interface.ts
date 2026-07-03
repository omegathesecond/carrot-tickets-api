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
  // list of registered buyers + signup analytics. Granted to OWNER automatically
  // (Object.values below) and to super-admins in middleware; never handed to
  // MANAGER/SALES/SCANNER by default — it must be assigned explicitly.
  VIEW_USERS = 'tickets:view_users'
}

export enum TicketsRole {
  OWNER = 'tickets_owner',
  MANAGER = 'tickets_manager',
  SALES = 'tickets_sales',
  SCANNER = 'tickets_scanner'
}

export const TICKETS_ROLE_PERMISSIONS: Record<TicketsRole, TicketsPermission[]> = {
  [TicketsRole.OWNER]: Object.values(TicketsPermission),

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
