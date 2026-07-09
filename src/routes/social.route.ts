import { Router } from 'express';
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';
import { SocialProfileController } from '@controllers/socialProfile.controller';

const router = Router();

router.get('/me', authenticateBuyer, SocialProfileController.me);
router.patch('/me', authenticateBuyer, SocialProfileController.update);
router.get('/me/blocks', authenticateBuyer, SocialProfileController.myBlocks);
router.get('/username-available', authenticateBuyer, SocialProfileController.usernameAvailable);
router.post('/block', authenticateBuyer, SocialProfileController.blockUser);
router.delete('/block/:userId', authenticateBuyer, SocialProfileController.unblockUser);
router.get('/users/:username', authenticateBuyer, SocialProfileController.publicProfile);

export default router;
