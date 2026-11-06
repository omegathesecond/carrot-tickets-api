import { Router } from 'express';
import { VenueController } from '@controllers/venue.controller';
import { MerchantAdminController } from '@controllers/merchantAdmin.controller';
import { MerchantOperatorAdminController } from '@controllers/merchantOperatorAdmin.controller';
import { StockAdminController } from '@controllers/stockAdmin.controller';
import { StockReportController } from '@controllers/stockReport.controller';
import { WaiterAdminController } from '@controllers/waiterAdmin.controller';
import { VenueTablesController } from '@controllers/venueTables.controller';
import { VenuePaymentsController } from '@controllers/venuePayments.controller';
import { requireAnyPermission, requireTicketsPermission } from '@middleware/ticketsAuth.middleware';
import { venueScope } from '@middleware/tradingScope.middleware';
import { asyncHandler } from '@utils/controllerHelpers.util';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

/**
 * Venue trading — the signed-in vendor's OWN venue (venue trading spec).
 * Mounted at /api/tickets/venue AFTER dualAuth. No id in any URL: venueScope
 * resolves the venue from the vendor, so another venue cannot be addressed.
 * The handlers are the same ones the event routes use.
 */
const router = Router();
const { MANAGE_VENUE, MANAGE_STOCK, VIEW_REVENUE } = TicketsPermission;

// The vendor's venue (or null) and whether the Venue section applies — auth only.
router.get('/', VenueController.mine);

router.get('/stalls', requireAnyPermission([MANAGE_VENUE, MANAGE_STOCK]), venueScope, MerchantAdminController.list);
router.post('/stalls', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantAdminController.create);
router.patch('/stalls/:id', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantAdminController.update);
router.get('/stalls/:id/transactions', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantAdminController.transactions);
router.get('/stalls/:merchantId/operators', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantOperatorAdminController.list);
router.post('/stalls/:merchantId/operators', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantOperatorAdminController.create);
router.patch('/operators/:id', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantOperatorAdminController.update);
router.post('/operators/:id/reset-pin', requireTicketsPermission(MANAGE_VENUE), venueScope, MerchantOperatorAdminController.resetPin);

// Waiters (venue Phase 3): the same admin handlers the event side uses.
router.get('/waiters', requireTicketsPermission(MANAGE_VENUE), venueScope, WaiterAdminController.list);
router.post('/waiters', requireTicketsPermission(MANAGE_VENUE), venueScope, WaiterAdminController.create);
router.patch('/waiters/:id', requireTicketsPermission(MANAGE_VENUE), venueScope, WaiterAdminController.update);
router.post('/waiters/:id/reset-pin', requireTicketsPermission(MANAGE_VENUE), venueScope, WaiterAdminController.resetPin);

// The floor (venue Phase 3). Viewing is for revenue viewers and venue admins;
// closing a walkout is a venue admin's.
router.get('/tables', requireAnyPermission([VIEW_REVENUE, MANAGE_VENUE]), venueScope, asyncHandler(VenueTablesController.list));
router.get('/tables/:id', requireAnyPermission([VIEW_REVENUE, MANAGE_VENUE]), venueScope, asyncHandler(VenueTablesController.detail));
router.post('/tables/:id/void', requireTicketsPermission(MANAGE_VENUE), venueScope, asyncHandler(VenueTablesController.void));

// Transactions (venue Phase 3): every payment the venue took. Read-only.
router.get('/payments', requireTicketsPermission(VIEW_REVENUE), venueScope, asyncHandler(VenuePaymentsController.list));
router.get('/payments/:id', requireTicketsPermission(VIEW_REVENUE), venueScope, asyncHandler(VenuePaymentsController.detail));

router.get('/products', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.listProducts);
router.post('/products', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.createProduct);
router.patch('/products/:id', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.updateProduct);
router.post('/stock/receive', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.receiveStock);
router.patch('/stock/threshold', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.setThreshold);
router.post('/stock/transfer', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.transferStock);
router.post('/stock/count', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.recordCount);
router.get('/stock/allocations', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.listAllocations);
router.put('/stock/allocations', requireTicketsPermission(MANAGE_STOCK), venueScope, StockAdminController.setAllocations);

router.get('/stock/board', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.board);
router.get('/stock/reconciliation', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.reconciliation);
router.get('/stock/reconciliation.pdf', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.reconciliationPdf);
router.get('/stock/dashboard', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.dashboard);
router.get('/stock/movements', requireTicketsPermission(VIEW_REVENUE), venueScope, StockReportController.movements);

export default router;
