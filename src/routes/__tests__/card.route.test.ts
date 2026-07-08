// src/routes/__tests__/card.route.test.ts
//
// Tests for the Peach card webhook route.
// Mirror setup from momo/reseller route tests: mock the client BEFORE importing
// app, use supertest against the real Express app.

import request from 'supertest';

// Mock PeachClient BEFORE importing app (app → card.route → card.controller →
// PeachClient). Module-level mock so the constructor is shimmed everywhere.
const mockPeachInstance = {
  isConfigured: jest.fn().mockReturnValue(false),
  decryptWebhook: jest.fn(),
};
jest.mock('@services/payments/peach.client', () => ({
  PeachClient: jest.fn().mockImplementation(() => mockPeachInstance),
}));

// Mock TicketService so we don't need a live DB.
jest.mock('@services/ticket.service');

import app from '@/app';
import { TicketService } from '@services/ticket.service';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';

const mockFinalizeCardSale = TicketService.finalizeCardSale as jest.MockedFunction<
  typeof TicketService.finalizeCardSale
>;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(() => {
  jest.clearAllMocks();
  mockFinalizeCardSale.mockResolvedValue({ status: 'completed' });
});

describe('POST /api/public/purchase/peach-card/webhook', () => {
  it('returns 200 and calls finalizeCardSale when body contains { id }', async () => {
    const res = await request(app)
      .post('/api/public/purchase/peach-card/webhook')
      .send({ id: 'pay_1' });

    expect(res.status).toBe(200);
    expect(mockFinalizeCardSale).toHaveBeenCalledWith('pay_1');
  });

  it('still returns 200 when finalizeCardSale rejects (never propagate errors to Peach)', async () => {
    mockFinalizeCardSale.mockRejectedValueOnce(new Error('DB blew up'));

    const res = await request(app)
      .post('/api/public/purchase/peach-card/webhook')
      .send({ id: 'pay_err' });

    expect(res.status).toBe(200);
  });

  it('returns 200 and does not call finalizeCardSale for a Peach verification handshake', async () => {
    const res = await request(app)
      .post('/api/public/purchase/peach-card/webhook')
      .send({ verificationCode: 'abc123' });

    expect(res.status).toBe(200);
    expect(mockFinalizeCardSale).not.toHaveBeenCalled();
  });
});

describe('Peach shopperResultUrl return endpoint', () => {
  const PAGE = 'https://carrottickets.com/payment-result';

  it('GET with ?id finalises server-side and 302s to the SPA result page with the id', async () => {
    const res = await request(app).get('/api/public/purchase/peach-card/return?id=pay_get');

    expect(res.status).toBe(302);
    expect(mockFinalizeCardSale).toHaveBeenCalledWith('pay_get');
    expect(res.headers['location']).toBe(`${PAGE}?id=pay_get`);
  });

  it('POST (3DS form-urlencoded) finalises and 302s to the SPA result page', async () => {
    const res = await request(app)
      .post('/api/public/purchase/peach-card/return')
      .type('form')
      .send({ id: 'pay_post' });

    expect(res.status).toBe(302);
    expect(mockFinalizeCardSale).toHaveBeenCalledWith('pay_post');
    expect(res.headers['location']).toBe(`${PAGE}?id=pay_post`);
  });

  it('still 302s to the result page (no id) when finalize is impossible', async () => {
    const res = await request(app).get('/api/public/purchase/peach-card/return');

    expect(res.status).toBe(302);
    expect(mockFinalizeCardSale).not.toHaveBeenCalled();
    expect(res.headers['location']).toBe(PAGE);
  });

  it('302s to the result page even if finalize throws (never dead-ends the buyer)', async () => {
    mockFinalizeCardSale.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app).get('/api/public/purchase/peach-card/return?id=pay_boom');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(`${PAGE}?id=pay_boom`);
  });
});
