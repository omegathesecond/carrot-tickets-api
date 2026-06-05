import { Router } from 'express';
import { PublicController } from '@controllers/public.controller';
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';

const router = Router();

/**
 * Public Routes - No authentication required
 * These endpoints allow public access to browse events and purchase tickets
 */

/**
 * @route   GET /api/public/events
 * @desc    Get all published events (paginated)
 * @access  Public
 * @query   page, limit, search, startDate, endDate
 */
router.get('/events', PublicController.getPublicEvents);

/**
 * @route   GET /api/public/events/:eventId
 * @desc    Get single published event details
 * @access  Public
 */
router.get('/events/:eventId', PublicController.getPublicEvent);

/**
 * @route   POST /api/public/purchase
 * @desc    Buy tickets using a Keshless card. The buyer must first prove
 *          ownership of their phone via the OTP login below — the ticket is
 *          tied to that VERIFIED phone (taken from the token, never the body),
 *          so it always shows up under "My Tickets" for the same number.
 * @access  Buyer (Bearer buyer token). Keshless card number + PIN for >= E50.
 * @body    eventId, ticketTypeId, quantity, customerName?, keshlessCardNumber, keshlessPin?
 */
router.post('/purchase', authenticateBuyer, PublicController.purchaseTickets);

/**
 * Buyer (ticket-holder) authentication — phone + password (register on first
 * use). No SMS cost. The legacy OTP endpoints remain for backward compat but
 * the frontends now use /auth/login.
 * @route   POST /api/public/auth/login   { phone, password, name? } -> { accessToken }
 * @route   POST /api/public/auth/request-otp   { phone }            (legacy)
 * @route   POST /api/public/auth/verify-otp    { phone, code }      (legacy)
 */
router.post('/auth/login', PublicController.loginBuyer);
router.post('/auth/request-otp', PublicController.requestBuyerOtp);
router.post('/auth/verify-otp', PublicController.verifyBuyerOtp);

/**
 * @route   GET /api/public/my-tickets
 * @desc    List the signed-in buyer's tickets (Bearer buyer token)
 * @access  Buyer
 */
router.get('/my-tickets', authenticateBuyer, PublicController.getMyTickets);

export default router;
