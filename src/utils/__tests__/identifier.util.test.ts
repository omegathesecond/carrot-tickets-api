import { classifyIdentifier } from '@utils/identifier.util';

describe('classifyIdentifier', () => {
  it('classifies an email (lowercased, trimmed)', () => {
    expect(classifyIdentifier('  BUYER@Example.com ')).toEqual({ channel: 'email', value: 'buyer@example.com' });
  });

  it('classifies + normalises a phone', () => {
    expect(classifyIdentifier('078422613')).toEqual({ channel: 'sms', value: '+26878422613' });
  });

  it('throws on garbage', () => {
    expect(() => classifyIdentifier('not-a-thing')).toThrow(/valid phone number or email/i);
  });
});
