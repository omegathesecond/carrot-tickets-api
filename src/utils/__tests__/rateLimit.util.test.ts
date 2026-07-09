import { consumeToken, resetBuckets } from '@utils/rateLimit.util';

describe('rateLimit.util token bucket', () => {
  beforeEach(resetBuckets);

  it('allows a burst of 5 then blocks', () => {
    for (let i = 0; i < 5; i++) expect(consumeToken('u1')).toBe(true);
    expect(consumeToken('u1')).toBe(false);
  });

  it('keys are independent', () => {
    for (let i = 0; i < 5; i++) consumeToken('u1');
    expect(consumeToken('u1')).toBe(false);
    expect(consumeToken('u2')).toBe(true);
  });

  it('refills over time', () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      for (let i = 0; i < 5; i++) consumeToken('u1');
      expect(consumeToken('u1')).toBe(false);
      now += 2_000; // 2s => 2 tokens back
      expect(consumeToken('u1')).toBe(true);
      expect(consumeToken('u1')).toBe(true);
      expect(consumeToken('u1')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});
