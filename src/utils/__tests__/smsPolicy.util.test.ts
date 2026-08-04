import { shouldSendSms } from '@utils/smsPolicy.util';

describe('shouldSendSms', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD }; });
  afterEach(() => { process.env = OLD; });

  it('sends by default when nothing is configured (production behaviour)', () => {
    delete process.env['SMS_ENABLED'];
    delete process.env['SMS_ALLOWLIST'];
    expect(shouldSendSms('+26878422613').send).toBe(true);
  });

  it('blocks everything when SMS_ENABLED is exactly "false"', () => {
    process.env['SMS_ENABLED'] = 'false';
    const r = shouldSendSms('+26878422613');
    expect(r.send).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
  });

  it('treats any other SMS_ENABLED value as enabled — fail OPEN, never silently mute prod', () => {
    process.env['SMS_ENABLED'] = 'yes';
    expect(shouldSendSms('+26878422613').send).toBe(true);
  });

  it('allows only allow-listed numbers when SMS_ALLOWLIST is set', () => {
    process.env['SMS_ALLOWLIST'] = '+26878422613';
    expect(shouldSendSms('+26878422613').send).toBe(true);
    const blocked = shouldSendSms('+26876000000');
    expect(blocked.send).toBe(false);
    expect(blocked.reason).toMatch(/allow-list/i);
  });

  it('matches allow-list entries through normalizePhone, so local and E.164 forms agree', () => {
    process.env['SMS_ALLOWLIST'] = '78422613';           // local form configured
    expect(shouldSendSms('+26878422613').send).toBe(true); // E.164 at call site
  });

  it('ignores blank entries and whitespace in the allow-list', () => {
    process.env['SMS_ALLOWLIST'] = ' +26878422613 , ,';
    expect(shouldSendSms('+26878422613').send).toBe(true);
    expect(shouldSendSms('+26876000000').send).toBe(false);
  });

  it('an empty SMS_ALLOWLIST means "no allow-list", not "block everything"', () => {
    process.env['SMS_ALLOWLIST'] = '';
    expect(shouldSendSms('+26876000000').send).toBe(true);
  });
});
