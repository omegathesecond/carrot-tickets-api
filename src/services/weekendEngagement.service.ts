import { WeekendStatus } from '@models/weekendStatus.model';
import { WeekendComment, WeekendCommentReaction } from '@models/weekendEngagement.model';
import { WeekendService } from './weekend.service';
import { createPlanCommentService } from './planCommentFactory.service';

export const weekendComments = createPlanCommentService({
  comments: WeekendComment, reactions: WeekendCommentReaction, plans: WeekendStatus,
  assertPlan: (id, actor) => WeekendService.visiblePlan(id, actor?.id ?? null),
});
