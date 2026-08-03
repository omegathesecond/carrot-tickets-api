import { DeltapayClient, classifySessionStatus } from '@services/payments/deltapay.client';
import { DeltapayProcessor } from '@services/payments/deltapay.processor';

describe('classifySessionStatus', () => {
  it('maps the documented statuses', () => {
    expect(classifySessionStatus('succeeded')).toBe('success');
    expect(classifySessionStatus('pending')).toBe('pending');
    expect(classifySessionStatus('processing')).toBe('pending');
    expect(classifySessionStatus('failed')).toBe('rejected');
    expect(classifySessionStatus('expired')).toBe('rejected');
    expect(classifySessionStatus('cancelled')).toBe('rejected');
  });

  it('treats an UNKNOWN status as pending — never as success', () => {
    // A provider-side enum addition must never be able to mint tickets.
    expect(classifySessionStatus('refunded')).toBe('pending');
    expect(classifySessionStatus('')).toBe('pending');
  });
});

describe('DeltapayProcessor', () => {
  it('throws from charge() — it must never run on the synchronous sell path', async () => {
    await expect(
      new DeltapayProcessor().charge({ method: 'deltapay' as any, amount: 10, description: 'x' })
    ).rejects.toThrow(/async/i);
  });
});

describe('DeltapayClient', () => {
  const OLD = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD,
      DELTAPAY_ENABLED: 'true',
      DELTAPAY_BASE_URL: 'https://api.dev.deltacrypt.net',
      DELTAPAY_API_KEY: 'k_test',
      DELTAPAY_RETURN_URL: 'https://api.carrottickets.com/api/public/purchase/deltapay/return',
    };
  });

  afterEach(() => {
    process.env = OLD;
    jest.restoreAllMocks();
  });

  it('isConfigured requires enabled + api key + return url', () => {
    expect(new DeltapayClient().isConfigured()).toBe(true);

    process.env['DELTAPAY_ENABLED'] = 'false';
    expect(new DeltapayClient().isConfigured()).toBe(false);

    process.env['DELTAPAY_ENABLED'] = 'true';
    process.env['DELTAPAY_API_KEY'] = '';
    expect(new DeltapayClient().isConfigured()).toBe(false);

    process.env['DELTAPAY_API_KEY'] = 'k_test';
    delete process.env['DELTAPAY_RETURN_URL'];
    expect(new DeltapayClient().isConfigured()).toBe(false);
  });

  it('createSession posts snake_case fields with the x-api-key header', async () => {
    const spy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        checkout_session_id: 'sess-1',
        checkout_url: 'https://checkout.deltacrypt.net/hosted-checkout/?checkout_session_id=sess-1',
        expires_at: '2026-01-01T12:10:00Z',
      }),
    } as any);

    const r = await new DeltapayClient().createSession({
      amount: 155,
      merchantReference: 'TKT-1',
      returnUrl: 'https://api.carrottickets.com/api/public/purchase/deltapay/return',
      displayDescription: '2 x Early Bird — Test Event',
      sessionCallbackUrl: 'https://api.carrottickets.com/api/public/purchase/deltapay/callback',
      payerIdentifier: '+26878422613',
      payerIdentifierType: 'phone_number',
    });

    expect(r.checkoutSessionId).toBe('sess-1');
    expect(r.checkoutUrl).toContain('checkout.deltacrypt.net');

    const call = spy.mock.calls[0];
    expect(call).toBeDefined();
    const [url, opts] = call as [string, any];
    expect(url).toBe('https://api.dev.deltacrypt.net/v1/hosted-checkout/sessions');
    expect(opts.headers['x-api-key']).toBe('k_test');

    const body = JSON.parse(opts.body);
    expect(body.amount).toBe(155);
    expect(body.merchant_reference).toBe('TKT-1');
    expect(body.return_url).toContain('/deltapay/return');
    expect(body.session_callback_url).toContain('/deltapay/callback');
    expect(body.payer_identifier).toBe('+26878422613');
    expect(body.payer_identifier_type).toBe('phone_number');
  });

  it('createSession omits optional fields when not supplied', async () => {
    const spy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ checkout_session_id: 's', checkout_url: 'https://c' }),
    } as any);

    await new DeltapayClient().createSession({
      amount: 10,
      merchantReference: 'TKT-2',
      returnUrl: 'https://r',
    });

    const body = JSON.parse((spy.mock.calls[0] as [string, any])[1].body);
    expect(body).not.toHaveProperty('session_callback_url');
    expect(body).not.toHaveProperty('payer_identifier');
    expect(body).not.toHaveProperty('payer_identifier_type');
  });

  it('createSession THROWS on non-ok — no silent fallback', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Invalid API key' }),
    } as any);

    await expect(
      new DeltapayClient().createSession({ amount: 1, merchantReference: 'x', returnUrl: 'y' })
    ).rejects.toThrow(/DeltaPay createSession failed: HTTP 401/);
  });

  it('createSession throws when the response is 200 but malformed', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ checkout_session_id: 'sess-1' }), // no checkout_url
    } as any);

    await expect(
      new DeltapayClient().createSession({ amount: 1, merchantReference: 'x', returnUrl: 'y' })
    ).rejects.toThrow(/DeltaPay createSession failed/);
  });

  it('verifySession GETs the verify-return path and parses the outcome', async () => {
    const spy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        checkout_session_id: 'sess-1',
        status: 'succeeded',
        merchant_reference: 'TKT-1',
        amount: 155,
        finalised_at: '2026-01-01T12:04:33Z',
      }),
    } as any);

    const v = await new DeltapayClient().verifySession('sess-1');
    expect(v.status).toBe('succeeded');
    expect(v.amount).toBe(155);
    expect(v.merchantReference).toBe('TKT-1');

    const [url, opts] = spy.mock.calls[0] as [string, any];
    expect(url).toBe(
      'https://api.dev.deltacrypt.net/v1/hosted-checkout/sessions/sess-1/verify-return'
    );
    expect(opts.method).toBe('GET');
    expect(opts.headers['x-api-key']).toBe('k_test');
  });

  it('verifySession throws on non-ok', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'Session not found' }),
    } as any);

    await expect(new DeltapayClient().verifySession('nope')).rejects.toThrow(
      /DeltaPay verifySession failed: HTTP 404/
    );
  });
});
