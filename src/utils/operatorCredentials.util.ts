// api/src/utils/operatorCredentials.util.ts
import { randomInt } from 'crypto';
import { ResellerOperator } from '@models/resellerOperator.model';
import { GateOperator } from '@models/gateOperator.model';
import { Cashier } from '@models/cashier.model';
import { Merchant } from '@models/merchant.model';

/**
 * Crockford base32 — 32 glyphs with I, L, O and U removed. Chosen over
 * base36 because this code is printed on a slip and typed into a handheld in
 * a loud venue: dropping the ambiguous pairs (and folding them on input, see
 * normalizeLoginCode) is worth more than the extra 4 glyphs of entropy.
 */
export const LOGIN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const LOGIN_CODE_LENGTH = 6;

/** Random 6-digit PIN string (leading zeros allowed). */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Fold a typed code onto the canonical alphabet. Uppercase FIRST so a
 * lowercase "l" reaches the I/L rule. Legacy all-numeric codes are a strict
 * subset of the alphabet and pass through unchanged.
 */
export function normalizeLoginCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < LOGIN_CODE_LENGTH; i++) {
    out += LOGIN_CODE_ALPHABET[randomInt(0, LOGIN_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Random login code, unique across every PIN-login population. Codes are
 * NEVER reclaimed — history must stay attributable — so uniqueness is
 * permanent. At 32^6 (~1.07 billion) the retry loop is a formality.
 */
export async function generateUniqueLoginCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    const [r, g, c, m] = await Promise.all([
      ResellerOperator.exists({ loginCode: code }),
      GateOperator.exists({ loginCode: code }),
      Cashier.exists({ loginCode: code }),
      Merchant.exists({ loginCode: code }),
    ]);
    if (!r && !g && !c && !m) return code;
  }
  throw new Error('Could not generate a unique login code');
}
