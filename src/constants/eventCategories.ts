// Stable internal ids — never rename an id once events reference it. Labels
// (what the frontend renders as tab/pill text) may be re-worded freely
// without a data migration, since filtering matches on `id`, not on the
// displayed label.
export const EVENT_CATEGORIES = [
  { id: 'events', label: 'Events' },
  { id: 'travel-tours', label: 'Travel & Tours' },
  { id: 'transport', label: 'Transport' },
  { id: 'sports', label: 'Sports' },
  { id: 'religion', label: 'Religion' },
  { id: 'cinema-theatre', label: 'Cinema & Theatre' },
  { id: 'education', label: 'Education' },
  { id: 'business', label: 'Business' },
  { id: 'food-hospitality', label: 'Food & Hospitality' },
  { id: 'nightlife', label: 'Nightlife' },
  { id: 'health-wellness', label: 'Health & Wellness' },
  { id: 'parking', label: 'Parking' },
  { id: 'memberships', label: 'Memberships' },
  { id: 'appointments', label: 'Appointments' },
  { id: 'competitions', label: 'Competitions' },
  { id: 'packages', label: 'Packages' },
] as const;

export type EventCategory = typeof EVENT_CATEGORIES[number]['id'];

export const EVENT_CATEGORY_IDS = EVENT_CATEGORIES.map((c) => c.id) as EventCategory[];

export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = Object.fromEntries(
  EVENT_CATEGORIES.map((c) => [c.id, c.label]),
) as Record<EventCategory, string>;

// Catch-all for events that can't be confidently mapped to a specific
// category (see migrateLegacyEventCategories) — never auto-selected in the
// organizer create/edit form, which requires an explicit choice.
export const DEFAULT_EVENT_CATEGORY: EventCategory = 'events';
