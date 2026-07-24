import { Router } from 'express';
import { authenticateBuyer, authenticateCommunityViewer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { CommunityController } from '@controllers/community.controller';
import { MessageController } from '@controllers/message.controller';
import { ReportController } from '@controllers/report.controller';
import { EventQuestionController } from '@controllers/eventQuestion.controller';

const router = Router();

// channel/message/questions routes are registered BEFORE the /:eventId routes
// so the literal 'channels'/'messages'/'reports'/'questions' prefixes can
// never be captured by :eventId. For /questions/:questionId/... this is only
// a consistency choice, not a structural necessity: those paths are 3
// segments long ('questions', :questionId, 'replies'|'like') while every
// /:eventId route below is 1-2 segments, so segment count alone already
// disambiguates them regardless of registration order.
//
// READ routes use authenticateCommunityViewer (buyer OR managing organizer);
// the controllers branch on token type and give an organizer a read-only,
// ownership-gated peek. WRITE routes stay authenticateBuyer, so an organizer
// token structurally can't post, join, mark-read or delete — read-only is
// enforced by routing, not by per-handler role checks.

router.get('/channels/:channelId/messages', authenticateCommunityViewer, MessageController.list);
router.post('/channels/:channelId/messages', authenticateBuyer, MessageController.send);
router.post('/channels/:channelId/read', authenticateBuyer, MessageController.markRead);
router.get('/channels/:channelId/pins', authenticateCommunityViewer, MessageController.listPins);
router.delete('/messages/:messageId', authenticateBuyer, MessageController.deleteOwn);

/**
 * Buyer report filing — a message or another buyer. Admin review lives at
 * GET/POST /api/tickets/reports* (tickets:moderate_social), see tickets.route.ts.
 */
router.post('/reports', authenticateBuyer, ReportController.file);

/**
 * Event Q&A (TopicsPage discussion threads) — questions + replies + likes.
 * optionalTicketsAuth accepts a buyer OR vendor token, or no token at all;
 * the controller resolves the SocialActor and 401s writes itself when one
 * doesn't resolve, so anonymous callers can still GET the thread.
 */
router.post('/questions/:questionId/replies', optionalTicketsAuth, EventQuestionController.reply);
router.post('/questions/:questionId/like', optionalTicketsAuth, EventQuestionController.like);

router.post('/:eventId/join', authenticateBuyer, CommunityController.join);
router.get('/:eventId', authenticateCommunityViewer, CommunityController.getView);
router.post('/:eventId/verify-ticket', authenticateBuyer, CommunityController.reverifyTicket);
router.get('/:eventId/members', authenticateCommunityViewer, CommunityController.listMembers);
router.get('/:eventId/questions', optionalTicketsAuth, EventQuestionController.list);
router.post('/:eventId/questions', optionalTicketsAuth, EventQuestionController.create);

export default router;
