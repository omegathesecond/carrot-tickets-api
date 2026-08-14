export const SERVICE_CATEGORIES = [
  { value: 'sound_hire',      label: 'Sound hire' },
  { value: 'food_stalls',     label: 'Food stalls' },
  { value: 'furniture_decor', label: 'Furniture & Decor' },
  { value: 'toilet_rental',   label: 'Toilet rental' },
  { value: 'catering',        label: 'Catering' },
  { value: 'photography',     label: 'Photography' },
  { value: 'lighting',        label: 'Lighting' },
  { value: 'security',        label: 'Security' },
  { value: 'marquees_tents',  label: 'Marquees & tent' },
  { value: 'transport',       label: 'Transport' },
  { value: 'other',           label: 'Other' },
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]['value'];
export const SERVICE_CATEGORY_VALUES: ServiceCategory[] = SERVICE_CATEGORIES.map((c) => c.value);
export const STARTING_PRICE_UNITS = ['day', 'event', 'hour'] as const;
export type StartingPriceUnit = (typeof STARTING_PRICE_UNITS)[number];
