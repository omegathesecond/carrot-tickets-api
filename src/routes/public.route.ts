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
 * @desc    Purchase tickets using Keshless card
 * @access  Public (requires Keshless card number + PIN for amounts >= E50)
 * @body    eventId, ticketTypeId, quantity, customerName?, customerPhone?, keshlessCardNumber, keshlessPin?
 */
router.post('/purchase', PublicController.purchaseTickets);

/**
 * Buyer (ticket-holder) authentication — phone + SMS one-time code.
 * @route   POST /api/public/auth/request-otp   { phone }
 * @route   POST /api/public/auth/verify-otp    { phone, code }  -> { accessToken }
 */
router.post('/auth/request-otp', PublicController.requestBuyerOtp);
router.post('/auth/verify-otp', PublicController.verifyBuyerOtp);

/**
 * @route   GET /api/public/my-tickets
 * @desc    List the signed-in buyer's tickets (Bearer buyer token)
 * @access  Buyer
 */
router.get('/my-tickets', authenticateBuyer, PublicController.getMyTickets);

export default router;
