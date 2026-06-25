import { Router } from 'express';
import { CardController } from '@controllers/card.controller';

const router = Router();

/**
 * Peach card payment webhook (unauthenticated — Peach pushes here).
 * Always returns 200 to prevent Peach retry storms.
 * @route POST /api/public/purchase/card/webhook
 */
router.post('/webhook', CardController.webhook);

export default router;
