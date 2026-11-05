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
  { value: 'hair', label: 'Hair' },
  { value: 'nails', label: 'Nails' },
  { value: 'makeup', label: 'Makeup' },
  { value: 'barber', label: 'Barber' },
  { value: 'beauty_spa', label: 'Beauty Spa' },
  { value: 'accommodation', label: 'Accommodation' },
  { value: 'car_hire', label: 'Car Hire' },
  { value: 'outfit_clothing', label: 'Outfit Clothing' },
  { value: 'shoes', label: 'Shoes' },
  { value: 'tour_guide', label: 'Tour Guide' },
  { value: 'babysitting', label: 'Babysitting' },
  { value: 'other',           label: 'Other' },
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]['value'];
export const SERVICE_CATEGORY_VALUES: ServiceCategory[] = SERVICE_CATEGORIES.map((c) => c.value);
export const STARTING_PRICE_UNITS = ['day', 'event', 'hour'] as const;
export type StartingPriceUnit = (typeof STARTING_PRICE_UNITS)[number];
