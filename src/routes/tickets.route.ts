import { Router } from 'express';
import { TicketsController } from '@controllers/tickets.controller';
import {
  authenticateTickets,
  requireTicketsPermission,
  requireSuperAdmin,
  requireSuperAdminOrPermission,
} from '@middleware/ticketsAuth.middleware';
import { dualAuth } from '@middleware/serviceAuth.middleware';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { SettingsController } from '@controllers/settings.controller';
import { GateOperatorAdminController } from '@controllers/gateOperatorAdmin.controller';
import { AdminUsersController } from '@controllers/adminUsers.controller';
import { AdminOrganizersController } from '@controllers/adminOrganizers.controller';
import { WristbandController } from '@controllers/wristband.controller';
import { OrganizerProfileController } from '@controllers/organizerProfile.controller';
import { ReviewController } from '@controllers/review.controller';
import { AnnouncementController } from '@controllers/announcement.controller';
import { ChannelAdminController } from '@controllers/channelAdmin.controller';
import { ModerationController } from '@controllers/moderation.controller';
import { ReportController } from '@controllers/report.controller';

const router = Router();

/**
 * Authentication Routes
 * Public routes - no authentication required
 */
router.post('/auth/login', TicketsController.login);
router.post('/auth/register', TicketsController.register);
router.post('/auth/refresh', TicketsController.refresh);
// Social SSO handoff: mint (dashboard, authed) → exchange (social site, public).
router.post('/auth/handoff', authenticateTickets, TicketsController.socialHandoff);
router.post('/auth/handoff/exchange', TicketsController.socialHandoffExchange);

/**
 * Authenticated Routes
 * All routes below require authentication via either:
 * - JWT token (Authorization header) for dashboard access
 * - Service key (x-service-key header) for proxied app requests from main Keshless API
 */
router.use(dualAuth);

/**
 * Admin-only settings routes (super admin only)
 */
router.get('/settings/payment-methods', requireSuperAdmin, SettingsController.getPaymentMethods);
router.put('/settings/payment-methods', requireSuperAdmin, SettingsController.updatePaymentMethods);

/**
 * Platform Users admin — registered-buyer directory + signup analytics.
 * Carrot super-admins or team members holding tickets:view_users. Buyers are
 * platform-wide, so this is intentionally NOT vendor-scoped.
 */
router.get(
  '/admin/users',
  requireSuperAdminOrPermission(TicketsPermission.VIEW_USERS),
  AdminUsersController.listUsers,
);
router.get(
  '/admin/users/analytics',
  requireSuperAdminOrPermission(TicketsPermission.VIEW_USERS),
  AdminUsersController.analytics,
);

/**
 * Organizers admin — vendor directory + verification lifecycle behind the
 * dashboard "Organizers" tab. Super-admin only.
 */
router.get('/admin/organizers', requireSuperAdmin, AdminOrganizersController.listOrganizers);
router.patch('/admin/organizers/:id/verification', requireSuperAdmin, AdminOrganizersController.updateVerification);

/**
 * Wristband printing — platform staff only (Carrot office printer + Tyvek
 * stock). Super-admins or team members holding tickets:print_wristbands.
 * Intentionally NOT vendor-scoped, mirroring /admin/users.
 */
router.get('/wristband-designs', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.listDesigns);
router.post('/wristband-designs', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.createDesign);
router.put('/wristband-designs/:id', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.updateDesign);
router.delete('/wristband-designs/:id', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.deleteDesign);

/**
 * Wristband batch issuance — zero-amount, real, scannable tickets minted
 * from the office printer run. Same platform-staff-only gate as above.
 */
router.post('/wristbands/batch-issue', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.batchIssue);
router.get('/wristbands/batches', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.listBatches);
router.get('/wristbands/tickets', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.searchTickets);

/**
 * Social moderation queue — buyer-filed reports against messages/buyers.
 * Super-admins or team members holding tickets:moderate_social. Intentionally
 * NOT vendor-scoped, mirroring /admin/users and the wristband routes above.
 */
router.get('/reports', requireSuperAdminOrPermission(TicketsPermission.MODERATE_SOCIAL), ReportController.list);
router.post(
  '/reports/:reportId/resolve',
  requireSuperAdminOrPermission(TicketsPermission.MODERATE_SOCIAL),
  ReportController.resolve
);

// Auth management
router.post('/auth/logout', TicketsController.logout);
router.get('/auth/me', TicketsController.getMe);

/**
 * End-customer ticket list — the Keshless user-app calls this to show
 * a logged-in user every ticket bought with their phone number.
 * Mounted before the vendor-scoped /events block so the path resolves
 * cleanly. Auth is the existing dualAuth: when the main keshless-api
 * proxy forwards a Keshless user JWT, serviceAuth attaches userPhone
 * to req.ticketsUser; when called directly with a vendor JWT, the
 * lookup will see no phone and 401.
 */
router.get('/my-tickets', TicketsController.getMyTickets);

/**
 * In-app ticket purchase for a logged-in Keshless user (card + PIN payment).
 * Driven by the main keshless-api proxy with the shared service key; the buyer
 * phone comes from the forwarded x-user-phone. Same flow + cost as the web
 * buyer checkout (/api/public/purchase) — both call purchaseForCustomer.
 */
router.post('/purchase', TicketsController.purchaseAsUser);

/**
 * User Account Settings Routes
 */
router.put('/users/profile', TicketsController.updateProfile);
router.put('/users/password', TicketsController.changePassword);

/**
 * Organizer own-profile — vendor sets its own public brand card (logo + bio)
 * consumed by the public organizer profile and organizer-branded chat.
 */
router.patch(
  '/organizer/profile',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  OrganizerProfileController.updateOwn
);

/**
 * Event Management Routes
 */
router.get(
  '/events',
  requireTicketsPermission(TicketsPermission.VIEW_EVENTS),
  TicketsController.getEvents
);

router.get(
  '/events/:eventId',
  requireTicketsPermission(TicketsPermission.VIEW_EVENTS),
  TicketsController.getEvent
);

router.get(
  '/events/:eventId/creator',
  requireTicketsPermission(TicketsPermission.VIEW_EVENTS),
  TicketsController.getEventCreator
);

router.post(
  '/events',
  requireTicketsPermission(TicketsPermission.CREATE_EVENT),
  TicketsController.createEvent
);

router.put(
  '/events/:eventId',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.updateEvent
);

router.delete(
  '/events/:eventId',
  requireTicketsPermission(TicketsPermission.DELETE_EVENT),
  TicketsController.deleteEvent
);

router.put(
  '/events/:eventId/publish',
  requireTicketsPermission(TicketsPermission.PUBLISH_EVENT),
  TicketsController.publishEvent
);

router.put(
  '/events/:eventId/unpublish',
  requireTicketsPermission(TicketsPermission.PUBLISH_EVENT),
  TicketsController.unpublishEvent
);

/**
 * Organizer announcements — post into the event's #announcements channel.
 * dualAuth (router-level) already authenticated the request; this route only
 * needs the permission gate. Ownership (own events only) is checked in the
 * controller, matching the reviews reply pattern below.
 */
router.post(
  '/events/:eventId/announcements',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  AnnouncementController.post
);

/**
 * Organizer channel management — list/create/patch the text channels inside
 * an event's community. Same auth shape as announcements: dualAuth
 * (router-level) authenticates, the permission gate is here, and ownership
 * (own events only) is checked in the controller.
 */
router.get(
  '/events/:eventId/channels',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ChannelAdminController.list
);

router.post(
  '/events/:eventId/channels',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ChannelAdminController.create
);

router.patch(
  '/channels/:channelId',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ChannelAdminController.update
);

/**
 * Organizer moderation — delete-any-message, mute/ban members, pinned
 * messages, and the admin member roster. Same auth shape as channel
 * management: dualAuth (router-level) authenticates, the permission gate is
 * here, and ownership (own events only, community -> event -> vendorId) is
 * checked in the controller.
 */
router.delete(
  '/messages/:messageId',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.deleteMessage
);

router.post(
  '/messages/:messageId/pin',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.pin
);

router.delete(
  '/messages/:messageId/pin',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.unpin
);

router.get(
  '/communities/:communityId/members',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.listMembers
);

router.post(
  '/communities/:communityId/members/:buyerId/mute',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.mute
);

router.delete(
  '/communities/:communityId/members/:buyerId/mute',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.unmute
);

router.post(
  '/communities/:communityId/members/:buyerId/ban',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.ban
);

router.delete(
  '/communities/:communityId/members/:buyerId/ban',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.unban
);

/**
 * Ticket Type Management Routes
 */
router.post(
  '/events/:eventId/tickets',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.addTicketType
);

router.put(
  '/events/:eventId/tickets/:ticketTypeName',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.updateTicketType
);

router.delete(
  '/events/:eventId/tickets/:ticketTypeName',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.deleteTicketType
);

router.patch(
  '/events/:eventId/tickets/:ticketTypeName/adjust',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.adjustTicketQuantity
);

router.patch(
  '/events/:eventId/tickets/:ticketTypeName/sold-out',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.markTicketSoldOut
);

/**
 * Review Management Routes — vendor reply to a buyer's post-event review.
 * dualAuth (router-level) already authenticated the request; this route only
 * needs the permission gate.
 */
router.post(
  '/reviews/:reviewId/reply',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ReviewController.reply
);

/**
 * Ticket Sales Routes
 */
router.post(
  '/sales/sell',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketsController.sellTickets
);

router.get(
  '/sales',
  requireTicketsPermission(TicketsPermission.VIEW_SALES),
  TicketsController.getSales
);

router.get(
  '/sales/:saleId',
  requireTicketsPermission(TicketsPermission.VIEW_SALES),
  TicketsController.getSale
);

router.post(
  '/sales/:ticketId/refund',
  requireTicketsPermission(TicketsPermission.REFUND_TICKET),
  TicketsController.refundTicket
);

/**
 * Entry Scanning Routes
 */
router.post(
  '/scans/validate',
  requireTicketsPermission(TicketsPermission.SCAN_TICKETS),
  TicketsController.validateTicket
);

router.post(
  '/scans/check-in',
  requireTicketsPermission(TicketsPermission.SCAN_TICKETS),
  TicketsController.checkInTicket
);

router.get(
  '/scans/stats',
  requireTicketsPermission(TicketsPermission.VIEW_SCANS),
  TicketsController.getScanStats
);

router.get(
  '/scans',
  requireTicketsPermission(TicketsPermission.VIEW_SCANS),
  TicketsController.getScans
);

/**
 * Analytics & Statistics Routes
 */
router.get(
  '/stats/dashboard',
  requireTicketsPermission(TicketsPermission.VIEW_STATS),
  TicketsController.getDashboardStats
);

router.get(
  '/stats/sales',
  requireTicketsPermission(TicketsPermission.VIEW_STATS),
  TicketsController.getSalesStats
);

router.get(
  '/stats/revenue',
  requireTicketsPermission(TicketsPermission.VIEW_REVENUE),
  TicketsController.getRevenueStats
);

router.get(
  '/stats/events/:eventId',
  requireTicketsPermission(TicketsPermission.VIEW_STATS),
  TicketsController.getEventAnalytics
);

/**
 * Export Routes
 */
router.get(
  '/export/sales',
  requireTicketsPermission(TicketsPermission.EXPORT_REPORTS),
  TicketsController.exportSales
);

router.get(
  '/export/revenue',
  requireTicketsPermission(TicketsPermission.EXPORT_REPORTS),
  TicketsController.exportRevenue
);

router.get(
  '/export/events/:eventId/summary',
  requireTicketsPermission(TicketsPermission.EXPORT_REPORTS),
  TicketsController.exportEventSummary
);

/**
 * Gate Operator Admin Routes
 */
router.get('/gate-operators', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.list);
router.post('/gate-operators', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.create);
router.patch('/gate-operators/:id', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.update);
router.post('/gate-operators/:id/reset-pin', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.resetPin);

export default router;
