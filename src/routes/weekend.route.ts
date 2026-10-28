import { createPlanCommentController } from '@controllers/eventPlanComment.controller';
import { weekendComments } from '@services/weekendEngagement.service';
import { WeekendService } from '@services/weekend.service';
import { WeekendStatus } from '@models/weekendStatus.model';
import { WeekendReaction } from '@models/weekendEngagement.model';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { toggleReactionGeneric } from '@services/reactions.service';
import { assertActorNotSuspended } from '@services/socialAuthor.service';
import { Router } from 'express';
import { authenticateBuyer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { WeekendController } from '@controllers/weekend.controller';

const router = Router();

const comments = createPlanCommentController(weekendComments, resolveBuyerFromRequest);
router.get('/cards/:id/comments', optionalTicketsAuth, comments.list);
router.post('/cards/:id/comments', authenticateBuyer, requireProfilePhoto, comments.create);
router.post('/comments/:commentId/like', authenticateBuyer, comments.like);
router.delete('/comments/:commentId', authenticateBuyer, comments.remove);
router.get('/cards/:id', optionalTicketsAuth, async (req, res) => {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    return ApiResponseUtil.success(res, { card: await WeekendService.getCard(String(req.params['id']), buyer ? String(buyer._id) : null) });
  } catch (error) { return failWithHttpError(res, error, 'Could not load plan'); }
});
router.post('/cards/:id/view', optionalTicketsAuth, async (req, res) => {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    const doc = await WeekendService.visiblePlan(String(req.params['id']), buyer ? String(buyer._id) : null);
    const updated = await WeekendStatus.findByIdAndUpdate(doc._id, { $inc: { viewCount: 1 } }, { new: true });
    return ApiResponseUtil.success(res, { viewCount: updated!.viewCount });
  } catch (error) { return failWithHttpError(res, error, 'Could not record view'); }
});
router.post('/cards/:id/like', authenticateBuyer, async (req, res) => {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const actor = { type: 'buyer' as const, id: String(buyer._id) };
    await assertActorNotSuspended(actor);
    const doc = await WeekendService.visiblePlan(String(req.params['id']), actor.id);
    const { active } = await toggleReactionGeneric({ reactionModel: WeekendReaction, targetModel: WeekendStatus,
      targetField: 'planId', targetId: String(doc._id), actor, type: 'like', counterField: 'likeCount' });
    const updated = await WeekendStatus.findById(doc._id);
    return ApiResponseUtil.success(res, { active, likeCount: updated!.likeCount });
  } catch (error) { return failWithHttpError(res, error, 'Could not like plan'); }
});

// Fixed-segment routes before '/users/:username' — same convention as
// social.route.ts's '/users/search'.
router.get('/me', authenticateBuyer, WeekendController.getMine);
router.put('/me', authenticateBuyer, requireProfilePhoto, WeekendController.upsertMine);
router.delete('/me', authenticateBuyer, WeekendController.removeMine);
router.post('/media', authenticateBuyer, requireProfilePhoto, WeekendController.requestMediaUpload);

// "+Add" plan composer (spec: separate from the singular /me status above —
// see weekendStatus.model.ts's class doc comment). '/plans/media' before
// '/plans/:id', same fixed-segment-first convention as '/users/search'.
router.post('/plans/media', authenticateBuyer, requireProfilePhoto, WeekendController.presignPlanMedia);
router.post('/plans', authenticateBuyer, requireProfilePhoto, WeekendController.createPlan);
router.get('/plans/:id', authenticateBuyer, WeekendController.getPlan);
router.put('/plans/:id', authenticateBuyer, requireProfilePhoto, WeekendController.updatePlan);
router.delete('/plans/:id', authenticateBuyer, WeekendController.removePlan);

router.get('/feed', optionalTicketsAuth, WeekendController.feed);
router.get('/feed/all', optionalTicketsAuth, WeekendController.feedAll);
router.get('/feed/looking-for-plans', optionalTicketsAuth, WeekendController.lookingForPlansFeed);

router.post('/requests', authenticateBuyer, requireProfilePhoto, WeekendController.createRequest);
router.get('/requests', authenticateBuyer, WeekendController.listRequests);
router.post('/requests/:id/accept', authenticateBuyer, WeekendController.acceptRequest);
router.post('/requests/:id/decline', authenticateBuyer, WeekendController.declineRequest);
router.delete('/requests/:id', authenticateBuyer, WeekendController.cancelRequest);

router.get('/users/:username/plans', optionalTicketsAuth, WeekendController.profilePlans);
router.get('/users/:username', optionalTicketsAuth, WeekendController.getForUser);

export default router;
