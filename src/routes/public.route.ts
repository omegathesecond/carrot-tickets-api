import { Router } from 'express';
import { PublicController } from '@controllers/public.controller';
import { TicketPdfController } from '@controllers/ticketPdf.controller';
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
 * Buyer (ticket-holder) authentication.
 *
 * Returning buyers sign in with phone + password (/auth/login). First-time
 * registration is OTP-gated: /auth/login returns { requiresRegistration: true }
 * for an unknown number, the client requests an SMS code (/auth/request-otp),
 * then creates the account with code + password (/auth/register). This proves
 * phone ownership once, at account creation, then relies on the password.
 * @route   POST /api/public/auth/login        { phone, password }              -> { requiresRegistration } | { accessToken }
 * @route   POST /api/public/auth/request-otp  { phone }                        -> sends code (new numbers only)
 * @route   POST /api/public/auth/register     { phone, code, password, name? } -> { accessToken }
 */
router.post('/auth/login', PublicController.loginBuyer);
router.post('/auth/request-otp', PublicController.requestBuyerRegistrationOtp);
router.post('/auth/register', PublicController.registerBuyer);

/**
 * @route   GET /api/public/my-tickets
 * @desc    List the signed-in buyer's tickets (Bearer buyer token)
 * @access  Buyer
 */
router.get('/my-tickets', authenticateBuyer, PublicController.getMyTickets);

/**
 * @route   GET /api/public/tickets/:ticketId/pdf
 * @desc    Shareable ticket PDF (lazily generated, cached in R2). Same
 *          generator + R2 object the user-app uses — authorised by the buyer's
 *          verified phone matching the ticket.
 * @access  Buyer
 */
router.get('/tickets/:ticketId/pdf', authenticateBuyer, TicketPdfController.getTicketPdf);

export default router;
