import { EventPlanComment } from '@models/eventPlanComment.model';
import { EventPlanCommentReaction } from '@models/eventPlanCommentReaction.model';
import { EventPlan } from '@models/eventPlan.model';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import { createPlanCommentService } from './planCommentFactory.service';
/** Public plans only — comments (like every other social-engagement action
 *  here) never apply to a Private plan, regardless of the viewer's
 *  membership. Mirrors EventPlanService's own private assertPublicActive. */
async function assertPublicActivePlan(planId: string): Promise<void> {
  if (!HEX24.test(planId)) throw new HttpError(400, 'Invalid plan id');
  const plan = await EventPlan.findById(planId).select('visibility status');
  if (!plan) throw new HttpError(404, 'Plan not found');
  if (plan.visibility !== 'public' || plan.status !== 'active') throw new HttpError(403, 'Only public plans support this');
}


export const { listPlanComments, postPlanComment, reactToPlanComment, deleteOwnPlanComment } = createPlanCommentService({ comments: EventPlanComment, reactions: EventPlanCommentReaction, plans: EventPlan, assertPlan: assertPublicActivePlan });
