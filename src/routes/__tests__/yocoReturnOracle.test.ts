/**
 * The Yoco return URL must not be an unauthenticated lookup oracle.
 *
 * It previously echoed the sale's checkout id and payment status straight into
 * the redirect, so anyone holding (or guessing) a sale ref learned that the sale
 * existed, its Yoco checkout id, and whether it had been paid — no auth at all.
 * Sale refs are not secret: they are sent to Yoco as `externalId` and appear on
 * receipts. The differing responses also made mere existence enumerable.
 *
 * The status a buyer sees must come from THEIR OWN authenticated record instead.
 */
import request from 'supertest';

jest.mock('@services/ticket.service');

import app from '@/app';
import { TicketService } from '@services/ticket.service';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';

const mockGetByRef = TicketService.getYocoSaleByRef as jest.MockedFunction<
  typeof TicketService.getYocoSaleByRef
>;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(() => jest.clearAllMocks());

const PAGE = 'https://carrottickets.com/payment-result';

describe('GET /api/public/purchase/yoco/return — no information disclosure', () => {
  it('does NOT leak the checkout id for a known sale ref', async () => {
    mockGetByRef.mockResolvedValueOnce({
      yocoCheckoutId: 'ch_SECRET', paymentStatus: 'completed',
    } as any);

    const res = await request(app).get('/api/public/purchase/yoco/return?ref=SALE-REAL');

    expect(res.status).toBe(302);
    expect(res.headers['location']).not.toContain('ch_SECRET');
  });

  it('does NOT leak the payment status for a known sale ref', async () => {
    mockGetByRef.mockResolvedValueOnce({
      yocoCheckoutId: 'ch_x', paymentStatus: 'completed',
    } as any);

    const res = await request(app).get('/api/public/purchase/yoco/return?ref=SALE-REAL');

    expect(res.headers['location']).not.toContain('status=');
  });

  it('is INDISTINGUISHABLE between a real ref and a bogus one', async () => {
    // The core anti-enumeration property: an attacker must not be able to tell
    // whether a guessed ref corresponds to a real sale.
    mockGetByRef.mockResolvedValueOnce({
      yocoCheckoutId: 'ch_x', paymentStatus: 'completed',
    } as any);
    const real = await request(app).get('/api/public/purchase/yoco/return?ref=SALE-REAL');

    mockGetByRef.mockResolvedValueOnce(null);
    const bogus = await request(app).get('/api/public/purchase/yoco/return?ref=SALE-FAKE');

    expect(real.status).toBe(bogus.status);
    expect(real.headers['location']).toBe(bogus.headers['location']);
  });

  it('still sends the buyer to the result page tagged as yoco', async () => {
    mockGetByRef.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/public/purchase/yoco/return?ref=SALE-ANY');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(`${PAGE}?method=yoco`);
  });

  it('sends the buyer to the result page even with no ref at all', async () => {
    const res = await request(app).get('/api/public/purchase/yoco/return');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(`${PAGE}?method=yoco`);
  });

  it('never finalises from the return redirect', async () => {
    mockGetByRef.mockResolvedValueOnce(null);
    await request(app).get('/api/public/purchase/yoco/return?ref=SALE-ANY');

    expect(TicketService.finalizeYocoSale).not.toHaveBeenCalled();
  });
});
