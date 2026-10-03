import { Router } from 'express';
import { VenueController } from '@controllers/venue.controller';
import { MerchantAdminController } from '@controllers/merchantAdmin.controller';
import { MerchantOperatorAdminController } from '@controllers/merchantOperatorAdmin.controller';
import { StockAdminController } from '@controllers/stockAdmin.controller';
import { StockReportController } from '@controllers/stockReport.controller';
import { requireAnyPermission, requireTicketsPermission } from '@middleware/ticketsAuth.middleware';
import { venueScope } from '@middleware/tradingScope.middleware';
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
