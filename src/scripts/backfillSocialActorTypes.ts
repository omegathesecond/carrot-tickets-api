/**
 * One-time, idempotent backfill of `Follow.followerType`,
 * `UpdateReaction.actorType`, and `Notification.recipientType` for docs
 * written before those discriminators existed.
 *
 * WHY this is needed: all three fields were added to their schemas with
 * `default: 'buyer'`, but Mongoose defaults apply ONLY at document-insert
 * time — they are never retroactively applied to rows already in the
 * collection. Existing prod rows have NO `followerType` / `actorType` /
 * `recipientType` field at all, so the new read code (which queries e.g.
 * `{ followerType: 'buyer', ... }` or `{ recipientType: 'buyer', ... }`)
 * silently fails to match them. Concretely, without this backfill:
 *   - follow counts/lists and the feed "following" tab undercount for
 *     pre-migration buyers
 *   - `FollowService.unfollow` silently no-ops against legacy rows
 *   - re-follow/re-like can create duplicate rows (legacy null-keyed row
 *     doesn't collide with the new 'buyer'-keyed unique index)
 *   - `toggleReaction` / `getViewerReactions` misbehave for updates a buyer
 *     already liked before the migration
 *   - pre-migration `Notification` rows vanish from the buyer inbox, since
 *     the new reads query `{ recipientType: 'buyer', ... }`
 *
 * This backfill MUST run BEFORE the new follow/reaction/notification code
 * is deployed. It is additive and idempotent (matches only docs missing the
 * field, so re-running is a no-op), and it is safe to run against the OLD
 * code too — it only sets a field the old code never reads.
 */
import mongoose from 'mongoose';
import { Follow } from '@models/follow.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Notification } from '@models/notification.model';

export async function backfillSocialActorTypes(): Promise<{
  follows: number; reactions: number; notifications: number;
}> {
  const follows = await Follow.updateMany(
    { followerType: { $exists: false } },
    { $set: { followerType: 'buyer' } },
  );
  const reactions = await UpdateReaction.updateMany(
    { actorType: { $exists: false } },
    { $set: { actorType: 'buyer' } },
  );
  const notifications = await Notification.updateMany(
    { recipientType: { $exists: false } },
    { $set: { recipientType: 'buyer' } },
  );

  return {
    follows: follows.modifiedCount,
    reactions: reactions.modifiedCount,
    notifications: notifications.modifiedCount,
  };
}

// Allow running directly: `ts-node -r tsconfig-paths/register src/scripts/backfillSocialActorTypes.ts`
if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    const counts = await backfillSocialActorTypes();
    console.log('[backfillSocialActorTypes] done:', counts);
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillSocialActorTypes] failed:', err);
    process.exit(1);
  });
}
