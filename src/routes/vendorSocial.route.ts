import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { VendorSocialController } from '@controllers/vendorSocial.controller';
import { VendorConsumerReadsController } from '@controllers/vendorConsumerReads.controller';

// Vendor (organizer brand) social-graph endpoints. Mounted at
// /api/tickets/social — see src/app.ts, placed before the broader
// /api/tickets mount so these specific paths aren't shadowed.
const router = Router();

router.get('/me', authenticateTickets, VendorSocialController.me);
// Brand nearby opt-in — exact path, registered before the '/users/:username'
// param route (which only captures the '/users' prefix, so no conflict).
router.patch('/me/location', authenticateTickets, VendorConsumerReadsController.updateLocation);
router.delete('/me/location', authenticateTickets, VendorConsumerReadsController.deleteLocation);
router.post('/follow', authenticateTickets, VendorSocialController.follow);
router.delete('/follow/:targetType/:targetId', authenticateTickets, VendorSocialController.unfollow);
router.get('/me/following', authenticateTickets, VendorSocialController.following);
router.get('/me/followers', authenticateTickets, VendorSocialController.followers);
// '/users/search' MUST be registered BEFORE '/users/:username' or "search" is captured as a username.
router.get('/users/search', authenticateTickets, VendorSocialController.searchUsers);
router.get('/users/:username', authenticateTickets, VendorSocialController.publicProfile);
router.get('/notifications', authenticateTickets, VendorSocialController.notifications);
router.post('/notifications/read', authenticateTickets, VendorSocialController.markNotificationsRead);
router.post('/block', authenticateTickets, VendorSocialController.blockUser);
router.delete('/block/:userId', authenticateTickets, VendorSocialController.unblockUser);

// Brand "who to follow / what's near me / for you" surfaces — the organizer
// equivalents of the buyer /api/social/{suggestions,recommendations,nearby}.
router.get('/suggestions/people', authenticateTickets, VendorConsumerReadsController.suggestedPeople);
router.get('/suggestions/organizers', authenticateTickets, VendorConsumerReadsController.suggestedOrganizers);
router.get('/recommendations', authenticateTickets, VendorConsumerReadsController.recommendations);
router.get('/nearby/people', authenticateTickets, VendorConsumerReadsController.nearbyPeople);

export default router;
