import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { VendorSocialController } from '@controllers/vendorSocial.controller';

// Vendor (organizer brand) social-graph endpoints. Mounted at
// /api/tickets/social — see src/app.ts, placed before the broader
// /api/tickets mount so these specific paths aren't shadowed.
const router = Router();

router.get('/me', authenticateTickets, VendorSocialController.me);
router.post('/follow', authenticateTickets, VendorSocialController.follow);
router.delete('/follow/:targetType/:targetId', authenticateTickets, VendorSocialController.unfollow);

export default router;
