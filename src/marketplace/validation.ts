import Joi from 'joi';
import { HttpError } from '@utils/httpError.util';

export const MARKET_TYPES = [
  'Weekly Markets',
  'Monthly Markets',
  'Night Markets',
  'Seasonal Markets',
  'Festivals',
  'Agricultural Shows',
  'Christmas Markets',
];
export const AVAILABILITY = [
  'Weekdays',
  'Saturdays',
  'Sundays',
  'Public Holidays',
];
export const CERTIFICATE_TYPES = [
  'food_handling',
  'kitchen_compliance',
  'coa',
  'public_liability',
];
export const REGIONS: Record<string, string[]> = {
  ZA: [
    'Eastern Cape',
    'Free State',
    'Gauteng',
    'KwaZulu-Natal',
    'Limpopo',
    'Mpumalanga',
    'North West',
    'Northern Cape',
    'Western Cape',
  ],
  SZ: ['Hhohho', 'Manzini', 'Lubombo', 'Shiselweni'],
  LS: [
    'Berea',
    'Butha-Buthe',
    'Leribe',
    'Mafeteng',
    'Maseru',
    'Mohale’s Hoek',
    'Mokhotlong',
    'Qacha’s Nek',
    'Quthing',
    'Thaba-Tseka',
  ],
};
const text = (max = 200) => Joi.string().trim().max(max);
const strings = (max = 50) =>
  Joi.array().items(text()).unique().max(max).default([]);
export const idSchema = Joi.string().hex().length(24).required();
export const stallSchema = Joi.object({
  size: text(80).allow('').default(''),
  power: Joi.boolean().default(false),
  water: Joi.boolean().default(false),
  shelter: Joi.boolean().default(false),
  ownGazebo: Joi.boolean().default(false),
}).required();
export const profileSchema = Joi.object({
  businessName: text().required(),
  contactName: text().required(),
  email: text().email().required(),
  phone: text(40).required(),
  country: Joi.string()
    .length(2)
    .uppercase()
    .pattern(/^[A-Z]{2}$/)
    .required(),
  regions: strings(),
  categories: strings(),
  currentMarkets: text(2000).allow('').default(''),
  desiredMarkets: text(2000).allow('').default(''),
  marketTypes: Joi.array()
    .items(Joi.string().valid(...MARKET_TYPES))
    .unique()
    .default([]),
  availability: Joi.array()
    .items(Joi.string().valid(...AVAILABILITY))
    .unique()
    .default([]),
  stall: stallSchema,
  sellsFood: Joi.boolean().required(),
});
const fee = Joi.object({
  label: text(100).required(),
  amount: Joi.number().min(0).max(10000000).precision(2).required(),
});
export const opportunitySchema = Joi.object({
  name: text().required(),
  location: text(500).required(),
  country: Joi.string()
    .length(2)
    .uppercase()
    .pattern(/^[A-Z]{2}$/)
    .required(),
  description: text(6000).required(),
  marketType: Joi.string()
    .valid(...MARKET_TYPES)
    .required(),
  categories: strings(),
  availability: Joi.array()
    .items(Joi.string().valid(...AVAILABILITY))
    .unique()
    .default([]),
  dates: Joi.array()
    .items(Joi.string().isoDate())
    .min(1)
    .max(100)
    .unique()
    .required(),
  scope: Joi.string().valid('date', 'regular').required(),
  applicationDeadline: Joi.date().iso().required(),
  paymentDeadline: Joi.date().iso().required(),
  capacity: Joi.number().integer().min(1).max(100000).allow(null).default(null),
  stallSizes: Joi.array().items(text(80)).unique().min(1).max(30).required(),
  stall: stallSchema,
  currency: Joi.string()
    .length(3)
    .uppercase()
    .pattern(/^[A-Z]{3}$/)
    .required(),
  stallFee: Joi.number().min(0).max(10000000).precision(2).required(),
  feeTiers: Joi.array().items(fee).max(30).default([]),
  optionalCharges: Joi.array().items(fee).max(30).default([]),
  cancellationTerms: text(4000).required(),
  requiredCertificates: Joi.array()
    .items(Joi.string().valid(...CERTIFICATE_TYPES))
    .unique()
    .default([]),
  foodCertificates: Joi.array()
    .items(Joi.string().valid(...CERTIFICATE_TYPES))
    .unique()
    .default([]),
});
export function validate<T = any>(schema: Joi.Schema, input: unknown): T {
  const { value, error } = schema.validate(input, {
    abortEarly: false,
    stripUnknown: false,
  });
  if (error) throw new HttpError(400, error.message);
  return value;
}
export function validateProfile(input: unknown) {
  const value = validate(profileSchema, input);
  if (
    REGIONS[value.country] &&
    value.regions.some((r: string) => !REGIONS[value.country]!.includes(r))
  ) {
    throw new HttpError(400, 'Choose regions for the selected country');
  }
  return value;
}
export function validateOpportunity(input: unknown) {
  const value = validate(opportunitySchema, input);
  value.dates = value.dates
    .map((d: string) => new Date(d).toISOString().slice(0, 10))
    .sort();
  if (new Set(value.dates).size !== value.dates.length)
    throw new HttpError(400, 'Trading dates must be distinct');
  if (
    value.applicationDeadline > value.paymentDeadline ||
    value.paymentDeadline > new Date(value.dates[0] + 'T23:59:59.999Z')
  ) {
    throw new HttpError(
      400,
      'Application deadline must precede payment deadline and the first trading date',
    );
  }
  if (!value.stallSizes.includes(value.stall.size))
    throw new HttpError(400, 'Select a configured stall size');
  return value;
}
export function certificateProblems(
  profile: any,
  certificates: any[],
  opportunity: any,
  now = new Date(),
): string[] {
  const problems: string[] = [];
  if (!profile.categories.length)
    problems.push(
      'categories: choose at least one product or service category',
    );
  if (!opportunity.stallSizes.includes(profile.stall.size))
    problems.push('stall.size: select an available stall size');
  const required = new Set<string>([
    ...opportunity.requiredCertificates,
    ...(profile.sellsFood ? opportunity.foodCertificates : []),
  ]);
  for (const type of required) {
    const doc = certificates.find((c) => c.type === type);
    if (!doc)
      problems.push(`certificates.${type}: upload the required certificate`);
    else if (
      doc.expiresAt &&
      new Date(doc.expiresAt).getTime() <= now.getTime()
    )
      problems.push(`certificates.${type}: certificate has expired`);
  }
  return problems;
}
