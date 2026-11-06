import { mapConcurrent } from '../mapConcurrent.util';

it('bounds simultaneous work and returns results in input order', async () => {
  let running = 0, peak = 0;
  const results = await mapConcurrent([3, 1, 2, 4], 2, async n => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, n));
    running--; return n * 10;
  });
  expect(results).toEqual([30, 10, 20, 40]);
  expect(peak).toBe(2);
});

it('drains already-started writes before propagating a failure', async () => {
  let completed = false;
  await expect(mapConcurrent([0, 1], 2, async n => {
    if (n === 0) throw new Error('write failed');
    await new Promise(resolve => setTimeout(resolve, 5)); completed = true;
  })).rejects.toThrow('write failed');
  expect(completed).toBe(true);
});

it('accepts an empty batch and rejects an invalid concurrency', async () => {
  expect(await mapConcurrent([], 2, async x => x)).toEqual([]);
  await expect(mapConcurrent([1], 0, async x => x)).rejects.toThrow('positive integer');
});
