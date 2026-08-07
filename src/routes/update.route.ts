import { Router } from 'express';
import { authenticateBuyer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { UpdateController } from '@controllers/update.controller';
import { UpdateCommentController } from '@controllers/updateComment.controller';

const router = Router();

router.post('/', authenticateBuyer, UpdateController.create);
router.post('/:id/finalize', authenticateBuyer, UpdateController.finalize);

// Comments. Grouped before the bare '/:id' routes for readability — the paths
// differ in segment count ('/comments/:commentId' is two, '/:id' is one), so
// order is not load-bearing here the way it is in community.route.ts.
//
// optionalTicketsAuth (not authenticateBuyer) on the writes: an organizer
// brand comments with a vendor token, and the controller/service resolve the
// actor themselves. A buyer-only guard here would 401 every brand.
router.delete('/comments/:commentId', optionalTicketsAuth, UpdateCommentController.remove);
router.get('/:id/comments', optionalTicketsAuth, UpdateCommentController.list);
router.post('/:id/comments', optionalTicketsAuth, UpdateCommentController.create);

router.get('/:id', optionalTicketsAuth, UpdateController.getOne);
router.post('/:id/like', authenticateBuyer, UpdateController.react('like'));
router.post('/:id/save', authenticateBuyer, UpdateController.react('save'));
router.post('/:id/share', UpdateController.share);
router.post('/:id/view', UpdateController.recordView);
router.delete('/:id', optionalTicketsAuth, UpdateController.remove);

export default router;
