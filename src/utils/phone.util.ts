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
