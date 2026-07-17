import { Update, IUpdate } from '@models/update.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { updatesR2 } from '@utils/updatesR2';
import { triggerTranscode } from '@services/transcode.client';
import type { UpdateAuthorType, UpdateKind } from '@interfaces/update.interface';
import type { SocialActor } from '@utils/socialActor.util';
import { toggleReactionGeneric } from '@services/reactions.service';

interface CreateInput {
  authorType: UpdateAuthorType;
  authorId: string;
  kind: UpdateKind;
  caption: string;
  eventId?: string;
  ext: string;
  contentType: string;
}

export async function createUpdate(input: CreateInput): Promise<{ update: IUpdate; uploadUrl: string }> {
  const rawKey = updatesR2.rawKey(input.ext);
  const uploadUrl = await updatesR2.presignPut(rawKey, input.contentType);
  const update = await Update.create({
    authorType: input.authorType,
    authorId: input.authorId,
    kind: input.kind,
    caption: input.caption ?? '',
    eventId: input.eventId,
    media: { rawKey, status: 'processing' },
  });
  return { update, uploadUrl };
}

export async function finalizeUpdate(id: string): Promise<IUpdate> {
  const update = await Update.findById(id);
  if (!update) throw new Error('Update not found');
  if (update.kind === 'image') {
    update.media.image = { url: updatesR2.publicUrl(update.media.rawKey), width: 0, height: 0 };
    update.media.status = 'ready';
    await update.save();
    return update;
  }
  update.media.processingStartedAt = new Date();
  update.media.status = 'processing';
  await update.save();
  // fire-and-forget; durability comes from reconcileStuckUpdates (Task 8)
  triggerTranscode(update).catch((err) => console.error('triggerTranscode failed:', err?.message));
  return update;
}

export async function getUpdate(id: string): Promise<IUpdate | null> {
  return Update.findById(id);
}

const counterField = (type: 'like' | 'save') => (type === 'like' ? 'likeCount' : 'saveCount');

export async function toggleReaction(updateId: string, actor: SocialActor, type: 'like' | 'save') {
  const { active } = await toggleReactionGeneric({
    reactionModel: UpdateReaction,
    targetModel: Update,
    targetField: 'updateId',
    targetId: updateId,
    actor,
    type,
    counterField: counterField(type),
  });
  const u = await Update.findById(updateId).select('likeCount saveCount').lean();
  return { active, likeCount: u?.likeCount ?? 0, saveCount: u?.saveCount ?? 0 };
}

export async function recordShare(updateId: string) {
  const u = await Update.findByIdAndUpdate(updateId, { $inc: { shareCount: 1 } }, { new: true }).select('shareCount').lean();
  return { shareCount: u?.shareCount ?? 0 };
}

export async function recordView(updateId: string): Promise<{ viewCount: number }> {
  const u = await Update.findByIdAndUpdate(updateId, { $inc: { viewCount: 1 } }, { new: true }).select('viewCount').lean();
  return { viewCount: u?.viewCount ?? 0 };
}

export async function getViewerReactions(updateIds: string[], actor: SocialActor): Promise<Record<string, { liked: boolean; saved: boolean }>> {
  const rows = await UpdateReaction.find({ updateId: { $in: updateIds }, actorType: actor.type, buyerId: actor.id }).lean();
  const map: Record<string, { liked: boolean; saved: boolean }> = {};
  for (const id of updateIds) map[String(id)] = { liked: false, saved: false };
  for (const r of rows) {
    const k = String(r.updateId);
    if (!map[k]) map[k] = { liked: false, saved: false };
    if (r.type === 'like') map[k].liked = true;
    if (r.type === 'save') map[k].saved = true;
  }
  return map;
}
