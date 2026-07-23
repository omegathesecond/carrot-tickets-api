import { Router } from 'express';
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';
import { SocialProfileController } from '@controllers/socialProfile.controller';
import { ConsumerReadsController } from '@controllers/consumerReads.controller';

const router = Router();

router.get('/me', authenticateBuyer, SocialProfileController.me);
router.get('/me/saved', authenticateBuyer, ConsumerReadsController.mySaved);
router.get('/me/going', authenticateBuyer, ConsumerReadsController.myGoing);
router.get('/me/calendar', authenticateBuyer, ConsumerReadsController.myCalendar);
router.get('/me/following/events', authenticateBuyer, ConsumerReadsController.myFollowingEvents);
router.patch('/me', authenticateBuyer, SocialProfileController.update);
router.get('/me/blocks', authenticateBuyer, SocialProfileController.myBlocks);
router.get('/me/following', authenticateBuyer, SocialProfileController.myFollowing);
router.get('/me/followers', authenticateBuyer, SocialProfileController.myFollowers);
router.get('/me/friends', authenticateBuyer, SocialProfileController.myFriends);
router.get('/notifications', authenticateBuyer, SocialProfileController.myNotifications);
router.post('/notifications/read', authenticateBuyer, SocialProfileController.markNotificationsRead);
router.get('/username-available', authenticateBuyer, SocialProfileController.usernameAvailable);
router.post('/follow', authenticateBuyer, SocialProfileController.followTarget);
router.delete('/follow/:targetType/:targetId', authenticateBuyer, SocialProfileController.unfollowTarget);
router.post('/block', authenticateBuyer, SocialProfileController.blockUser);
router.post('/presence', authenticateBuyer, SocialProfileController.presence);
router.delete('/block/:userId', authenticateBuyer, SocialProfileController.unblockUser);
router.get('/suggestions/people', authenticateBuyer, ConsumerReadsController.suggestedPeople);
// '/users/search' MUST be registered BEFORE '/users/:username' or "search" is captured as a username.
router.get('/users/search', authenticateBuyer, SocialProfileController.searchUsers);
router.get('/users/:username', authenticateBuyer, SocialProfileController.publicProfile);
router.get('/push/vapid-public-key', authenticateBuyer, SocialProfileController.vapidPublicKey);
router.post('/push/subscribe', authenticateBuyer, SocialProfileController.pushSubscribe);
router.delete('/push/subscribe', authenticateBuyer, SocialProfileController.pushUnsubscribe);

export default router;
