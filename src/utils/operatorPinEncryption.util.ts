import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function key(): Buffer {
  const encoded = process.env['OPERATOR_PIN_ENCRYPTION_KEY'];
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('OPERATOR_PIN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  const value = Buffer.from(encoded, 'base64');
  if (value.length !== 32) throw new Error('Invalid OPERATOR_PIN_ENCRYPTION_KEY');
  return value;
}

/** Bind the ciphertext to its account, preventing encrypted PIN swaps between rows. */
export function encryptOperatorPin(pin: string, accountId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(accountId));
  const encrypted = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptOperatorPin(encrypted: string, accountId: string): string {
  const data = Buffer.from(encrypted, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(accountId));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}
