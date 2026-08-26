import { Types } from 'mongoose';
import { StoryPointsAward } from '@models/storyPointsAward.model';

/** Points for one ready story upload — same rate as a community post (see POINTS_PER_POST in the website's src/lib/points.ts). */
export const STORY_POINTS = 25;
/** Anti-spam: only the first N story uploads per calendar day (UTC) earn points. Uploading beyond that still posts the story — it just stops paying out. */
export const MAX_DAILY_STORY_AWARDS = 3;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Awards points for one buyer's story once its media is actually ready —
 * mirrors postCount's `media.status: 'ready'` rule (see
 * SocialProfileController#me) so a story stuck in 'processing' or one that
 * failed to transcode never pays out. Capped at MAX_DAILY_STORY_AWARDS/day
 * and idempotent per story (unique index on storyId), so a retried finalize
 * call can't double-credit.
 */
export async function awardStoryPointsIfEligible(
  buyerId: Types.ObjectId | string,
  storyId: Types.ObjectId | string,
): Promise<void> {
  const todayCount = await StoryPointsAward.countDocuments({
    buyerId,
    createdAt: { $gte: startOfUtcDay(new Date()) },
  });
  if (todayCount >= MAX_DAILY_STORY_AWARDS) return;

  try {
    await StoryPointsAward.create({ buyerId, storyId, points: STORY_POINTS });
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // already awarded for this story — idempotent no-op
  }
}

/** All-time story points for a buyer — the persisted counterpart to the derived ticket/post totals. */
export async function totalStoryPoints(buyerId: Types.ObjectId | string): Promise<number> {
  const id = typeof buyerId === 'string' ? new Types.ObjectId(buyerId) : buyerId;
  const rows = await StoryPointsAward.aggregate<{ _id: null; total: number }>([
    { $match: { buyerId: id } },
    { $group: { _id: null, total: { $sum: '$points' } } },
  ]);
  return rows[0]?.total ?? 0;
}
