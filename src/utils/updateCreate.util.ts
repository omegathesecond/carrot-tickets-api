export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PHOTOS = 5;

type Item = { ext: string; contentType: string };
type Result =
  | { ok: true; kind: 'video' | 'image'; items: Item[] }
  | { ok: false; message: string };

/**
 * Server-authoritative gate for Update creation: kind:'video' must be
 * exactly 1 item with a video contentType; kind:'image' is 1..MAX_PHOTOS
 * items, every one an image contentType. Shared by both the buyer
 * (create) and vendor (createAsVendor) controllers so the rule can't drift
 * between them — do NOT duplicate these checks inline in a controller.
 */
export function validateCreateItems(kind: unknown, items: unknown): Result {
  if (kind !== 'video' && kind !== 'image') return { ok: false, message: 'kind must be video or image' };
  if (!Array.isArray(items) || items.length === 0) return { ok: false, message: 'items must be a non-empty array' };
  if (kind === 'video' && items.length !== 1) return { ok: false, message: 'a video post must have exactly one item' };
  if (kind === 'image' && items.length > MAX_PHOTOS) return { ok: false, message: `a photo post allows at most ${MAX_PHOTOS} images` };
  const allow = kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
  const norm: Item[] = [];
  for (const it of items) {
    const ct = (it as any)?.contentType;
    if (typeof ct !== 'string' || !allow.includes(ct)) return { ok: false, message: `Invalid contentType for ${kind}` };
    norm.push({ ext: String((it as any)?.ext || 'bin'), contentType: ct });
  }
  return { ok: true, kind, items: norm };
}
