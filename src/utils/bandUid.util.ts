// A band's UID is the physical NFC chip identifier (cashless spec §5.1) —
// callers may hand it in with `:`-separated bytes or mixed case (however a
// scanner/reader library happens to format it). Normalize once here so every
// consumer (bind, reissue, sell-band, check-in, wallet-by-band) compares the
// same canonical lowercase hex string.
export function normalizeBandUid(raw: string): string {
  return String(raw ?? '').replace(/[\s:]/g, '').toLowerCase();
}

// 14 hex chars = 7 bytes, the minimum real NFC UID length (4-byte UIDs exist
// but are not what this system's bands use) — see task-3 brief.
export function assertValidBandUid(raw: string): string {
  const uid = normalizeBandUid(raw);
  if (!/^[0-9a-f]+$/.test(uid)) throw new Error('invalid band uid: must be hex');
  if (uid.length < 14) throw new Error('invalid band uid: must be at least 7 bytes (14 hex chars)');
  return uid;
}
