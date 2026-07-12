import { Update, IUpdate } from '@models/update.model';
import { updatesR2 } from '@utils/updatesR2';
import { triggerTranscode } from '@services/transcode.client';
import type { UpdateAuthorType, UpdateKind } from '@interfaces/update.interface';

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
