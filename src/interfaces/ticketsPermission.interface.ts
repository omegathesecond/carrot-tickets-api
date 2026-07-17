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

  // Transport (bus/shuttle) inventory management
  VIEW_TRANSPORT = 'tickets:view_transport',
  MANAGE_TRANSPORT = 'tickets:manage_transport',

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
  PRINT_WRISTBANDS = 'tickets:print_wristbands',

  // Social moderation queue (Carrot admins/team only) — review buyer-filed
  // reports against messages/buyers, delete-any cross-vendor, and suspend a
  // buyer's platform-wide social access. NEVER part of any role's default
  // set: organizers (OWNER) only moderate their own community, they don't
  // get the platform-wide queue.
  MODERATE_SOCIAL = 'tickets:moderate_social',

  // Brand identity (logo/bio) — deliberately vertical-neutral: a bus
  // company's brand is not an events concept, so this belongs to NEITHER
  // EVENT_PERMISSIONS nor TRANSPORT_PERMISSIONS below. That absence from
  // both groups is what makes scopePermissionsToType never strip it,
  // regardless of OperatorType. Granted only to brand-owner roles
  // (OWNER/MANAGER) — SALES/SCANNER must not overwrite brand identity.
  EDIT_BRAND = 'tickets:edit_brand'
}

export enum TicketsRole {
  OWNER = 'tickets_owner',
  MANAGER = 'tickets_manager',
  SALES = 'tickets_sales',
  SCANNER = 'tickets_scanner'
}

export const TICKETS_ROLE_PERMISSIONS: Record<TicketsRole, TicketsPermission[]> = {
  // Every permission EXCEPT the platform-staff-only ones (VIEW_USERS,
  // PRINT_WRISTBANDS, MODERATE_SOCIAL). An organizer owns their vendor
  // account, not the Carrot platform.
  [TicketsRole.OWNER]: Object.values(TicketsPermission).filter(
    (p) =>
      p !== TicketsPermission.VIEW_USERS &&
      p !== TicketsPermission.PRINT_WRISTBANDS &&
      p !== TicketsPermission.MODERATE_SOCIAL
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
    TicketsPermission.VIEW_TRANSPORT,
    TicketsPermission.MANAGE_TRANSPORT,
    TicketsPermission.VIEW_REVENUE,
    TicketsPermission.EXPORT_REPORTS,
    TicketsPermission.EDIT_BRAND
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

// ── Operator-type verticals ────────────────────────────────────────────────
// These three groups PARTITION all non-platform-staff, non-vertical-neutral
// permissions (disjoint + exhaustive). Two categories of permission are
// deliberately excluded from all three groups because scopePermissionsToType
// only strips membership in a group — absence from every group is what makes
// a permission survive scoping for EVERY OperatorType:
//   - platform-staff perms (VIEW_USERS, PRINT_WRISTBANDS, MODERATE_SOCIAL) —
//     belong to no vertical, never part of any role's default set.
//   - EDIT_BRAND — brand identity is not an events-or-transport concept, so
//     it must survive scoping for EVENTS, TRANSPORT, and BOTH alike; IS part
//     of the brand-owner roles' (OWNER/MANAGER) default set.
export const TRANSPORT_PERMISSIONS: TicketsPermission[] = [
  TicketsPermission.VIEW_TRANSPORT,
  TicketsPermission.MANAGE_TRANSPORT,
];

// Cross-cutting — granted to every type. Empty in v1 (no cross-vertical
// dashboard surface exists yet; analytics/sales/refund views are event-shaped).
export const SHARED_PERMISSIONS: TicketsPermission[] = [];

export const EVENT_PERMISSIONS: TicketsPermission[] = [
  TicketsPermission.CREATE_EVENT,
  TicketsPermission.EDIT_EVENT,
  TicketsPermission.DELETE_EVENT,
  TicketsPermission.VIEW_EVENTS,
  TicketsPermission.PUBLISH_EVENT,
  TicketsPermission.SELL_TICKETS,
  TicketsPermission.VIEW_SALES,
  TicketsPermission.REFUND_TICKET,
  TicketsPermission.SCAN_TICKETS,
  TicketsPermission.VIEW_SCANS,
  TicketsPermission.VIEW_STATS,
  TicketsPermission.VIEW_REVENUE,
  TicketsPermission.EXPORT_REPORTS,
  TicketsPermission.MANAGE_ACCESS,
];

export interface TicketsUserToken {
  userId?: string;
  vendorId: string;
  userType: 'vendor' | 'sub-user';
  app: 'tickets';
  role: TicketsRole;
  permissions: TicketsPermission[];
  isSuperAdmin?: boolean;
}
