import { Router } from 'express';
import { DeltapayController } from '@controllers/deltapay.controller';

const router = Router();

/**
 * DeltaPay session callback (unauthenticated — DeltaPay pushes here).
 * Body is `{ checkout_session_id }` only; the outcome is re-verified server-side.
 * Always returns 200 to prevent retry storms.
 * @route POST /api/public/purchase/deltapay/callback
 */
router.post('/callback', DeltapayController.callback);

/**
 * DeltaPay return_url — the buyer's browser returns here after the hosted
 * checkout page. Finalises server-side then 302s to the SPA result page.
 * @route GET /api/public/purchase/deltapay/return
 */
router.get('/return', DeltapayController.returnRedirect);

export default router;
