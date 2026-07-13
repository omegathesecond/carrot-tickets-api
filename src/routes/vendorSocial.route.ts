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
router.get('/me/following', authenticateTickets, VendorSocialController.following);
router.get('/me/followers', authenticateTickets, VendorSocialController.followers);
router.get('/users/search', authenticateTickets, VendorSocialController.searchUsers);
router.get('/notifications', authenticateTickets, VendorSocialController.notifications);
router.post('/notifications/read', authenticateTickets, VendorSocialController.markNotificationsRead);

export default router;
