/**
 * The resend cooldown has to reach the UI as a NUMBER, not just prose.
 *
 * `OtpService` refuses a second code inside a 60s per-destination window, but it
 * only ever said so in a sentence ("Please wait 47 seconds before requesting
 * another code.") returned as a plain 400. The only way for a client to render a
 * live countdown was to regex the copy — which the buyer site does today, and
 * which silently breaks the moment the wording changes or gets localised.
 *
 * So the throttle is now a typed `OtpCooldownError` carrying
 * `retryAfterSeconds`, surfaced as HTTP 429 with a standard `Retry-After`
 * header. The message text is deliberately UNCHANGED so the buyer site's
 * existing `/wait (\d+) second/` parse keeps working until it migrates.
 */
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { OtpCooldownError } from '@utils/httpError.util';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { TicketsController } from '@controllers/tickets.controller';
import { PublicController } from '@controllers/public.controller';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';

jest.mock('@services/email.service');
jest.mock('@services/sms.service');

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

beforeEach(() => {
  (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);
  (SmsService.sendOtp as jest.Mock).mockResolvedValue(true);
});

afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

/** Minimal Express doubles — ApiResponseUtil reads res.req.originalUrl. */
function fakeExchange(body: unknown, url: string) {
  const res: any = {
    statusCode: 0,
    payload: undefined,
    headers: {} as Record<string, string>,
    req: { originalUrl: url },
  };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.payload = payload; return res; };
  res.set = (name: string, value: string) => { res.headers[name] = value; return res; };
  return { req: { body } as any, res };
}

describe('OtpService cooldown — typed error', () => {
  it('throws an OtpCooldownError carrying the remaining seconds', async () => {
    await Vendor.create({ businessName: 'Neogen', email: 'org@x.com', password: 'oldpass1' });
    await TicketsAuthService.requestPasswordResetOtp('org@x.com');

    const error = await TicketsAuthService.requestPasswordResetOtp('org@x.com').catch((e) => e);

    expect(error).toBeInstanceOf(OtpCooldownError);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keeps the legacy wording so the buyer site’s regex still matches', async () => {
    await Vendor.create({ businessName: 'Neogen', email: 'org@x.com', password: 'oldpass1' });
    await TicketsAuthService.requestPasswordResetOtp('org@x.com');

    const error = await TicketsAuthService.requestPasswordResetOtp('org@x.com').catch((e) => e);

    expect(error.message).toMatch(/wait \d+ seconds? before requesting another code/i);
    expect(/wait\s+(\d+)\s+second/i.exec(error.message)?.[1]).toBe(String(error.retryAfterSeconds));
  });
});

describe('organizer forgot-password endpoint', () => {
  it('answers a throttled request with 429 and Retry-After', async () => {
    await Vendor.create({ businessName: 'Neogen', email: 'org@x.com', password: 'oldpass1' });
    await TicketsAuthService.requestPasswordResetOtp('org@x.com');

    const { req, res } = fakeExchange({ identifier: 'org@x.com' }, '/api/tickets/auth/forgot-password');
    await TicketsController.forgotPassword(req, res);

    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
    expect(res.payload.message).toMatch(/wait \d+ seconds?/i);
  });

  it('still answers a genuine failure with 400 and no Retry-After', async () => {
    const { req, res } = fakeExchange({ identifier: 'nobody@x.com' }, '/api/tickets/auth/forgot-password');
    await TicketsController.forgotPassword(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});

describe('buyer forgot-password endpoint', () => {
  it('answers a throttled request with 429 and Retry-After', async () => {
    await Buyer.create({ email: 'buyer@x.com', password: 'oldpass1', emailVerifiedAt: new Date() });
    await BuyerAuthService.requestPasswordResetOtp('buyer@x.com');

    const { req, res } = fakeExchange({ identifier: 'buyer@x.com' }, '/api/public/auth/forgot-password');
    await PublicController.forgotPasswordBuyer(req, res);

    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
  });
});
