import { Router } from 'express';
import { PublicController } from '@controllers/public.controller';

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

export default router;
