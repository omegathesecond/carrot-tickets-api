// A band's UID is the physical NFC chip identifier (cashless spec §5.1) —
// callers may hand it in with `:`-separated bytes or mixed case (however a
// scanner/reader library happens to format it). Normalize once here so every
// consumer (register, bind, reissue, check-in, wallet-by-band) compares the
// same canonical lowercase hex string.
export function normalizeBandUid(raw: string): string {
  return String(raw ?? '').replace(/[\s:]/g, '').toLowerCase();
}

// 8 hex chars = 4 bytes, the minimum real NFC UID length in the wild —
// common 4-byte tags (e.g. MIFARE Classic) are accepted. The unique-per-event
// index on Wallet.bandUid already rejects a duplicate UID at bind time, and
// cloning defense is server-side (spend cap, block-list) regardless of UID
// length, so a 4-byte floor is acceptable here.
export function assertValidBandUid(raw: string): string {
  const uid = normalizeBandUid(raw);
  if (!/^[0-9a-f]+$/.test(uid)) throw new Error('invalid band uid: must be hex');
  if (uid.length < 8) throw new Error('invalid band uid: must be at least 4 bytes (8 hex chars)');
  return uid;
}
