import { Router } from 'express';
import { YocoController } from '@controllers/yoco.controller';

const router = Router();

/**
 * Yoco webhook (unauthenticated transport — authenticity is the Standard-Webhooks
 * signature over the raw body). This is the ONLY path that can mint a Yoco
 * ticket: Yoco has no status-query endpoint to re-verify against.
 * Returns 401 on a bad signature, 200 otherwise (so Yoco never retry-storms).
 * @route POST /api/public/purchase/yoco/webhook
 */
router.post('/webhook', YocoController.webhook);

/**
 * Yoco successUrl / cancelUrl / failureUrl — the buyer's browser returns here.
 * Reads our own sale record and 302s to the SPA result page. Never finalises.
 * @route GET /api/public/purchase/yoco/return
 */
router.get('/return', YocoController.returnRedirect);

export default router;
