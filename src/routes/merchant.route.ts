// api/src/routes/merchant.route.ts
import { Router } from 'express';
import { MerchantController } from '@controllers/merchant.controller';
import { VenueTillController } from '@controllers/venueTill.controller';
import { authenticateMerchant, requireMerchantPermission } from '@middleware/merchantAuth.middleware';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { asyncHandler } from '@utils/controllerHelpers.util';

const router = Router();

/** All routes below require a valid merchant JWT (POST /api/operator/login → type:'merchant'). */
router.use(authenticateMerchant);
router.get('/balance', requireMerchantPermission(MerchantPermission.CHARGE), MerchantController.balance);
router.post('/transactions/:id/reverse', requireMerchantPermission(MerchantPermission.CHARGE), MerchantController.reverse);

router.post('/quote', requireMerchantPermission(MerchantPermission.CHARGE), MerchantController.quote);

router.post(
  '/charge',
  requireMerchantPermission(MerchantPermission.CHARGE),
  MerchantController.charge,
);

router.get(
  '/transactions',
  requireMerchantPermission(MerchantPermission.CHARGE),
  MerchantController.listTransactions,
);

router.get(
  '/stock',
  requireMerchantPermission(MerchantPermission.CHARGE),
  MerchantController.stock,
);

router.post(
  '/stock/count',
  requireMerchantPermission(MerchantPermission.CHARGE),
  MerchantController.recordCount,
);

// CHARGE, not MANAGE_STOCK: handing a paid round over the counter is the
// selling job — the same person on the same till — not stock administration.
router.get(
  '/tables',
  requireMerchantPermission(MerchantPermission.CHARGE),
  MerchantController.tables,
);

router.post(
  '/tables/:id/hand-out',
  requireMerchantPermission(MerchantPermission.CHARGE),
  MerchantController.handOutTable,
);

// Venue tills: the rounds waiters send this stall (event tills use /tables above).
router.get('/orders', requireMerchantPermission(MerchantPermission.CHARGE), asyncHandler(VenueTillController.orders));
router.post('/tables/:tableId/orders/:orderId/hand-out', requireMerchantPermission(MerchantPermission.CHARGE), asyncHandler(VenueTillController.handOut));

// A venue till's counter sale: cash / card, no tag (event tills use /charge).
router.post('/sales', requireMerchantPermission(MerchantPermission.CHARGE), asyncHandler(VenueTillController.sale));

router.get(
  '/stalls',
  requireMerchantPermission(MerchantPermission.MANAGE_STOCK),
  MerchantController.stalls,
);

router.post(
  '/stock/receive',
  requireMerchantPermission(MerchantPermission.MANAGE_STOCK),
  MerchantController.receiveStock,
);

router.post(
  '/stock/waste',
  requireMerchantPermission(MerchantPermission.MANAGE_STOCK),
  MerchantController.wasteStock,
);

router.post(
  '/stock/transfer',
  requireMerchantPermission(MerchantPermission.MANAGE_STOCK),
  MerchantController.transferStock,
);

export default router;
