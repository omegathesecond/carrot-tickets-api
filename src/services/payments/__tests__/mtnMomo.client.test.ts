import { MtnMomoClient } from '@services/payments/mtnMomo.client';

describe('MtnMomoClient', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, MTN_MOMO_ENABLED: 'true', MTN_MOMO_BASE_URL: 'https://sb', MTN_MOMO_SUBSCRIPTION_KEY: 'sub', MTN_MOMO_API_USER: 'u', MTN_MOMO_API_KEY: 'k', MTN_MOMO_TARGET_ENV: 'sandbox', MTN_MOMO_CURRENCY: 'EUR' };
  });
  afterEach(() => { process.env = env; jest.restoreAllMocks(); });

  it('requestToPay returns the generated referenceId on 202', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) }) // token
      .mockResolvedValueOnce({ ok: true, status: 202, text: async () => '' });                          // requesttopay
    (global as any).fetch = fetchMock;
    const c = new MtnMomoClient();
    const r = await c.requestToPay({ amount: 100, currency: 'EUR', payerMsisdn: '26876123456', externalId: 'SALE-1', payerMessage: 'Tickets' });
    expect(r.referenceId).toMatch(/[0-9a-f-]{36}/);
  });

  it('requestToPay strips WAF-hostile characters (parentheses) from the note fields', async () => {
    let sentBody: any;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) }) // token
      .mockImplementationOnce(async (_url: string, init: any) => { sentBody = JSON.parse(init.body); return { ok: true, status: 202, text: async () => '' }; });
    (global as any).fetch = fetchMock;
    const c = new MtnMomoClient();
    await c.requestToPay({ amount: 100, currency: 'EUR', payerMsisdn: '26876123456', externalId: 'SALE-1', payerMessage: 'Carrot Tickets - General (Presale) x1' });
    // MTN's F5 WAF rejects the whole request if the body contains '(' or ')'.
    expect(sentBody.payerMessage).not.toMatch(/[()]/);
    expect(sentBody.payeeNote).not.toMatch(/[()]/);
    expect(sentBody.payerMessage).toBe('Carrot Tickets - General Presale x1');
  });

  it('requestToPay hides raw upstream detail and throws a generic message on a non-202', async () => {
    const wafHtml = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 10745831898339000904</body></html>';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => wafHtml });
    (global as any).fetch = fetchMock;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const c = new MtnMomoClient();
    let msg = '';
    try { await c.requestToPay({ amount: 100, currency: 'EUR', payerMsisdn: '26876123456', externalId: 'S', payerMessage: 'Tickets' }); }
    catch (e: any) { msg = e.message; }
    expect(msg).not.toContain('Request Rejected');
    expect(msg).not.toContain('support ID');
    expect(msg).not.toMatch(/HTTP \d/);
    expect(msg).toMatch(/balance|try again/i);
  });

  it('getStatus throws a generic message on a non-ok response', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    (global as any).fetch = fetchMock;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const c = new MtnMomoClient();
    await expect(c.getStatus('ref-1')).rejects.toThrow(/try again/i);
  });

  it('getStatus maps MTN status', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'SUCCESSFUL' }) });
    (global as any).fetch = fetchMock;
    const c = new MtnMomoClient();
    const s = await c.getStatus('ref-1');
    expect(s.status).toBe('SUCCESSFUL');
  });
});
