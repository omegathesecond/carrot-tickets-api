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

/** Canonicalize user/QR input: uppercase, drop everything outside the alphabet set. */
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
