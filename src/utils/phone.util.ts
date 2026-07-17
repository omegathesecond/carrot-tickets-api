/**
 * Phone normalisation for Keshless Tickets.
 *
 * Tickets are matched to a buyer purely by their phone number
 * (Ticket.customerPhone), so the SAME normalisation MUST run both when a
 * ticket is written (public purchase) and when a buyer logs in / lists their
 * tickets — otherwise "+268 7842 2613" at purchase and "78422613" at login
 * would never match.
 *
 * Default country is Eswatini (+268). Local subscriber numbers are 8 digits.
 */
const DEFAULT_DIAL_CODE = '268';

export function normalizePhone(input: string): string {
  if (!input) return '';

  // Strip everything except digits and a single leading '+'.
  let digits = input.trim().replace(/[^\d+]/g, '');
  const hadPlus = digits.startsWith('+');
  digits = digits.replace(/\+/g, '');

  if (!digits) return '';

  // Already in full international form (with or without the +).
  if (hadPlus) {
    return `+${digits}`;
  }
  if (digits.startsWith(DEFAULT_DIAL_CODE) && digits.length > DEFAULT_DIAL_CODE.length) {
    return `+${digits}`;
  }

  // Drop a local trunk '0' (e.g. 078... -> 78...) before prefixing.
  if (digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '');
  }

  // Bare local subscriber number -> prefix the default dial code.
  return `+${DEFAULT_DIAL_CODE}${digits}`;
}

/**
 * Loose validity check: a normalised number is + followed by 10-15 digits.
 */
export function isValidPhone(input: string): boolean {
  const normalized = normalizePhone(input);
  return /^\+\d{10,15}$/.test(normalized);
}

/**
 * Equivalent stored representations of a phone number, for a tolerant login
 * lookup. Vendor/sub-user phone numbers are stored verbatim (the schema only
 * trims them), so an organizer who signed up with "076123456" but logs in with
 * "+26876123456" — or vice-versa — would never match on an exact query.
 *
 * Given any phone-shaped identifier we return every plausible way the SAME
 * number could have been persisted (international, no-plus, local-trunk, bare
 * subscriber, plus the raw trimmed input), so `{ phoneNumber: { $in: [...] } }`
 * matches regardless of the format on record. Returns [] for non-phone input
 * (e.g. an email), so callers can skip the phone branch entirely.
 */
export function phoneLoginCandidates(input: string): string[] {
  const raw = (input || '').trim();
  if (!raw || raw.includes('@')) return []; // clearly an email, not a phone

  const normalized = normalizePhone(raw); // -> +268XXXXXXXX (or +<intl>)
  if (!/^\+\d{6,15}$/.test(normalized)) return [];

  const digits = normalized.slice(1); // 268XXXXXXXX
  const candidates = new Set<string>([normalized, digits, raw]);

  if (digits.startsWith(DEFAULT_DIAL_CODE) && digits.length > DEFAULT_DIAL_CODE.length) {
    const local = digits.slice(DEFAULT_DIAL_CODE.length); // XXXXXXXX
    candidates.add(local);
    candidates.add(`0${local}`);
  }

  return [...candidates];
}
