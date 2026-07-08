// Guards the gateway split: Eswatini numbers ride the Keshless MTN SMPP link,
// anything international must divert to YeboLink (Twilio) — Keshless accepts
// foreign numbers but never delivers to them.

// sms.service.ts captures KESHLESS_API_KEY at module load, so it must be in
// the environment BEFORE the service is required (imports would hoist above
// this assignment).
process.env['KESHLESS_API_KEY'] = 'test-key';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SmsService } = require('../sms.service') as typeof import('../sms.service');
const { YeboLinkClient } = require('../yebolink.client') as typeof import('../yebolink.client');
/* eslint-enable @typescript-eslint/no-var-requires */

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const yeboLinkMock = jest
  .spyOn(YeboLinkClient, 'sendSMS')
  .mockResolvedValue({ messageId: 'm1', status: 'queued' });

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true } as Response);
  yeboLinkMock.mockClear();
});

it('sends Eswatini OTPs through the Keshless gateway', async () => {
  const ok = await SmsService.sendOtp('+26878422613', '123456');
  expect(ok).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toContain('/integration/sms');
  expect(yeboLinkMock).not.toHaveBeenCalled();
});

it('normalizes bare local numbers to Eswatini and keeps them on Keshless', async () => {
  await SmsService.sendOtp('78422613', '123456');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(yeboLinkMock).not.toHaveBeenCalled();
});

it('diverts international OTPs to YeboLink', async () => {
  const ok = await SmsService.sendOtp('+27760984255', '123456');
  expect(ok).toBe(true);
  expect(yeboLinkMock).toHaveBeenCalledWith(
    '+27760984255',
    expect.stringContaining('123456'),
    expect.any(String),
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it('returns false when the international leg fails (fail-loud for OTP callers)', async () => {
  yeboLinkMock.mockRejectedValueOnce(new Error('YeboLink SMS send failed (402): Insufficient credits'));
  const ok = await SmsService.sendOtp('+27760984255', '123456');
  expect(ok).toBe(false);
});
