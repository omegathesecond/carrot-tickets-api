import { Router } from 'express';
import { ResellerController } from '@controllers/reseller.controller';
import { ResellerOperatorAdminController } from '@controllers/resellerOperatorAdmin.controller';
import { ResellerHubAdminController } from '@controllers/resellerHubAdmin.controller';
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

/**
 * Hubs (VIEW_HUB_SALES)
 */
router.get('/hubs',
  requireResellerPermission(ResellerPermission.VIEW_HUB_SALES),
  ResellerHubAdminController.list);
router.get('/hubs/:hubId',
  requireResellerPermission(ResellerPermission.VIEW_HUB_SALES),
  ResellerHubAdminController.get);
router.get('/hubs/:hubId/analytics',
  requireResellerPermission(ResellerPermission.VIEW_HUB_SALES),
  ResellerHubAdminController.analytics);

/**
 * Operator management (MANAGE_OPERATORS)
 */
router.get('/operators',
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS),
  ResellerOperatorAdminController.list);
router.post('/operators',
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS),
  ResellerOperatorAdminController.create);
router.post('/operators/:id/reset-pin',
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS),
  ResellerOperatorAdminController.resetPin);
router.patch('/operators/:id',
  requireResellerPermission(ResellerPermission.MANAGE_OPERATORS),
  ResellerOperatorAdminController.update);

export default router;
