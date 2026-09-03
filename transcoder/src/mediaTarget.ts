export type MediaCollection = 'updates' | 'stories';

export interface VideoRendition {
  url: string;
  url480: string;
  poster: string;
  width: number;
  height: number;
  durationSec: number;
}

/**
 * Where a transcode result gets written. Update.media is an ARRAY (the
 * single video always lives at index 0 — see @models/update.model on the api
 * side); Story.media is a single embedded doc, no array. Same field names
 * (`status`/`video`/`error`), different path prefix — this is the one thing
 * that has to branch on `collection` in the whole write path.
 */
export function mediaPathPrefix(collection: MediaCollection): string {
  return collection === 'stories' ? 'media' : 'media.0';
}

/** R2 key namespace for a rendition — kept per-collection so `stories/` and
 *  `updates/` objects don't share a prefix in the bucket listing. */
export function renditionKeyPrefix(collection: MediaCollection, id: string): string {
  return `${collection}/ready/${id}`;
}

export function readyUpdateOps(collection: MediaCollection, video: VideoRendition): Record<string, unknown> {
  const p = mediaPathPrefix(collection);
  return { [`${p}.status`]: 'ready', [`${p}.video`]: video };
}

export function failedUpdateOps(collection: MediaCollection, message: string): Record<string, unknown> {
  const p = mediaPathPrefix(collection);
  return { [`${p}.status`]: 'failed', [`${p}.error`]: message };
}
