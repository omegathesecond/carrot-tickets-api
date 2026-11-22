import { Types } from 'mongoose';
import { Update } from '@models/update.model';
import { Follow, type FollowTargetType } from '@models/follow.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { hydrate } from '@services/activityFeed/hydrate';
import { BlockService } from '@services/block.service';
import type { ActivityCandidate } from '@services/activityFeed/types';
import type { SocialActor } from '@utils/socialActor.util';

const actorKind = (type: SocialActor['type']) => type === 'vendor' ? 'organizer' as const : 'buyer' as const;

/** Activity cards are real Updates, sharing the existing post actions and counters.
 * A source's unique identity makes repeated follow requests safe to repair/retry.
 * Missing profile photos produce text-only cards. DB failures throw.
 */
async function publish(candidate: ActivityCandidate, actor: SocialActor,
  targetType: 'buyer' | 'vendor' | 'update', targetId: string, subjectId: string) {
  if (actor.id === subjectId || await BlockService.isBlockedEitherWay(actor.id, subjectId)) return;
  const [item] = await hydrate([candidate]);
  const name = item?.actor.username || item?.actor.name;
  if (!item?.target?.name || !name) return;
  const source = { type: candidate.type, id: new Types.ObjectId(candidate.sourceId),
    targetType, targetId: new Types.ObjectId(targetId), subjectId: new Types.ObjectId(subjectId) };
  const caption = candidate.type === 'follow'
    ? `${name} now follows ${item.target.name}.`
    : `${name} liked ${item.target.name}’s post.`;
  await Update.updateOne({ 'activitySource.type': source.type, 'activitySource.id': source.id }, {
    $setOnInsert: { authorType: actor.type, authorId: actor.id, activitySource: source,
      kind: 'image', caption, createdAt: candidate.sortAt, updatedAt: candidate.sortAt,
      media: item.target.imageUrl ? [{ rawKey: decodeURIComponent(new URL(item.target.imageUrl).pathname.slice(1)), status: 'ready',
        image: { url: item.target.imageUrl, width: 0, height: 0 } }] : [] },
  }, { upsert: true, runValidators: true, timestamps: false });
}

export async function publishFollowActivity(actor: SocialActor, targetType: FollowTargetType, targetId: string) {
  const edge = await Follow.findOne({ followerType: actor.type, followerId: actor.id, targetType, targetId }).lean();
  if (!edge) return;
  await publish({ type: 'follow', sourceId: String(edge._id), sortAt: edge.createdAt,
    actor: { kind: actorKind(actor.type), id: actor.id }, target: { kind: targetType, id: targetId } },
    actor, targetType === 'organizer' ? 'vendor' : 'buyer', targetId, targetId);
}

export async function publishLikeActivity(actor: SocialActor, updateId: string) {
  const post = await Update.findOne({ _id: updateId, status: 'active' }).lean();
  // Likes on activity cards still work normally, without recursive activity posts.
  if (!post || post.activitySource?.id) return;
  const reaction = await UpdateReaction.findOne({ updateId, actorType: actor.type, buyerId: actor.id, type: 'like' }).lean();
  if (!reaction) return;
  await publish({ type: 'like_post', sourceId: String(reaction._id), sortAt: reaction.createdAt,
    actor: { kind: actorKind(actor.type), id: actor.id },
    target: { kind: actorKind(post.authorType), id: String(post.authorId) } },
    actor, 'update', updateId, String(post.authorId));
}

export async function removeActivity(actor: SocialActor, type: 'follow' | 'like_post',
  targetType: 'buyer' | 'vendor' | 'update', targetId: string) {
  await Update.updateMany({ authorType: actor.type, authorId: actor.id,
    'activitySource.type': type, 'activitySource.targetType': targetType, 'activitySource.targetId': targetId,
  }, { $set: { status: 'removed' } });
}
