import { Router } from 'express';
import { WaiterController } from '@controllers/waiter.controller';
import { VenueWaiterController } from '@controllers/venueWaiter.controller';
import { authenticateWaiter, requireWaiterPermission } from '@middleware/waiterAuth.middleware';
import { byWaiterKind, refuse, NOT_AT_VENUES, VENUE_ONLY } from '@middleware/waiterKind.middleware';
import { WaiterPermission } from '@interfaces/waiter.interface';
import { asyncHandler } from '@utils/controllerHelpers.util';

const router = Router();
router.use(authenticateWaiter);

// A venue waiter reaches the shared URLs too, but each route names the handler
// for each kind (byWaiterKind): the one a kind has no use for refuses it.
const notAtVenues = refuse(NOT_AT_VENUES);
const venueOnly = refuse(VENUE_ONLY);

router.get('/events', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), byWaiterKind(WaiterController.getEvents, notAtVenues));

// A venue waiter has no event list to load: where they work, and what they may
// do right now, come from here.
router.get('/venue', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), byWaiterKind(venueOnly, asyncHandler(VenueWaiterController.venue)));

// VIEW_EVENTS, not MANAGE_TABLES: the event-wide product grid is a read of the
// catalogue, the same class of thing as /events. Nothing on a table moves.
router.get('/products', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), byWaiterKind(WaiterController.getProducts, asyncHandler(VenueWaiterController.getProducts)));

// VIEW_EVENTS, alongside /products: reading what a band holds moves nothing.
// The waiter is who the guest asks "have I got enough on this?", so every
// waiter can answer it, not only one trusted with the money.
router.get('/balance', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), byWaiterKind(WaiterController.balance, notAtVenues));

router.post('/tables', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.openTable, asyncHandler(VenueWaiterController.openTable)));
router.get('/tables', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.listTables, asyncHandler(VenueWaiterController.listTables)));
router.post('/tables/:id/items', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.addItems, notAtVenues));
router.delete('/tables/:id/items/:lineId', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.removeItem, asyncHandler(VenueWaiterController.removeLine)));
// A round: one order per stall, sent to the bar the moment the waiter adds it (venues).
router.post('/tables/:id/orders', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(venueOnly, asyncHandler(VenueWaiterController.sendOrder)));
// The waiter's half of a round's handover: it was handed out at the counter, now they take it (venues).
router.post('/tables/:id/orders/:orderId/accept', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(venueOnly, asyncHandler(VenueWaiterController.acceptOrder)));
router.post('/tables/:id/void', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.voidTable, asyncHandler(VenueWaiterController.cancelTable)));
// Taking delivery of a round is the SERVING job, so it rides on MANAGE_TABLES
// — a waiter barred from the money still has to be able to collect the drinks.
router.post('/tables/:id/stalls/:merchantId/accept', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), byWaiterKind(WaiterController.acceptStall, notAtVenues));
// SETTLE_TABLES, deliberately NOT MANAGE_TABLES: serving a table and taking
// money for it are different jobs, and the money one is a separate per-person
// grant (see WAITER_PERMISSIONS, which omits it).
router.get('/tables/:id/quote', requireWaiterPermission(WaiterPermission.SETTLE_TABLES), byWaiterKind(WaiterController.quoteTable, notAtVenues));
router.post('/tables/:id/settle', requireWaiterPermission(WaiterPermission.SETTLE_TABLES), byWaiterKind(WaiterController.settleTable, notAtVenues));
// Taking money is the settle grant, exactly as at an event — at a venue it is on by default.
router.post('/tables/:id/payments', requireWaiterPermission(WaiterPermission.SETTLE_TABLES), byWaiterKind(venueOnly, asyncHandler(VenueWaiterController.pay)));

export default router;
