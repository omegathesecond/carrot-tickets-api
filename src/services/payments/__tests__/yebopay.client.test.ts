import crypto from 'crypto';
import {
  YeboPayClient,
  classifyEventType,
  classifyCheckoutStatus,
} from '@services/payments/yebopay.client';

const LIVE_KEY = 'ypk_live_abcdef0123456789';
const TEST_KEY = 'ypk_test_abcdef0123456789';

/** Sign a body the way YeboPay does, so the happy path is a real signature. */
function sign(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('classifyEventType', () => {
  it('only checkout.completed mints', () => {
    expect(classifyEventType('checkout.completed')).toBe('success');
  });

  it('treats terminal checkout failures as rejected', () => {
    expect(classifyEventType('checkout.expired')).toBe('rejected');
    expect(classifyEventType('checkout.cancelled')).toBe('rejected');
  });

  // The money-losing case: a declined card is NOT terminal on YeboPay — the
  // PaymentIntent returns to requires_payment_method and the buyer retries in
  // place. Mapping this to 'rejected' would cancel a sale still being paid for.
  it('ignores charge.failed rather than rejecting the sale', () => {
    expect(classifyEventType('charge.failed')).toBe('ignore');
  });

  it('fails closed on an unknown event type', () => {
    expect(classifyEventType('checkout.completed.v2')).toBe('ignore');
    expect(classifyEventType('')).toBe('ignore');
  });
});

describe('classifyCheckoutStatus', () => {
  it('maps the lifecycle', () => {
    expect(classifyCheckoutStatus('COMPLETED')).toBe('success');
    expect(classifyCheckoutStatus('EXPIRED')).toBe('rejected');
    expect(classifyCheckoutStatus('CANCELLED')).toBe('rejected');
    expect(classifyCheckoutStatus('OPEN')).toBe('pending');
  });

  it('never reports an unknown status as paid', () => {
    expect(classifyCheckoutStatus('SETTLED')).toBe('pending');
  });
});

describe('sandboxMode', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is undefined on a live key (YeboPay ignores the field)', () => {
    process.env['YEBOPAY_API_KEY'] = LIVE_KEY;
    expect(new YeboPayClient().sandboxMode()).toBeUndefined();
  });

  it('defaults a test key to real Stripe test mode', () => {
    process.env['YEBOPAY_API_KEY'] = TEST_KEY;
    delete process.env['YEBOPAY_SANDBOX_MODE'];
    expect(new YeboPayClient().sandboxMode()).toBe('stripe_test');
  });

  it('honours an explicit simulated override', () => {
    process.env['YEBOPAY_API_KEY'] = TEST_KEY;
    process.env['YEBOPAY_SANDBOX_MODE'] = 'simulated';
    expect(new YeboPayClient().sandboxMode()).toBe('simulated');
  });

  // No silent fallback: a typo must not quietly downgrade real Stripe test
  // coverage to clicking buttons.
  it('throws on an unrecognised mode', () => {
    process.env['YEBOPAY_API_KEY'] = TEST_KEY;
    process.env['YEBOPAY_SANDBOX_MODE'] = 'stripetest';
    expect(() => new YeboPayClient().sandboxMode()).toThrow(/Invalid YEBOPAY_SANDBOX_MODE/);
  });
});

describe('verifyWebhook', () => {
  const SECRET = 'whsec_carrot_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.completed', data: { id: 'co_1' } });
  const saved = { ...process.env };

  beforeEach(() => {
    process.env['YEBOPAY_WEBHOOK_SECRET'] = SECRET;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('accepts a correctly signed body', () => {
    expect(new YeboPayClient().verifyWebhook({ rawBody: body, signatureHeader: sign(body, SECRET) })).toBe(true);
  });

  it('rejects a body that changed after signing', () => {
    const header = sign(body, SECRET);
    const tampered = body.replace('co_1', 'co_2');
    expect(new YeboPayClient().verifyWebhook({ rawBody: tampered, signatureHeader: header })).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(
      new YeboPayClient().verifyWebhook({ rawBody: body, signatureHeader: sign(body, 'whsec_attacker') })
    ).toBe(false);
  });

  it('rejects a replayed signature outside the tolerance', () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect(new YeboPayClient().verifyWebhook({ rawBody: body, signatureHeader: sign(body, SECRET, stale) })).toBe(false);
  });

  // Future-dated too — a clock-skewed forgery is still a forgery.
  it('rejects a far-future timestamp', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(new YeboPayClient().verifyWebhook({ rawBody: body, signatureHeader: sign(body, SECRET, future) })).toBe(false);
  });

  it('rejects a malformed header', () => {
    const c = new YeboPayClient();
    expect(c.verifyWebhook({ rawBody: body, signatureHeader: '' })).toBe(false);
    expect(c.verifyWebhook({ rawBody: body, signatureHeader: 'garbage' })).toBe(false);
    expect(c.verifyWebhook({ rawBody: body, signatureHeader: `t=${Math.floor(Date.now() / 1000)}` })).toBe(false);
    expect(c.verifyWebhook({ rawBody: body, signatureHeader: 'v1=deadbeef' })).toBe(false);
  });

  it('rejects a non-hex v1 without throwing', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(new YeboPayClient().verifyWebhook({ rawBody: body, signatureHeader: `t=${t},v1=zzzz` })).toBe(false);
  });

  // Fails closed: an unconfigured secret must never mean "accept everything".
  //
  // Signed with the EMPTY secret on purpose. crypto.createHmac('sha256', '')
  // does not throw — it derives a real key from the empty string — so an
  // attacker who knows the secret is unset can forge a body that verifies
  // against `secret = ''`. Signing with the *correct* secret here would pass
  // even with the guard deleted, proving nothing.
  it('rejects a forgery signed with the empty secret when none is configured', () => {
    delete process.env['YEBOPAY_WEBHOOK_SECRET'];
    const forged = sign(body, '');
    expect(new YeboPayClient().verifyWebhook({ rawBody: body, signatureHeader: forged })).toBe(false);
  });
});
