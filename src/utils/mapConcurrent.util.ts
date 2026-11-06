/** Bounded parallel work, preserving input order and draining workers on failure. */
export async function mapConcurrent<T, U>(items: readonly T[], concurrency: number,
  run: (item: T, index: number) => Promise<U>): Promise<U[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const results: U[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!, index);
    }
  });
  const settled = await Promise.allSettled(workers);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  return results;
}
