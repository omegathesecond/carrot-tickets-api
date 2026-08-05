import { normalizePhone, isValidPhone } from '@utils/phone.util';

export type Identifier =
  | { channel: 'sms'; value: string }
  | { channel: 'email'; value: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Classify a raw login identifier as an email or a phone. Email wins if it
 * contains an '@' and matches a basic email shape; otherwise we treat it as a
 * phone and normalise it. Throws a single user-facing error if it is neither.
 */
export function classifyIdentifier(raw: string): Identifier {
  const trimmed = (raw ?? '').trim();
  if (trimmed.includes('@')) {
    const email = trimmed.toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error('Enter a valid phone number or email');
    return { channel: 'email', value: email };
  }
  const phone = normalizePhone(trimmed);
  if (!isValidPhone(phone)) throw new Error('Enter a valid phone number or email');
  return { channel: 'sms', value: phone };
}
