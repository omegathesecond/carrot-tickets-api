import { Router } from 'express';
import { YeboPayController } from '@controllers/yebopay.controller';

const router = Router();

/**
 * YeboPay webhook (unauthenticated transport — authenticity is the
 * `YeboPay-Signature` HMAC over the raw body).
 * Returns 401 on a bad signature, 200 otherwise (so YeboPay never retry-storms).
 * @route POST /api/public/purchase/yebopay/webhook
 */
router.post('/webhook', YeboPayController.webhook);

/**
 * YeboPay successUrl / cancelUrl — the buyer's browser returns here.
 * Finalises server-side by asking YeboPay (it publishes a status endpoint,
 * unlike Yoco), then 302s to the SPA result page. Reports nothing back.
 * @route GET /api/public/purchase/yebopay/return
 */
router.get('/return', YeboPayController.returnRedirect);

export default router;
