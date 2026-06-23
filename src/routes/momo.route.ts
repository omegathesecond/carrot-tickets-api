import { Router } from 'express';
import { MomoController } from '@controllers/momo.controller';

const router = Router();

/**
 * MTN MoMo callback routes (unauthenticated — MTN pushes here).
 * Always returns 200 to prevent MTN retry storms.
 * @route PUT /api/momo/callback
 * @route POST /api/momo/callback
 */
router.put('/callback', MomoController.callback);
router.post('/callback', MomoController.callback);

export default router;
