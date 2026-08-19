import { YocoClient, classifyEventType, toCents } from '@services/payments/yoco.client';
import crypto from 'crypto';

/** Build a Standard-Webhooks signature the way Yoco does, for round-trip tests. */
function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

const SECRET = 'whsec_' + Buffer.from('super-secret-signing-key').toString('base64');

describe('toCents', () => {
  it('converts a rand amount to integer cents', () => {
    expect(toCents(50)).toBe(5000);
    expect(toCents(50.5)).toBe(5050);
    expect(toCents(0)).toBe(0);
  });

  it('rounds away binary-float drift rather than truncating', () => {
    // 80.7 * 100 === 8069.999999999999 in IEEE-754 — truncation would undercharge.
    expect(toCents(80.7)).toBe(8070);
    expect(toCents(1.005)).toBe(101);
  });
});

describe('classifyEventType', () => {
  it('maps the two documented payment events', () => {
    expect(classifyEventType('payment.succeeded')).toBe('success');
    expect(classifyEventType('payment.failed')).toBe('rejected');
  });

  it('never treats an unknown event as success', () => {
    expect(classifyEventType('refund.succeeded')).toBe('ignore');
    expect(classifyEventType('payment.something.new')).toBe('ignore');
    expect(classifyEventType('')).toBe('ignore');
  });
});

describe('YocoClient', () => {
  const OLD = process.env;
  beforeEach(() => {
    process.env = {
      ...OLD,
      YOCO_ENABLED: 'true',
      YOCO_SECRET_KEY: 'sk_test_abc123',
      YOCO_WEBHOOK_SECRET: SECRET,
      YOCO_RETURN_URL: 'https://api.carrottickets.com/api/public/purchase/yoco/return',
    };
  });
  afterEach(() => { process.env = OLD; jest.restoreAllMocks(); });

  it('isConfigured requires enabled + secret key + return url', () => {
    expect(new YocoClient().isConfigured()).toBe(true);
    process.env.YOCO_ENABLED = 'false';
    expect(new YocoClient().isConfigured()).toBe(false);
    process.env.YOCO_ENABLED = 'true';
    process.env.YOCO_SECRET_KEY = '';
    expect(new YocoClient().isConfigured()).toBe(false);
    process.env.YOCO_SECRET_KEY = 'sk_test_abc123';
    delete process.env['YOCO_RETURN_URL'];
    expect(new YocoClient().isConfigured()).toBe(false);
  });

  it('createCheckout posts cents + ZAR with bearer auth and returns id + redirectUrl', async () => {
    const spy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 'ch_abc', redirectUrl: 'https://c.yoco.com/checkout/ch_abc', status: 'created' }),
      text: async () => '',
    } as any);

    const r = await new YocoClient().createCheckout({
      amount: 80.7,
      currency: 'ZAR',
      successUrl: 'https://x/ok',
      cancelUrl: 'https://x/cancel',
      failureUrl: 'https://x/fail',
      metadata: { saleId: 'TKT-1' },
      externalId: 'TKT-1',
      idempotencyKey: 'sale-1',
    });

    expect(r.id).toBe('ch_abc');
    expect(r.redirectUrl).toBe('https://c.yoco.com/checkout/ch_abc');

    const [url, opts] = spy.mock.calls[0] as [string, any];
    expect(url).toBe('https://payments.yoco.com/api/checkouts');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer sk_test_abc123');
    expect(opts.headers['Idempotency-Key']).toBe('sale-1');
    const body = JSON.parse(opts.body);
    expect(body.amount).toBe(8070);            // integer cents, not 80.7
    expect(body.currency).toBe('ZAR');
    expect(body.successUrl).toBe('https://x/ok');
    expect(body.cancelUrl).toBe('https://x/cancel');
    expect(body.failureUrl).toBe('https://x/fail');
    expect(body.metadata).toEqual({ saleId: 'TKT-1' });
    expect(body.externalId).toBe('TKT-1');
  });

  it('createCheckout throws on a non-2xx without leaking the secret key', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false, status: 401,
      json: async () => ({ description: 'Invalid API key' }),
      text: async () => 'Invalid API key',
    } as any);

    const call = new YocoClient().createCheckout({
      amount: 10, currency: 'ZAR', successUrl: 'https://x/ok', cancelUrl: 'https://x/c',
      failureUrl: 'https://x/f', metadata: {}, externalId: 'x', idempotencyKey: 'k',
    });
    await expect(call).rejects.toThrow(/Yoco createCheckout failed: HTTP 401/);
    await expect(call).rejects.not.toThrow(/sk_test_abc123/);
  });

  it('createCheckout throws when the response omits a redirectUrl', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 'ch_abc' }), // no redirectUrl — buyer would have nowhere to go
      text: async () => '',
    } as any);

    await expect(new YocoClient().createCheckout({
      amount: 10, currency: 'ZAR', successUrl: 'https://x/ok', cancelUrl: 'https://x/c',
      failureUrl: 'https://x/f', metadata: {}, externalId: 'x', idempotencyKey: 'k',
    })).rejects.toThrow(/Yoco createCheckout failed/);
  });

  describe('verifyWebhook', () => {
    const body = JSON.stringify({ type: 'payment.succeeded', payload: { id: 'p_1' } });
    const id = 'msg_123';
    const now = () => String(Math.floor(Date.now() / 1000));

    it('accepts a correctly signed payload', () => {
      const ts = now();
      expect(new YocoClient().verifyWebhook({
        rawBody: body, webhookId: id, webhookTimestamp: ts, webhookSignature: sign(SECRET, id, ts, body),
      })).toBe(true);
    });

    it('accepts when the header carries several space-separated signatures', () => {
      const ts = now();
      const header = `v1,othersignature ${sign(SECRET, id, ts, body)}`;
      expect(new YocoClient().verifyWebhook({
        rawBody: body, webhookId: id, webhookTimestamp: ts, webhookSignature: header,
      })).toBe(true);
    });

    it('rejects a tampered body', () => {
      const ts = now();
      const sig = sign(SECRET, id, ts, body);
      const tampered = JSON.stringify({ type: 'payment.succeeded', payload: { id: 'p_ATTACKER' } });
      expect(new YocoClient().verifyWebhook({
        rawBody: tampered, webhookId: id, webhookTimestamp: ts, webhookSignature: sig,
      })).toBe(false);
    });

    it('rejects a replayed payload outside the timestamp tolerance', () => {
      const stale = String(Math.floor(Date.now() / 1000) - 600); // 10 min old
      expect(new YocoClient().verifyWebhook({
        rawBody: body, webhookId: id, webhookTimestamp: stale, webhookSignature: sign(SECRET, id, stale, body),
      })).toBe(false);
    });

    it('rejects when no signing secret is configured rather than passing', () => {
      delete process.env['YOCO_WEBHOOK_SECRET'];
      const ts = now();
      expect(new YocoClient().verifyWebhook({
        rawBody: body, webhookId: id, webhookTimestamp: ts, webhookSignature: sign(SECRET, id, ts, body),
      })).toBe(false);
    });

    it('rejects a missing or malformed signature header', () => {
      const ts = now();
      const c = new YocoClient();
      expect(c.verifyWebhook({ rawBody: body, webhookId: id, webhookTimestamp: ts, webhookSignature: '' })).toBe(false);
      expect(c.verifyWebhook({ rawBody: body, webhookId: id, webhookTimestamp: ts, webhookSignature: 'garbage' })).toBe(false);
    });
  });
});
