import type { SocialActor } from '@utils/socialActor.util';

/** One row kind. The client renders the sentence from this — the server never
 *  builds prose, so copy changes ship without an API deploy. */
export type ActivityType =
  | 'like_event'
  | 'like_post'
  | 'follow'
  | 'going'
  | 'post'
  | 'event';

/** Cursor keys, one watermark per source. Short to keep the base64 small. */
export const SOURCE_KEYS = {
  like_event: 'le',
  like_post: 'lp',
  follow: 'f',
  going: 'g',
  post: 'p',
  event: 'e',
} as const;

export interface ActivityActor {
  kind: 'buyer' | 'organizer';
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  href: string;
}

export interface ActivityTarget {
  kind: 'event' | 'post' | 'buyer' | 'organizer';
  id: string;
  name: string | null;
  imageUrl: string | null;
  href: string;
}

/** A fully hydrated, client-ready row. */
export interface ActivityItem {
  type: ActivityType;
  /** Stable row id, `"<type>:<sourceId>"`. Used as the React key. */
  id: string;
  sortAt: string; // ISO
  actor: ActivityActor;
  target: ActivityTarget;
}

/** A pre-hydration row: identifiers only, no names or images yet. */
export interface ActivityCandidate {
  type: ActivityType;
  sourceId: string;
  sortAt: Date;
  actor: { kind: 'buyer' | 'organizer'; id: string };
  target: { kind: 'event' | 'post' | 'buyer' | 'organizer'; id: string };
}

/** One ISO watermark per source key. Absent key = start from newest. */
export interface ActivityCursor {
  le?: string;
  lp?: string;
  f?: string;
  g?: string;
  p?: string;
  e?: string;
}

export type ActivityTab = 'everyone' | 'following';

export interface ActivityFeedOpts {
  tab: ActivityTab;
  cursor?: string;
  limit?: number;
  /** Required when tab === 'following'; the caller enforces that. */
  viewer?: SocialActor;
}
