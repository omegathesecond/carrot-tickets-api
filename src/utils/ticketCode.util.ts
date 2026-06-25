import { randomInt } from 'crypto';

/** Unambiguous alphabet — no I, L, O, 0, 1. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** Random 8-char ticket code from the unambiguous alphabet. */
export function generateTicketCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

/**
 * Canonicalize input for lookup: uppercase and strip separators (spaces,
 * dashes, and other non-alphanumerics). This is normalization for matching,
 * NOT validation — an unknown/mistyped code simply fails to match and is
 * surfaced loudly to the operator (we never silently remap ambiguous chars).
 */
export function normalizeTicketCode(input: string): string {
  return (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Display helper: group an 8-char code as XXXX-XXXX. Other lengths pass through. */
export function groupTicketCode(code: string): string {
  if (code && code.length === CODE_LENGTH) {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }
  return code;
}
