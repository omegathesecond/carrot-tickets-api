// src/routes/__tests__/deltapay.route.test.ts
//
// Tests for the DeltaPay session-callback and return routes.
// Mirrors card.route.test.ts: mock the client BEFORE importing app, then drive
// the real Express app with supertest.

import request from 'supertest';

// Mock DeltapayClient BEFORE importing app (app → deltapay.route →
// deltapay.controller → TicketService → DeltapayClient).
jest.mock('@services/payments/deltapay.client', () => ({
  DeltapayClient: jest.fn().mockImplementation(() => ({
    isConfigured: jest.fn().mockReturnValue(false),
    createSession: jest.fn(),
    verifySession: jest.fn(),
  })),
  classifySessionStatus: jest.requireActual('@services/payments/deltapay.client')
    .classifySessionStatus,
}));

// Mock TicketService so we don't need a live DB.
jest.mock('@services/ticket.service');

import app from '@/app';
import { TicketService } from '@services/ticket.service';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';

const mockFinalize = TicketService.finalizeDeltapaySale as jest.MockedFunction<
  typeof TicketService.finalizeDeltapaySale
>;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(() => {
  jest.clearAllMocks();
  mockFinalize.mockResolvedValue({ status: 'completed' });
});

describe('POST /api/public/purchase/deltapay/callback', () => {
  it('returns 200 and finalises when the body carries checkout_session_id', async () => {
    const res = await request(app)
      .post('/api/public/purchase/deltapay/callback')
      .send({ checkout_session_id: 'sess_1' });

    expect(res.status).toBe(200);
    expect(mockFinalize).toHaveBeenCalledWith('sess_1');
  });

  it('still returns 200 when finalise rejects (never propagate errors to DeltaPay)', async () => {
    mockFinalize.mockRejectedValueOnce(new Error('DB blew up'));

    const res = await request(app)
      .post('/api/public/purchase/deltapay/callback')
      .send({ checkout_session_id: 'sess_err' });

    expect(res.status).toBe(200);
  });

  it('returns 200 without finalising when the body has no session id', async () => {
    const res = await request(app).post('/api/public/purchase/deltapay/callback').send({});

    expect(res.status).toBe(200);
    expect(mockFinalize).not.toHaveBeenCalled();
  });
});

describe('DeltaPay return endpoint', () => {
  const PAGE = 'https://carrottickets.com/payment-result';
  const METHOD = '&method=deltapay';

  it('finalises server-side and 302s to the result page with id + outcome', async () => {
    const res = await request(app).get(
      '/api/public/purchase/deltapay/return?checkout_session_id=sess_ok'
    );

    expect(res.status).toBe(302);
    expect(mockFinalize).toHaveBeenCalledWith('sess_ok');
    expect(res.headers['location']).toBe(`${PAGE}?id=sess_ok&status=completed${METHOD}`);
  });

  it('carries a failed outcome through to the page', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'failed' });

    const res = await request(app).get(
      '/api/public/purchase/deltapay/return?checkout_session_id=sess_bad'
    );

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(`${PAGE}?id=sess_bad&status=failed${METHOD}`);
  });

  it('302s to the bare result page when no session id is present', async () => {
    const res = await request(app).get('/api/public/purchase/deltapay/return');

    expect(res.status).toBe(302);
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(res.headers['location']).toBe(PAGE);
  });

  it('302s with the id but no status seed if finalise throws (page falls back to polling)', async () => {
    mockFinalize.mockRejectedValueOnce(new Error('DB down'));

    const res = await request(app).get(
      '/api/public/purchase/deltapay/return?checkout_session_id=sess_boom'
    );

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(`${PAGE}?id=sess_boom${METHOD}`);
  });
});
