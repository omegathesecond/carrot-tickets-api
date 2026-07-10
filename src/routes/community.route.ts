import { Router } from 'express';
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';
import { CommunityController } from '@controllers/community.controller';
import { MessageController } from '@controllers/message.controller';
import { ReportController } from '@controllers/report.controller';

const router = Router();

// channel/message routes are registered BEFORE the /:eventId routes so the
// literal 'channels'/'messages'/'reports' prefixes can never be captured by :eventId.

router.get('/channels/:channelId/messages', authenticateBuyer, MessageController.list);
router.post('/channels/:channelId/messages', authenticateBuyer, MessageController.send);
router.post('/channels/:channelId/read', authenticateBuyer, MessageController.markRead);
router.get('/channels/:channelId/pins', authenticateBuyer, MessageController.listPins);
router.delete('/messages/:messageId', authenticateBuyer, MessageController.deleteOwn);

/**
 * Buyer report filing — a message or another buyer. Admin review lives at
 * GET/POST /api/tickets/reports* (tickets:moderate_social), see tickets.route.ts.
 */
router.post('/reports', authenticateBuyer, ReportController.file);

router.post('/:eventId/join', authenticateBuyer, CommunityController.join);
router.get('/:eventId', authenticateBuyer, CommunityController.getView);
router.post('/:eventId/verify-ticket', authenticateBuyer, CommunityController.reverifyTicket);
router.get('/:eventId/members', authenticateBuyer, CommunityController.listMembers);

export default router;
