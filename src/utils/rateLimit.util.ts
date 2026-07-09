/**
 * In-memory token bucket, per instance. Good enough as the v1 send guard —
 * with N instances the effective burst is N x capacity, still a hard cap
 * per user. The realtime plan can move this to a shared store if needed.
 */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

export function consumeToken(key: string, capacity = 5, refillPerSec = 1): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefillMs: now };
    buckets.set(key, bucket);
  }
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
  bucket.lastRefillMs = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Test hook — clears all buckets. */
export function resetBuckets(): void {
  buckets.clear();
}
