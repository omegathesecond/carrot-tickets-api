import { Router } from 'express';
import { authenticateBuyer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { EventPlanController } from '@controllers/eventPlan.controller';
import { EventPlanMessageController } from '@controllers/eventPlanMessage.controller';
import { EventPlanCommentController } from '@controllers/eventPlanComment.controller';

const router = Router();

// Fixed-segment routes MUST be registered before '/:id' so they aren't
// captured as a plan id — same convention as social.route.ts's '/users/search'.
router.get('/mine', authenticateBuyer, EventPlanController.mine);
router.get('/event/:eventId', optionalTicketsAuth, EventPlanController.listForEvent);
router.post('/', authenticateBuyer, requireProfilePhoto, EventPlanController.create);

router.post('/invites/:memberId/accept', authenticateBuyer, EventPlanController.acceptInvite);
router.post('/invites/:memberId/decline', authenticateBuyer, EventPlanController.declineInvite);
router.post('/requests/:memberId/approve', authenticateBuyer, EventPlanController.approveRequest);
router.post('/requests/:memberId/decline', authenticateBuyer, EventPlanController.declineRequest);

// Comment thread on a Public Event Plan (social engagement) — 'plan-comments'
// is a two-segment path ('/plan-comments/:commentId[/like]'), so its order
// relative to the single-segment '/:id' routes below is not load-bearing,
// same as update.route.ts's '/comments/:commentId'.
router.post('/plan-comments/:commentId/like', authenticateBuyer, EventPlanCommentController.like);
router.delete('/plan-comments/:commentId', authenticateBuyer, EventPlanCommentController.remove);

router.get('/:id', optionalTicketsAuth, EventPlanController.detail);
router.get('/:id/pending', authenticateBuyer, EventPlanController.pending);
router.patch('/:id', authenticateBuyer, EventPlanController.update);
router.patch('/:id/visibility', authenticateBuyer, EventPlanController.changeVisibility);
router.post('/:id/cancel', authenticateBuyer, EventPlanController.cancel);
router.post('/:id/join', authenticateBuyer, requireProfilePhoto, EventPlanController.join);
router.post('/:id/leave', authenticateBuyer, EventPlanController.leave);
router.post('/:id/invite', authenticateBuyer, requireProfilePhoto, EventPlanController.invite);
router.post('/:id/invite/:memberId/cancel', authenticateBuyer, EventPlanController.cancelInvite);
router.post('/:id/members/:memberId/remove', authenticateBuyer, EventPlanController.removeMember);
router.post('/:id/attendance', authenticateBuyer, EventPlanController.vote);

router.get('/:id/messages', optionalTicketsAuth, EventPlanMessageController.list);
router.post('/:id/messages', authenticateBuyer, requireProfilePhoto, EventPlanMessageController.send);
router.patch('/:id/messages/:messageId', authenticateBuyer, EventPlanMessageController.editCaption);
router.delete('/:id/messages/:messageId', authenticateBuyer, EventPlanMessageController.remove);
router.post('/:id/messages/:messageId/react', authenticateBuyer, EventPlanMessageController.react);
router.delete('/:id/messages/:messageId/react', authenticateBuyer, EventPlanMessageController.unreact);
router.post('/:id/read', authenticateBuyer, EventPlanMessageController.markRead);

// Photo/video Posts (spec §6) — two-step create: presign here, upload
// client-side, then finalize triggers processing (mirrors update.route.ts).
router.post('/:id/posts', authenticateBuyer, requireProfilePhoto, EventPlanMessageController.createPost);
router.post('/:id/posts/:messageId/finalize', authenticateBuyer, EventPlanMessageController.finalizePost);

// Social engagement (Public plans only) — like/comment/share/save, same
// interaction model as a normal Update post. Unlike the conversation above,
// these do NOT require plan membership; EventPlanService/eventPlanComment.service
// enforce visibility==='public' internally.
router.post('/:id/like', authenticateBuyer, requireProfilePhoto, EventPlanController.react('like'));
router.post('/:id/save', authenticateBuyer, EventPlanController.react('save'));
router.post('/:id/share', EventPlanController.share);
router.get('/:id/comments', optionalTicketsAuth, EventPlanCommentController.list);
router.post('/:id/comments', authenticateBuyer, requireProfilePhoto, EventPlanCommentController.create);

export default router;
