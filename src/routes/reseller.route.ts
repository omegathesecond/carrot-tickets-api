import { Router } from 'express';
import { ResellerController } from '@controllers/reseller.controller';
import { authenticateReseller, requireResellerPermission } from '@middleware/resellerAuth.middleware';
import { ResellerPermission } from '@interfaces/resellerPermission.interface';

const router = Router();

/**
 * Authentication — public (no auth required)
 */
router.post('/auth/login', ResellerController.login);

/**
 * All routes below require a valid reseller JWT.
 */
router.use(authenticateReseller);

/**
 * Events
 */
router.get(
  '/events',
  requireResellerPermission(ResellerPermission.VIEW_EVENTS),
  ResellerController.getEvents
);

router.get(
  '/events/:id/tickets',
  requireResellerPermission(ResellerPermission.VIEW_EVENTS),
  ResellerController.getEventTickets
);

/**
 * Payment Methods
 */
router.get('/payment-methods', ResellerController.getPaymentMethods);

/**
 * Sales
 */
router.post(
  '/sales',
  requireResellerPermission(ResellerPermission.SELL_TICKETS),
  ResellerController.createSale
);

router.post(
  '/sales/:referenceId/finalize',
  requireResellerPermission(ResellerPermission.SELL_TICKETS),
  ResellerController.finalizeSale
);

router.get(
  '/sales',
  requireResellerPermission(ResellerPermission.VIEW_OWN_SALES),
  ResellerController.getSales
);

export default router;
