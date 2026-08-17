import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { VendorDmController } from '@controllers/vendorDm.controller';

// Brand (organizer) DM endpoints — the vendor counterpart to dm.route.ts.
// Mounted at /api/tickets/dm (see src/app.ts), before the broad /api/tickets.
const router = Router();

router.post('/threads', authenticateTickets, requireProfilePhoto, VendorDmController.openThread);
// Brand → brand 1:1 (the organizer page's "Message" button, vendor viewer).
router.post('/brand-threads', authenticateTickets, requireProfilePhoto, VendorDmController.openBrandThread);
router.get('/threads', authenticateTickets, VendorDmController.listThreads);
router.get('/threads/:threadId/messages', authenticateTickets, VendorDmController.listMessages);
router.post('/threads/:threadId/messages', authenticateTickets, requireProfilePhoto, VendorDmController.sendMessage);
router.post('/threads/:threadId/read', authenticateTickets, VendorDmController.markRead);

export default router;
