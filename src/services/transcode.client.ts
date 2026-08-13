import { Update } from '@models/update.model';

/**
 * Minimal shape triggerTranscode needs — just an id and a raw R2 key. IUpdate
 * (and IStory, see @models/story.model) both satisfy this structurally, so
 * either can be passed without a cast. NOTE: the separate transcoder
 * microservice (transcoder/src/db.ts) currently writes its result back with
 * `Update.updateOne({_id: updateId}, ...)` against the hardcoded `updates`
 * collection — see finalizeStory in @services/story.service for the caveat
 * this implies for video Stories.
 */
export interface Transcodable {
  id?: unknown; // mongoose's Document.id is itself optional/`any` — matched here so real docs satisfy this structurally
  media: { rawKey: string }[]; // videos are always a single item — media[0]
}

export async function triggerTranscode(target: Transcodable): Promise<void> {
  const url = process.env['TRANSCODER_URL'];
  const secret = process.env['TRANSCODER_SHARED_SECRET'];
  if (!url || !secret) throw new Error('TRANSCODER_URL / TRANSCODER_SHARED_SECRET not configured');
  const rawKey = target.media[0]?.rawKey;
  if (!rawKey) throw new Error('Transcodable has no media[0].rawKey');
  const res = await fetch(`${url}/transcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-transcoder-secret': secret },
    body: JSON.stringify({ updateId: String(target.id), rawKey }),
  });
  if (!res.ok) throw new Error(`Transcoder responded ${res.status}`);
}

export async function reconcileStuckUpdates(): Promise<void> {
  const now = Date.now();
  const retryBefore = new Date(now - 10 * 60000);
  const failBefore = new Date(now - 30 * 60000);
  const stuck = await Update.find({ kind: 'video', 'media.status': 'processing' }).select('_id media').lean();
  for (const u of stuck) {
    const started = u.media?.[0]?.processingStartedAt ? new Date(u.media[0].processingStartedAt).getTime() : now;
    if (started < failBefore.getTime()) {
      await Update.updateOne({ _id: u._id }, { $set: { 'media.0.status': 'failed', 'media.0.error': 'transcode timed out' } });
    } else if (started < retryBefore.getTime()) {
      const full = await Update.findById(u._id);
      if (full) triggerTranscode(full).catch((e) => console.error('re-trigger transcode failed:', e?.message));
    }
  }
}
