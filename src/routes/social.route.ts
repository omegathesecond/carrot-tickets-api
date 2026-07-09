import { Router } from 'express';
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';
import { SocialProfileController } from '@controllers/socialProfile.controller';

const router = Router();

router.get('/me', authenticateBuyer, SocialProfileController.me);
router.patch('/me', authenticateBuyer, SocialProfileController.update);
router.get('/username-available', authenticateBuyer, SocialProfileController.usernameAvailable);
router.get('/users/:username', authenticateBuyer, SocialProfileController.publicProfile);

export default router;
