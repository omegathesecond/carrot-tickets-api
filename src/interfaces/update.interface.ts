export type UpdateAuthorType = 'vendor' | 'buyer';
export type UpdateKind = 'video' | 'image';
export type UpdateMediaStatus = 'processing' | 'ready' | 'failed';

export interface UpdateVideoMedia {
  url: string;          // 720p mp4 (primary)
  url480?: string;      // 480p mp4 (low-bandwidth)
  poster: string;       // JPG poster
  width: number;
  height: number;
  durationSec: number;
}
export interface UpdateImageMedia {
  url: string;
  width: number;
  height: number;
}
export interface UpdateMedia {
  rawKey: string;
  status: UpdateMediaStatus;
  video?: UpdateVideoMedia;
  image?: UpdateImageMedia;
  error?: string;
  processingStartedAt?: Date;   // for the reconcile sweep
}
