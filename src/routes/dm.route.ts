import { Router } from 'express';
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { DmController } from '@controllers/dm.controller';
import { MessageController } from '@controllers/message.controller';

const router = Router();

router.post('/threads', authenticateBuyer, requireProfilePhoto, DmController.openThread);
// Buyer → brand 1:1 (the public organizer page's "Message" button). Deduped
// with any brand-initiated thread via the shared vendorPairKey.
router.post('/brand-threads', authenticateBuyer, requireProfilePhoto, DmController.openBrandThread);
router.get('/threads', authenticateBuyer, DmController.listThreads);
router.get('/threads/:threadId/messages', authenticateBuyer, DmController.listMessages);
router.post('/threads/:threadId/messages', authenticateBuyer, requireProfilePhoto, DmController.sendMessage);
router.post('/threads/:threadId/read', authenticateBuyer, DmController.markRead);
// Same soft-delete handler as channels — deleteOwnMessage branches on container.
router.delete('/messages/:messageId', authenticateBuyer, MessageController.deleteOwn);

export default router;
