import { Router } from 'express';
import { authenticateBuyer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { UpdateController } from '@controllers/update.controller';

const router = Router();

router.post('/', authenticateBuyer, UpdateController.create);
router.post('/:id/finalize', authenticateBuyer, UpdateController.finalize);
router.get('/:id', optionalTicketsAuth, UpdateController.getOne);
router.post('/:id/like', authenticateBuyer, UpdateController.react('like'));
router.post('/:id/save', authenticateBuyer, UpdateController.react('save'));
router.post('/:id/share', UpdateController.share);
router.delete('/:id', authenticateBuyer, UpdateController.remove);

export default router;
