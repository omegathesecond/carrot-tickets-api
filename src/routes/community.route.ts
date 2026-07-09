import { Router } from 'express';
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';
import { CommunityController } from '@controllers/community.controller';

const router = Router();

// NOTE: channel/message routes (Task 7) are registered BEFORE the /:eventId
// routes so the literal 'channels'/'messages' prefixes can never be captured
// by the :eventId param.

router.post('/:eventId/join', authenticateBuyer, CommunityController.join);
router.get('/:eventId', authenticateBuyer, CommunityController.getView);
router.post('/:eventId/verify-ticket', authenticateBuyer, CommunityController.reverifyTicket);

export default router;
