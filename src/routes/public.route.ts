import { Router } from 'express';
import { PublicController } from '@controllers/public.controller';
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';

const router = Router();

/**
 * Public Routes - No authentication required
 * These endpoints allow public access to browse events and purchase tickets
 */

/**
 * @route   GET /api/public/payment-methods
 * @desc    Returns the payment methods the buyer checkout may show.
 *          A method is listed iff its admin toggle is ON and it is configured.
 *          MoMo additionally requires MTN_MOMO_ENABLED=true in the environment.
 *          Cash is excluded — it is a POS/outlet-only method.
 * @access  Public
 */
router.get('/payment-methods', PublicController.getPaymentMethods);

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
 * @route   POST /api/public/auth/login           { phone, password }              -> { requiresRegistration } | { accessToken }
 * @route   POST /api/public/auth/request-otp     { phone }                        -> sends code (new numbers only)
 * @route   POST /api/public/auth/register        { phone, code, password, name? } -> { accessToken }
 * @route   POST /api/public/auth/forgot-password { phone }                        -> sends reset code (existing numbers only)
 * @route   POST /api/public/auth/reset-password  { phone, code, password }        -> { accessToken }
 */
router.post('/auth/login', PublicController.loginBuyer);
router.post('/auth/request-otp', PublicController.requestBuyerRegistrationOtp);
router.post('/auth/register', PublicController.registerBuyer);
router.post('/auth/forgot-password', PublicController.forgotPasswordBuyer);
router.post('/auth/reset-password', PublicController.resetPasswordBuyer);

/**
 * @route   GET /api/public/my-tickets
 * @desc    List the signed-in buyer's tickets (Bearer buyer token)
 * @access  Buyer
 */
router.get('/my-tickets', authenticateBuyer, PublicController.getMyTickets);

/**
 * @route   POST /api/public/contact
 * @desc    Submit a message from the public "Contact Support" form. Stored
 *          durably in ContactMessage; best-effort SMS alert to the support
 *          line. No auth — this is the marketing-site contact form.
 * @access  Public
 * @body    name, email, subject, message
 */
router.post('/contact', PublicController.submitContactMessage);

/**
 * @route   POST /api/public/purchase/momo
 * @desc    Initiate an async MTN MoMo ticket purchase. Phone comes from the
 *          buyer token (req.ticketsUser.userPhone), NOT the body.
 *          Returns { referenceId, saleId, expiresAt } — buyer polls the status
 *          endpoint and approves the payment on their phone.
 * @access  Buyer (Bearer buyer token)
 * @body    eventId, ticketTypeId, quantity, customerName?, momoPhone
 */
router.post('/purchase/momo', authenticateBuyer, PublicController.initiateMomoPurchase);

/**
 * @route   GET /api/public/purchase/momo/:referenceId/status
 * @desc    Poll the status of a pending MTN MoMo payment. Also triggers
 *          finalization (ticket minting) when MTN reports SUCCESSFUL.
 * @access  Buyer (Bearer buyer token)
 */
router.get('/purchase/momo/:referenceId/status', authenticateBuyer, PublicController.getMomoStatus);

/**
 * @route   POST /api/public/purchase/peach-card
 * @desc    Initiate an async Peach card ticket purchase. Phone comes from the
 *          buyer token (req.ticketsUser.userPhone), NOT the body.
 *          Returns { paymentId, redirect, saleId, expiresAt } — buyer is
 *          redirected to Peach's hosted payment page.
 * @access  Buyer (Bearer buyer token)
 * @body    eventId, ticketTypeId, quantity, customerName?
 */
router.post('/purchase/peach-card', authenticateBuyer, PublicController.initiateCardPurchase);

/**
 * @route   GET /api/public/purchase/peach-card/:paymentId/status
 * @desc    Poll the status of a pending Peach card payment. Also triggers
 *          finalization (ticket minting) when Peach reports success.
 * @access  Buyer (Bearer buyer token)
 */
router.get('/purchase/peach-card/:paymentId/status', authenticateBuyer, PublicController.getCardStatus);

export default router;
