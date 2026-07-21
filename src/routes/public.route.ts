import { Router } from 'express';
import { PublicController } from '@controllers/public.controller';
import { BuyerProfileController } from '@controllers/buyerProfile.controller';
import { ReviewController } from '@controllers/review.controller';
import { EventReactionController } from '@controllers/eventReaction.controller';
import { OrganizerProfileController } from '@controllers/organizerProfile.controller';
import { FeedController } from '@controllers/feed.controller';
import { UpdateController } from '@controllers/update.controller';
import { authenticateBuyer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { avatarUpload, handleMulterError, validateFileUpload } from '@middleware/media.middleware';

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
 * @route   GET /api/public/activity
 * @desc    Recent REAL purchase activity across published events for the live
 *          FOMO ticker. Names are masked to "Sipho D."; returns [] when quiet.
 * @access  Public
 * @query   limit (1–30, default 15)
 */
router.get('/activity', PublicController.getActivity);

/**
 * @route   GET /api/public/feed
 * @desc    Discover feed — a blended stream of buyer/organizer updates,
 *          upcoming published events, and real purchase activity. If a
 *          buyer token is present, update slides carry viewerReactions.
 * @access  Public (optional buyer auth)
 * @query   tab (for-you|following|events, default for-you), cursor
 */
router.get('/feed', optionalTicketsAuth, FeedController.get);

/**
 * @route   GET /api/public/updates/by/:authorType/:authorId
 * @desc    An author's own ready updates, newest first (profile grid: the
 *          organizer "Posts" tab and buyer posts). Reached via fallthrough
 *          from the narrower /api/public/updates mount (@routes/update.route
 *          only claims single-segment /:id paths) — see src/app.ts mount
 *          order comments.
 * @access  Public (optional tickets token for viewerReactions)
 * @query   cursor (createdAt ISO string of the last item on the prior page)
 */
router.get('/updates/by/:authorType/:authorId', optionalTicketsAuth, UpdateController.listByAuthor);

/**
 * @route   GET /api/public/updates/for-event/:eventId
 * @desc    Posts tagged to one event, newest first — the Media tab on the
 *          event quick-view (attendees sharing photos/videos from that show).
 * @access  Public (optional tickets token for viewerReactions)
 * @query   cursor (createdAt ISO string of the last item on the prior page)
 */
router.get('/updates/for-event/:eventId', optionalTicketsAuth, UpdateController.listByEvent);

/**
 * @route   GET /api/public/events/:eventId
 * @desc    Get single published event details
 * @access  Public
 */
router.get('/events/:eventId', PublicController.getPublicEvent);

/**
 * @route   GET /api/public/events/:eventId/reviews
 * @desc    Aggregate rating + paginated review list for an event page.
 * @access  Public
 * @query   before, limit
 */
router.get('/events/:eventId/reviews', ReviewController.listForEvent);

/**
 * @route   POST /api/public/events/:eventId/reviews
 * @desc    Submit a verified post-event review. Only ticket holders of an
 *          event that has ended may post, one review per buyer per event.
 * @access  Buyer (Bearer buyer token)
 * @body    rating (1-5), text?
 */
router.post('/events/:eventId/reviews', authenticateBuyer, ReviewController.submit);

/**
 * @route   POST /api/public/events/:eventId/like
 * @desc    Toggle the signed-in actor's like on an event (Discover event slides).
 * @access  Buyer or vendor session required — 401 when anonymous.
 */
router.post('/events/:eventId/like', optionalTicketsAuth, EventReactionController.like);

/**
 * @route   POST /api/public/events/:eventId/share
 * @desc    Record an event share. Anonymous allowed — sharing needs no actor.
 * @access  Public
 */
router.post('/events/:eventId/share', optionalTicketsAuth, EventReactionController.share);

/**
 * @route   GET /api/public/organizers/:vendorId
 * @desc    Public organizer brand page — business card, follower count,
 *          rating aggregate, and upcoming/past event lists. Never exposes
 *          email/phoneNumber/keshlessVendorId.
 * @access  Public
 */
router.get('/organizers/:vendorId', OrganizerProfileController.publicProfile);

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
 * Buyer profile (ticket-holder). Identity is the verified phone on the buyer
 * token; only the profile picture is editable here.
 * @route   GET    /api/public/profile           -> { phone, name, avatarUrl }
 * @route   POST   /api/public/profile/avatar     multipart 'avatar' -> { avatarUrl }
 * @route   DELETE /api/public/profile/avatar     -> { avatarUrl: null }
 * @access  Buyer (Bearer buyer token)
 */
router.get('/profile', authenticateBuyer, BuyerProfileController.getProfile);
router.post(
  '/profile/avatar',
  authenticateBuyer,
  avatarUpload.single('avatar'),
  handleMulterError,
  validateFileUpload,
  BuyerProfileController.uploadAvatar,
);
router.delete('/profile/avatar', authenticateBuyer, BuyerProfileController.deleteAvatar);

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
