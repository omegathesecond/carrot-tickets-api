import { Router } from 'express';
import { authenticatePlanParticipant, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { EventPlanController } from '@controllers/eventPlan.controller';
import { EventPlanMessageController } from '@controllers/eventPlanMessage.controller';
import { EventPlanCommentController } from '@controllers/eventPlanComment.controller';

const router = Router();

// Fixed-segment routes MUST be registered before '/:id' so they aren't
// captured as a plan id — same convention as social.route.ts's '/users/search'.
router.get('/participant', authenticatePlanParticipant, EventPlanController.participant);
router.get('/mine', authenticatePlanParticipant, EventPlanController.mine);
router.get('/event/:eventId', optionalTicketsAuth, EventPlanController.listForEvent);
router.post('/', authenticatePlanParticipant, requireProfilePhoto, EventPlanController.create);

router.post('/invites/:memberId/accept', authenticatePlanParticipant, EventPlanController.acceptInvite);
router.post('/invites/:memberId/decline', authenticatePlanParticipant, EventPlanController.declineInvite);
router.post('/requests/:memberId/approve', authenticatePlanParticipant, EventPlanController.approveRequest);
router.post('/requests/:memberId/decline', authenticatePlanParticipant, EventPlanController.declineRequest);

// Comment thread on a Public Event Plan (social engagement) — 'plan-comments'
// is a two-segment path ('/plan-comments/:commentId[/like]'), so its order
// relative to the single-segment '/:id' routes below is not load-bearing,
// same as update.route.ts's '/comments/:commentId'.
router.post('/plan-comments/:commentId/like', authenticatePlanParticipant, EventPlanCommentController.like);
router.delete('/plan-comments/:commentId', authenticatePlanParticipant, EventPlanCommentController.remove);

router.get('/:id', optionalTicketsAuth, EventPlanController.detail);
router.get('/:id/pending', authenticatePlanParticipant, EventPlanController.pending);
router.patch('/:id', authenticatePlanParticipant, EventPlanController.update);
router.patch('/:id/visibility', authenticatePlanParticipant, EventPlanController.changeVisibility);
// Cover photo (Home-feed card + detail header) — presign/finalize mirrors
// Posts' upload flow; admin-only since it's part of the plan's presentation.
router.post('/:id/cover/presign', authenticatePlanParticipant, EventPlanController.presignCover);
router.post('/:id/cover/finalize', authenticatePlanParticipant, EventPlanController.finalizeCover);
router.delete('/:id/cover', authenticatePlanParticipant, EventPlanController.removeCover);
router.post('/:id/cancel', authenticatePlanParticipant, EventPlanController.cancel);
router.post('/:id/join', authenticatePlanParticipant, requireProfilePhoto, EventPlanController.join);
router.post('/:id/leave', authenticatePlanParticipant, EventPlanController.leave);
router.post('/:id/invite', authenticatePlanParticipant, requireProfilePhoto, EventPlanController.invite);
router.post('/:id/invite/:memberId/cancel', authenticatePlanParticipant, EventPlanController.cancelInvite);
router.post('/:id/members/:memberId/remove', authenticatePlanParticipant, EventPlanController.removeMember);
router.post('/:id/attendance', authenticatePlanParticipant, EventPlanController.vote);

router.get('/:id/messages', optionalTicketsAuth, EventPlanMessageController.list);
router.post('/:id/messages', authenticatePlanParticipant, requireProfilePhoto, EventPlanMessageController.send);
router.patch('/:id/messages/:messageId', authenticatePlanParticipant, EventPlanMessageController.editCaption);
router.delete('/:id/messages/:messageId', authenticatePlanParticipant, EventPlanMessageController.remove);
router.post('/:id/messages/:messageId/react', authenticatePlanParticipant, EventPlanMessageController.react);
router.delete('/:id/messages/:messageId/react', authenticatePlanParticipant, EventPlanMessageController.unreact);
router.post('/:id/read', authenticatePlanParticipant, EventPlanMessageController.markRead);

// Photo/video Posts (spec §6) — two-step create: presign here, upload
// client-side, then finalize triggers processing (mirrors update.route.ts).
router.post('/:id/posts', authenticatePlanParticipant, requireProfilePhoto, EventPlanMessageController.createPost);
router.post('/:id/posts/:messageId/finalize', authenticatePlanParticipant, EventPlanMessageController.finalizePost);

// Social engagement (Public plans only) — like/comment/share/save, same
// interaction model as a normal Update post. Unlike the conversation above,
// these do NOT require plan membership; EventPlanService/eventPlanComment.service
// enforce visibility==='public' internally.
router.post('/:id/like', authenticatePlanParticipant, requireProfilePhoto, EventPlanController.react('like'));
router.post('/:id/save', authenticatePlanParticipant, EventPlanController.react('save'));
router.post('/:id/share', EventPlanController.share);
router.get('/:id/comments', optionalTicketsAuth, EventPlanCommentController.list);
router.post('/:id/comments', authenticatePlanParticipant, requireProfilePhoto, EventPlanCommentController.create);

export default router;
