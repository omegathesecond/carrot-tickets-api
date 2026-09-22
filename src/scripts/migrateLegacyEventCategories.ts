import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { DEFAULT_EVENT_CATEGORY, EventCategory } from '@/constants/eventCategories';

/**
 * One-time, idempotent: remaps the old free-text category labels (Music,
 * Art, Food, Tech, Sports, Theater, Comedy, Fashion, Film, Other) to the new
 * stable category ids introduced with the 16-category taxonomy. Only a clear
 * label→id match is mapped directly; anything ambiguous falls back to
 * DEFAULT_EVENT_CATEGORY ('events') rather than guessing, per the rollout
 * spec — an admin/organizer can re-tag it afterward.
 *
 * Safe to re-run: only touches documents still holding an old label (matched
 * against LEGACY_CATEGORY_MAP's keys, which are none of the new ids), so a
 * second run is a no-op.
 */
const LEGACY_CATEGORY_MAP: Record<string, EventCategory> = {
  Music: 'events',
  Art: 'events',
  Food: 'food-hospitality',
  Tech: 'events',
  Sports: 'sports',
  Theater: 'cinema-theatre',
  Comedy: 'cinema-theatre',
  Fashion: 'events',
  Film: 'cinema-theatre',
  Other: DEFAULT_EVENT_CATEGORY,
};

export async function migrateLegacyEventCategories(): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;
  for (const [legacyLabel, newId] of Object.entries(LEGACY_CATEGORY_MAP)) {
    const res = await Event.updateMany({ category: legacyLabel }, { $set: { category: newId } });
    updated += res.modifiedCount;
    skipped += res.matchedCount - res.modifiedCount;
  }
  return { updated, skipped };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[migrateLegacyEventCategories] done:', await migrateLegacyEventCategories());
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[migrateLegacyEventCategories] failed:', err);
    process.exit(1);
  });
}
