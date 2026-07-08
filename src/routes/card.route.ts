import { Router } from 'express';
import express from 'express';
import { CardController } from '@controllers/card.controller';

const router = Router();

/**
 * Peach card payment webhook (unauthenticated — Peach pushes here).
 * Always returns 200 to prevent Peach retry storms.
 * @route POST /api/public/purchase/peach-card/webhook
 */
router.post('/webhook', CardController.webhook);

/**
 * Peach shopperResultUrl — buyer's browser returns here after the hosted card
 * page + 3-D Secure. GET (id in query) and POST (3DS ACS form-submit) both hit
 * this; the POST body is form-urlencoded, so parse it here (global json() misses it).
 * Finalises server-side then 302s to the SPA result page.
 * @route GET|POST /api/public/purchase/peach-card/return
 */
router.get('/return', CardController.returnRedirect);
router.post('/return', express.urlencoded({ extended: false }), CardController.returnRedirect);

export default router;
