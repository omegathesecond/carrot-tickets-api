export const EVENT_CATEGORIES = ['Music', 'Art', 'Food', 'Tech', 'Sports', 'Theater', 'Comedy', 'Fashion', 'Film', 'Other'] as const;
export type EventCategory = typeof EVENT_CATEGORIES[number];
