import type { UpdateMedia } from '@interfaces/update.interface';

export type StoryAuthorType = 'buyer' | 'vendor';
export type StoryKind = 'image' | 'video';

/** Stories reuse the exact same media sub-shape Updates use (raw upload ->
 *  processing -> ready/failed, image or video rendition). See
 *  @models/shared/media.schema for the Mongo-side schema this mirrors. */
export type StoryMedia = UpdateMedia;
