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
