// api/src/routes/cashier.route.ts
import { Router } from 'express';
import { CashierController } from '@controllers/cashier.controller';
import { authenticateCashier, requireCashierPermission } from '@middleware/cashierAuth.middleware';
import { CashierPermission } from '@interfaces/cashier.interface';

const router = Router();

/** All routes below require a valid cashier JWT (POST /api/operator/login → type:'cashier'). */
router.use(authenticateCashier);

router.get(
  '/events',
  requireCashierPermission(CashierPermission.VIEW_EVENTS),
  CashierController.getEvents,
);

router.post(
  '/topup',
  requireCashierPermission(CashierPermission.CASH_TOPUP),
  CashierController.topup,
);

router.post(
  '/withdraw',
  requireCashierPermission(CashierPermission.CASH_WITHDRAW),
  CashierController.withdraw,
);

router.get(
  '/balance',
  requireCashierPermission(CashierPermission.VIEW_OWN_TRANSACTIONS),
  CashierController.balance,
);

router.get(
  '/transactions',
  requireCashierPermission(CashierPermission.VIEW_OWN_TRANSACTIONS),
  CashierController.transactions,
);

export default router;
