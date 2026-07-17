import { Router } from 'express';
import { authenticateBuyer, authenticateCommunityViewer } from '@middleware/ticketsAuth.middleware';
import { CommunityController } from '@controllers/community.controller';
import { MessageController } from '@controllers/message.controller';
import { ReportController } from '@controllers/report.controller';

const router = Router();

// channel/message routes are registered BEFORE the /:eventId routes so the
// literal 'channels'/'messages'/'reports' prefixes can never be captured by :eventId.
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

router.post('/:eventId/join', authenticateBuyer, CommunityController.join);
router.get('/:eventId', authenticateCommunityViewer, CommunityController.getView);
router.post('/:eventId/verify-ticket', authenticateBuyer, CommunityController.reverifyTicket);
router.get('/:eventId/members', authenticateCommunityViewer, CommunityController.listMembers);

export default router;
