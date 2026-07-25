const HASHTAG_RE = /#(\w+)/g;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 50;

/** Extracts hashtags from a caption for the trending-hashtags feature.
 *  Stored lowercased, WITHOUT the leading '#'; deduped preserving first-seen
 *  order; capped at 10; tags over 50 chars are ignored (not truncated). */
export function extractHashtags(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const match of caption.matchAll(HASHTAG_RE)) {
    const tag = match[1]?.toLowerCase();
    if (!tag || tag.length > MAX_TAG_LENGTH || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** Normalizes a raw hashtag route/query param the same way extractHashtags
 *  stores tags: trims, strips leading '#'(s), and lowercases — so
 *  `GET /api/public/topics/:tag/posts` matches against the stored form
 *  regardless of how the client passed it in (`#Music`, `MUSIC`, `music`).
 *  Returns '' for empty/whitespace-only input; callers should treat that as
 *  invalid rather than querying with it. */
export function normalizeHashtag(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^#+/, '').toLowerCase();
}
