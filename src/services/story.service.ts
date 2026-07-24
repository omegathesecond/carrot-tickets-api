import { Story, IStory } from '@models/story.model';
import { StorySeen } from '@models/storySeen.model';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { updatesR2 } from '@utils/updatesR2';
import { triggerTranscode } from '@services/transcode.client';
import { FollowService } from '@services/follow.service';
import { HttpError } from '@utils/httpError.util';
import type { SocialActor } from '@utils/socialActor.util';
import type { StoryKind } from '@interfaces/story.interface';

const STORY_TTL_MS = 24 * 60 * 60 * 1000;

interface CreateStoryInput {
  actor: SocialActor;
  kind: StoryKind;
  ext: string;
  contentType: string;
}

export async function createStory(input: CreateStoryInput): Promise<{ story: IStory; uploadUrl: string }> {
  const rawKey = updatesR2.rawKey(input.ext);
  const uploadUrl = await updatesR2.presignPut(rawKey, input.contentType);
  const story = await Story.create({
    authorType: input.actor.type,
    authorId: input.actor.id,
    kind: input.kind,
    media: { rawKey, status: 'processing' },
    expiresAt: new Date(Date.now() + STORY_TTL_MS),
  });
  return { story, uploadUrl };
}

/**
 * Mirrors update.service#finalizeUpdate: image finalizes to 'ready'
 * immediately; video kicks off the async transcoder and stays 'processing'
 * until it calls back.
 *
 * CAVEAT: the transcoder microservice (transcoder/src/db.ts +
 * transcoder/src/index.ts) currently writes its result back with
 * `Update.updateOne({_id: updateId}, ...)` hardcoded against the `updates`
 * collection — it has no notion of a `stories` collection yet. Until the
 * transcoder is generalized to accept a target collection, a video Story's
 * media will get stuck in 'processing' rather than transition to 'ready' in
 * a real deployment. Image stories are unaffected (no transcoder involved).
 * Flagged here rather than silently assumed fixed — see stories-api-report.md.
 */
export async function finalizeStory(id: string): Promise<IStory> {
  const story = await Story.findById(id);
  if (!story) throw new HttpError(404, 'Story not found');
  if (story.kind === 'image') {
    story.media.image = { url: updatesR2.publicUrl(story.media.rawKey), width: 0, height: 0 };
    story.media.status = 'ready';
    await story.save();
    return story;
  }
  story.media.processingStartedAt = new Date();
  story.media.status = 'processing';
  await story.save();
  // fire-and-forget, same as finalizeUpdate — no reconcile sweep exists for
  // Stories yet (out of scope for this build; see report).
  triggerTranscode(story).catch((err: any) => console.error('triggerTranscode (story) failed:', err?.message));
  return story;
}

export async function markSeen(storyId: string, actor: SocialActor): Promise<void> {
  const exists = await Story.exists({ _id: storyId });
  if (!exists) throw new HttpError(404, 'Story not found');
  try {
    await StorySeen.create({ storyId, buyerId: actor.id, actorType: actor.type });
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // already seen — idempotent
  }
}

export interface StoryItemDto {
  id: string;
  mediaUrl: string;
  kind: StoryKind;
  durationSec: number | null;
  createdAt: Date;
}

export interface StoryGroupDto {
  author: { type: 'buyer' | 'organizer'; id: string; name: string | null; avatarUrl: string | null };
  items: StoryItemDto[];
  seen: boolean;
  isOwn: boolean;
}

/**
 * Active (unexpired, media-ready) stories from authors the viewer follows,
 * PLUS the viewer's own, grouped by author. Ordering: own group first, then
 * groups with any unseen item, then fully-seen groups; within each bucket,
 * most-recently-posted author first.
 */
export async function listForViewer(actor: SocialActor): Promise<StoryGroupDto[]> {
  // Follow.targetType calls a Vendor author an 'organizer', not 'vendor' —
  // translated here at the boundary (Story.authorType stays 'vendor' below).
  const [followedBuyerIds, followedOrganizerIds] = await Promise.all([
    FollowService.followingIds(actor.id, 'buyer', actor.type),
    FollowService.followingIds(actor.id, 'organizer', actor.type),
  ]);

  const or: Record<string, unknown>[] = [{ authorType: actor.type, authorId: actor.id }]; // own
  if (followedBuyerIds.length) or.push({ authorType: 'buyer', authorId: { $in: followedBuyerIds } });
  if (followedOrganizerIds.length) or.push({ authorType: 'vendor', authorId: { $in: followedOrganizerIds } });

  const stories = await Story.find({
    expiresAt: { $gt: new Date() },
    'media.status': 'ready',
    $or: or,
  }).sort({ createdAt: 1 }); // ascending: items build up chronologically per author below

  if (stories.length === 0) return [];

  const vendorIds = [...new Set(stories.filter((s) => s.authorType === 'vendor').map((s) => String(s.authorId)))];
  const buyerIds = [...new Set(stories.filter((s) => s.authorType === 'buyer').map((s) => String(s.authorId)))];
  const [vendors, buyers, seenRows] = await Promise.all([
    vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl') : [],
    buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : [],
    StorySeen.find({ actorType: actor.type, buyerId: actor.id, storyId: { $in: stories.map((s) => s._id) } }).select('storyId'),
  ]);
  const vMap = new Map(vendors.map((v: any) => [String(v._id), v]));
  const bMap = new Map(buyers.map((b: any) => [String(b._id), b]));
  const seenSet = new Set(seenRows.map((r: any) => String(r.storyId)));

  const groups = new Map<string, StoryGroupDto & { latestCreatedAt: number }>();
  for (const s of stories) {
    const key = `${s.authorType}:${String(s.authorId)}`;
    let group = groups.get(key);
    if (!group) {
      const isOwn = s.authorType === actor.type && String(s.authorId) === String(actor.id);
      const author = s.authorType === 'vendor'
        ? { type: 'organizer' as const, id: String(s.authorId), name: vMap.get(String(s.authorId))?.businessName ?? 'Organizer', avatarUrl: vMap.get(String(s.authorId))?.logoUrl ?? null }
        : { type: 'buyer' as const, id: String(s.authorId), name: bMap.get(String(s.authorId))?.name ?? bMap.get(String(s.authorId))?.username ?? null, avatarUrl: bMap.get(String(s.authorId))?.avatarUrl ?? null };
      group = { author, items: [], seen: true, isOwn, latestCreatedAt: 0 };
      groups.set(key, group);
    }
    const mediaUrl = (s.kind === 'image' ? s.media.image?.url : s.media.video?.url) ?? '';
    group.items.push({
      id: s.id,
      mediaUrl,
      kind: s.kind,
      durationSec: s.media.video?.durationSec ?? null,
      createdAt: s.createdAt,
    });
    group.latestCreatedAt = s.createdAt.getTime();
    if (!seenSet.has(String(s._id))) group.seen = false;
  }

  const all = Array.from(groups.values()).sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);
  const own = all.filter((g) => g.isOwn);
  const unseen = all.filter((g) => !g.isOwn && !g.seen);
  const seen = all.filter((g) => !g.isOwn && g.seen);
  return [...own, ...unseen, ...seen].map(({ latestCreatedAt, ...g }) => g);
}
