import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { VendorDmController } from '@controllers/vendorDm.controller';

// Brand (organizer) DM endpoints — the vendor counterpart to dm.route.ts.
// Mounted at /api/tickets/dm (see src/app.ts), before the broad /api/tickets.
const router = Router();

router.post('/threads', authenticateTickets, VendorDmController.openThread);
router.get('/threads', authenticateTickets, VendorDmController.listThreads);
router.get('/threads/:threadId/messages', authenticateTickets, VendorDmController.listMessages);
router.post('/threads/:threadId/messages', authenticateTickets, VendorDmController.sendMessage);
router.post('/threads/:threadId/read', authenticateTickets, VendorDmController.markRead);

export default router;
