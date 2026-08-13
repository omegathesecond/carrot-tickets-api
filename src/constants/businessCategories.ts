export const BUSINESS_CATEGORIES = [
  'Sound Hire',
  'Food Stalls',
  'Furniture & Decor',
  'Toilet Rental',
  'Catering',
  'Photography',
  'Lighting',
  'Security',
  'Marquees & Tents',
  'Transport',
  'Other',
] as const;
export type BusinessCategory = typeof BUSINESS_CATEGORIES[number];
