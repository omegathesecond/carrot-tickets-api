import { blendedRecentSales } from '@controllers/public.controller';

describe('blendedRecentSales (synthetic+real blend, item #19)', () => {
  it('never reports fewer than the real sales', () => {
    expect(blendedRecentSales(12, 'ev1')).toBeGreaterThanOrEqual(12);
  });

  it('floors an empty window to a positive believable number', () => {
    const n = blendedRecentSales(0, 'ev1');
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(20);
  });

  it('is stable for the same event seed (no per-request re-roll)', () => {
    expect(blendedRecentSales(0, 'ev1')).toBe(blendedRecentSales(0, 'ev1'));
  });

  it('is stable for a real, non-zero count too', () => {
    expect(blendedRecentSales(5, 'ev2')).toBe(blendedRecentSales(5, 'ev2'));
  });

  it('varies the synthetic floor by seed (not the same constant for every event)', () => {
    const seeds = ['ev1', 'ev2', 'ev3', 'ev4', 'ev5', 'ev6', 'ev7', 'ev8'];
    const values = new Set(seeds.map((s) => blendedRecentSales(0, s)));
    expect(values.size).toBeGreaterThan(1);
  });
});
