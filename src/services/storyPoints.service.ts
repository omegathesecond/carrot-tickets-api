import { Types } from 'mongoose';
import { StoryPointsAward } from '@models/storyPointsAward.model';
import { StoryPointsDailyCounter } from '@models/storyPointsDailyCounter.model';

/** Points for one ready story upload — same rate as a community post (see POINTS_PER_POST in the website's src/lib/points.ts). */
export const STORY_POINTS = 25;
/** Anti-spam: only the first N story uploads per calendar day (UTC) earn points. Uploading beyond that still posts the story — it just stops paying out. */
export const MAX_DAILY_STORY_AWARDS = 3;

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Atomically claims one of today's MAX_DAILY_STORY_AWARDS slots for a buyer.
 * A single findOneAndUpdate with a `count: { $lt: MAX }` filter is what makes
 * this race-proof: Mongo serializes concurrent writes to the same document,
 * so two callers racing for the last slot can't both see `count` below the
 * cap and both increment past it — the way a separate countDocuments() read
 * followed by a create() could.
 *
 * The doc is ensured to exist first via a $setOnInsert-only upsert (no
 * increment there), so the claim itself never has to upsert — an upsert
 * combined with $inc can double-create the counter under a fresh-day race.
 */
async function tryClaimDailySlot(buyerId: Types.ObjectId | string, day: string): Promise<boolean> {
  try {
    await StoryPointsDailyCounter.updateOne(
      { buyerId, day },
      { $setOnInsert: { buyerId, day, count: 0 } },
      { upsert: true },
    );
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // lost the upsert race — another caller created it first, which is fine
  }

  const claimed = await StoryPointsDailyCounter.findOneAndUpdate(
    { buyerId, day, count: { $lt: MAX_DAILY_STORY_AWARDS } },
    { $inc: { count: 1 } },
  );
  return claimed !== null;
}

async function releaseDailySlot(buyerId: Types.ObjectId | string, day: string): Promise<void> {
  await StoryPointsDailyCounter.updateOne({ buyerId, day }, { $inc: { count: -1 } });
}

/**
 * Awards points for one buyer's story once its media is actually ready —
 * mirrors postCount's `media.status: 'ready'` rule (see
 * SocialProfileController#me) so a story stuck in 'processing' or one that
 * failed to transcode never pays out. Capped at MAX_DAILY_STORY_AWARDS/day,
 * enforced atomically via the day-counter claim above, and idempotent per
 * story (unique index on storyId) — a retried finalize call for a story
 * that already has an award releases the slot it claimed and no-ops.
 */
export async function awardStoryPointsIfEligible(
  buyerId: Types.ObjectId | string,
  storyId: Types.ObjectId | string,
): Promise<void> {
  const day = utcDayKey(new Date());
  const claimed = await tryClaimDailySlot(buyerId, day);
  if (!claimed) return;

  try {
    await StoryPointsAward.create({ buyerId, storyId, points: STORY_POINTS });
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // already awarded for this story — idempotent no-op
    await releaseDailySlot(buyerId, day);
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
