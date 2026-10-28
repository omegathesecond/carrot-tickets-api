import { model } from 'mongoose';
import { EventPlanReaction, IEventPlanReaction } from './eventPlanReaction.model';
import { EventPlanComment, IEventPlanComment } from './eventPlanComment.model';
import { EventPlanCommentReaction, IEventPlanCommentReaction } from './eventPlanCommentReaction.model';

// Reuse the engagement shapes while keeping references and records isolated.
const reactionSchema = EventPlanReaction.schema.clone();
reactionSchema.path('planId').options.ref = 'WeekendStatus';
const commentSchema = EventPlanComment.schema.clone();
commentSchema.path('planId').options.ref = 'WeekendStatus';
commentSchema.path('parentId').options.ref = 'WeekendComment';
const commentReactionSchema = EventPlanCommentReaction.schema.clone();
commentReactionSchema.path('commentId').options.ref = 'WeekendComment';
export const WeekendReaction = model<IEventPlanReaction>('WeekendReaction', reactionSchema);
export const WeekendComment = model<IEventPlanComment>('WeekendComment', commentSchema);
export const WeekendCommentReaction = model<IEventPlanCommentReaction>('WeekendCommentReaction', commentReactionSchema);
