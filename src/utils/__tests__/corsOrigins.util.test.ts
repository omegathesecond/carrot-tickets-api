import { buildCorsOrigin, matchesOrigin, assertSafeWildcard } from '@utils/corsOrigins.util';

const PREVIEW = 'https://*.keshless-tickets-landing.pages.dev';

function allows(env: string, origin: string | undefined): boolean {
  const o = buildCorsOrigin(env);
  if (o === '*') return true;
  let result = false;
  o(origin, (_e, allow) => { result = !!allow; });
  return result;
}

describe('matchesOrigin', () => {
  it('matches an exact origin', () => {
    expect(matchesOrigin('https://carrottickets.com', 'https://carrottickets.com')).toBe(true);
    expect(matchesOrigin('https://evil.com', 'https://carrottickets.com')).toBe(false);
  });

  it('matches any branch preview under our Pages project', () => {
    expect(matchesOrigin('https://redesign-consumer-ui.keshless-tickets-landing.pages.dev', PREVIEW)).toBe(true);
    expect(matchesOrigin('https://some-other-branch.keshless-tickets-landing.pages.dev', PREVIEW)).toBe(true);
  });

  it('matches the project apex too', () => {
    expect(matchesOrigin('https://keshless-tickets-landing.pages.dev', PREVIEW)).toBe(true);
  });

  // THE point of scoping the wildcard: another Pages site must not get in.
  it('does NOT match someone else\'s pages.dev project', () => {
    expect(matchesOrigin('https://evil-project.pages.dev', PREVIEW)).toBe(false);
    expect(matchesOrigin('https://attacker.someone-else.pages.dev', PREVIEW)).toBe(false);
  });

  // Label-boundary check: a prefix that merely ENDS with our project string.
  it('does not match a look-alike host without a label boundary', () => {
    expect(matchesOrigin('https://evilkeshless-tickets-landing.pages.dev', PREVIEW)).toBe(false);
  });

  it('does not match when our host is only a prefix of a longer domain', () => {
    expect(matchesOrigin('https://x.keshless-tickets-landing.pages.dev.evil.com', PREVIEW)).toBe(false);
  });

  it('refuses http for wildcard entries (no plaintext impersonation)', () => {
    expect(matchesOrigin('http://branch.keshless-tickets-landing.pages.dev', PREVIEW)).toBe(false);
  });
});

describe('assertSafeWildcard', () => {
  it('rejects a bare public suffix — the exact thing we must not allow', () => {
    expect(() => assertSafeWildcard('https://*.pages.dev')).toThrow(/too broad/i);
    expect(() => assertSafeWildcard('https://*.workers.dev')).toThrow(/too broad/i);
  });

  it('accepts a project-scoped host', () => {
    expect(() => assertSafeWildcard(PREVIEW)).not.toThrow();
  });
});

describe('buildCorsOrigin', () => {
  it('keeps "*" behaviour when unset', () => {
    expect(buildCorsOrigin(undefined)).toBe('*');
    expect(buildCorsOrigin('*')).toBe('*');
  });

  it('allows exact and wildcard entries side by side', () => {
    const env = `https://carrottickets.com,${PREVIEW}`;
    expect(allows(env, 'https://carrottickets.com')).toBe(true);
    expect(allows(env, 'https://redesign-consumer-ui.keshless-tickets-landing.pages.dev')).toBe(true);
    expect(allows(env, 'https://nope.com')).toBe(false);
  });

  it('still allows requests with no Origin header (curl, server-to-server)', () => {
    expect(allows('https://carrottickets.com', undefined)).toBe(true);
  });

  it('boots loudly rather than quietly honouring an unsafe wildcard', () => {
    expect(() => buildCorsOrigin('https://*.pages.dev')).toThrow(/too broad/i);
  });

  it('tolerates whitespace around entries', () => {
    expect(allows(' https://carrottickets.com , https://manage.carrottickets.com ', 'https://manage.carrottickets.com')).toBe(true);
  });
});
