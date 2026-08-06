/** mulberry32 — a tiny, fast, well-distributed 32-bit seeded PRNG. Returns a
 *  generator of floats in [0, 1). Deterministic for a given seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle driven by a seeded PRNG. Returns a NEW array (never
 *  mutates the input). The same (items, seed) always yields the same
 *  permutation — that determinism is what keeps a paginated "load more" stable
 *  within a single visit (the frontend reuses one seed per mount). Safe on
 *  empty and single-element arrays. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** Parse a `?seed=` query value to a 32-bit unsigned int, or `undefined` when
 *  absent, blank, or not a finite number. `undefined` is the signal for "no
 *  shuffle — keep the deterministic ranking" (shuffle is opt-in). */
export function parseSeed(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n) >>> 0;
}
