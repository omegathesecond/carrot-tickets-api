import { PeachClient, classifyResultCode } from '@services/payments/peach.client';
import crypto from 'crypto';
describe('classifyResultCode', () => {
  it('success/pending/rejected', () => {
    expect(classifyResultCode('000.000.000')).toBe('success');
    expect(classifyResultCode('000.100.110')).toBe('success');
    expect(classifyResultCode('000.200.000')).toBe('pending');
    expect(classifyResultCode('800.100.151')).toBe('rejected');
  });
});
describe('PeachClient', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, CARD_PAYMENTS_ENABLED:'true', PEACH_BASE_URL:'https://api-v2.peachpayments.com',
    PEACH_ENTITY_ID:'E', PEACH_USER_ID:'U', PEACH_PASSWORD:'P', CARD_CURRENCY:'ZAR', CARD_RESULT_URL:'https://x/r' }; });
  afterEach(() => { process.env = OLD; jest.restoreAllMocks(); });
  it('isConfigured requires enabled+creds+CARD_RESULT_URL', () => {
    expect(new PeachClient().isConfigured()).toBe(true);
    process.env.PEACH_USER_ID=''; expect(new PeachClient().isConfigured()).toBe(false);
    process.env = { ...process.env, PEACH_USER_ID:'U' };
    delete process.env['CARD_RESULT_URL']; expect(new PeachClient().isConfigured()).toBe(false);
  });
  it('createPayment posts auth+fields, returns id+redirect', async () => {
    const spy = jest.spyOn(global,'fetch' as any).mockResolvedValue({ ok:true, status:200,
      json: async () => ({ id:'pay_1', result:{code:'000.200.000'}, redirect:{url:'https://peach/pay',method:'GET',parameters:[]} }),
      text: async () => '' } as any);
    const r = await new PeachClient().createPayment({ amount:50, currency:'ZAR', merchantTransactionId:'TKT-1', shopperResultUrl:'https://x/r', nonce:'n1' });
    expect(r.id).toBe('pay_1'); expect(r.redirect?.url).toBe('https://peach/pay');
    const call = spy.mock.calls[0];
    expect(call).toBeDefined();
    const [url,opts] = call as [string, any];
    expect(url).toBe('https://api-v2.peachpayments.com/payments');
    const body = JSON.parse((opts as any).body);
    expect(body.authentication).toEqual({ userId:'U', password:'P', entityId:'E' });
    expect(body.amount).toBe('50.00'); expect(body.paymentType).toBe('DB'); expect(body.paymentBrand).toBe('CARD');
  });
  it('createPayment throws on non-ok', async () => {
    jest.spyOn(global,'fetch' as any).mockResolvedValue({ ok:false, status:401, json: async () => ({}), text: async () => 'no' } as any);
    await expect(new PeachClient().createPayment({ amount:1, currency:'ZAR', merchantTransactionId:'x', shopperResultUrl:'y', nonce:'z' }))
      .rejects.toThrow(/Peach createPayment failed: HTTP 401/);
  });
  it('getPaymentStatus GETs with query auth', async () => {
    const spy = jest.spyOn(global,'fetch' as any).mockResolvedValue({ ok:true, status:200,
      json: async () => ({ result:{code:'000.000.000'}, amount:'50.00', currency:'ZAR' }) } as any);
    const s = await new PeachClient().getPaymentStatus('pay_1');
    expect(s.code).toBe('000.000.000'); expect(s.amount).toBe('50.00');
    const call = spy.mock.calls[0];
    expect(call).toBeDefined();
    const url = call?.[0] as string;
    expect(url).toContain('/payments/pay_1?');
    expect(url).toContain('authentication.userId=U');
  });
  it('decryptWebhook round-trips an AES-128-GCM payload', () => {
    const key = '00112233445566778899aabbccddeeff';
    const iv = '000000000000000000000000';
    const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(key,'hex'), Buffer.from(iv,'hex'));
    const pt = JSON.stringify({ id:'pay_1', result:{code:'000.000.000'} });
    const enc = Buffer.concat([cipher.update(pt,'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    process.env.PEACH_WEBHOOK_SECRET = key;
    const out = new PeachClient().decryptWebhook({ bodyHex: enc.toString('hex'), ivHex: iv, authTagHex: tag.toString('hex') });
    expect(out.id).toBe('pay_1'); expect(out.result.code).toBe('000.000.000');
  });
});
