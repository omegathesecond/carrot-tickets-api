import { seededShuffle, parseSeed } from '@utils/seededShuffle.util';

describe('seededShuffle', () => {
  it('is deterministic for a given seed', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(seededShuffle(items, 42)).toEqual(seededShuffle(items, 42));
  });

  it('produces a permutation (no loss, no duplication)', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = seededShuffle(items, 7);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
  });

  it('does not mutate the input', () => {
    const items = [1, 2, 3, 4, 5];
    const copy = [...items];
    seededShuffle(items, 99);
    expect(items).toEqual(copy);
  });

  it('returns different orders for different seeds (large pool)', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(seededShuffle(items, 1)).not.toEqual(seededShuffle(items, 2));
  });

  it('is safe on empty and single-element arrays', () => {
    expect(seededShuffle([], 1)).toEqual([]);
    expect(seededShuffle([42], 1)).toEqual([42]);
  });
});

describe('parseSeed', () => {
  it('returns undefined for absent / blank / non-numeric input', () => {
    expect(parseSeed(undefined)).toBeUndefined();
    expect(parseSeed(null)).toBeUndefined();
    expect(parseSeed('')).toBeUndefined();
    expect(parseSeed('abc')).toBeUndefined();
  });

  it('parses a numeric value to a uint32', () => {
    expect(parseSeed('12345')).toBe(12345);
    expect(parseSeed('0')).toBe(0);
  });
});
