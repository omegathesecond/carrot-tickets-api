import { Router } from 'express';
import { TicketsController } from '@controllers/tickets.controller';
import {
  requireTicketsPermission
} from '@middleware/ticketsAuth.middleware';
import { dualAuth } from '@middleware/serviceAuth.middleware';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const router = Router();

/**
 * Authentication Routes
 * Public routes - no authentication required
 */
router.post('/auth/login', TicketsController.login);
router.post('/auth/register', TicketsController.register);
router.post('/auth/refresh', TicketsController.refresh);

/**
 * Authenticated Routes
 * All routes below require authentication via either:
 * - JWT token (Authorization header) for dashboard access
 * - Service key (x-service-key header) for proxied app requests from main Keshless API
 */
router.use(dualAuth);

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

export default router;
