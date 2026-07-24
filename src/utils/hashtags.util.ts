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
