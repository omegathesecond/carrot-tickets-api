// api/src/routes/merchant.route.ts
import { Router } from 'express';
import { MerchantController } from '@controllers/merchant.controller';
import { authenticateMerchant, requireMerchantPermission } from '@middleware/merchantAuth.middleware';
import { MerchantPermission } from '@interfaces/merchant.interface';

const router = Router();

/** All routes below require a valid merchant JWT (POST /api/operator/login → type:'merchant'). */
router.use(authenticateMerchant);

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

export default router;
