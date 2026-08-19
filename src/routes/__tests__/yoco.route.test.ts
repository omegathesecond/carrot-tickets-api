// src/routes/__tests__/yoco.route.test.ts
//
// Tests for the Yoco webhook + return routes.
//
// The webhook is the ONLY path that can mint a Yoco ticket — Yoco has no
// status-query endpoint, so there is no second opinion to fall back on. These
// tests therefore focus hard on the signature boundary: an unsigned, wrongly
// signed, or replayed body must never reach finalizeYocoSale.

import request from 'supertest';
import crypto from 'crypto';

const SECRET = 'whsec_' + Buffer.from('test-signing-key').toString('base64');
process.env['YOCO_WEBHOOK_SECRET'] = SECRET;

// Mock TicketService so we don't need a live DB.
jest.mock('@services/ticket.service');

import app from '@/app';
import { TicketService } from '@services/ticket.service';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';

const mockFinalize = TicketService.finalizeYocoSale as jest.MockedFunction<
  typeof TicketService.finalizeYocoSale
>;
const mockGetByRef = TicketService.getYocoSaleByRef as jest.MockedFunction<
  typeof TicketService.getYocoSaleByRef
>;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(() => {
  jest.clearAllMocks();
  mockFinalize.mockResolvedValue({ status: 'completed' });
  mockGetByRef.mockResolvedValue(null);
});

/** POST a body with a valid Standard-Webhooks signature. */
function signedPost(body: unknown, opts?: { secret?: string; timestamp?: string }) {
  const raw = JSON.stringify(body);
  const id = 'msg_test';
  const ts = opts?.timestamp ?? String(Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts?.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return request(app)
    .post('/api/public/purchase/yoco/webhook')
    .set('webhook-id', id)
    .set('webhook-timestamp', ts)
    .set('webhook-signature', `v1,${sig}`)
    .set('Content-Type', 'application/json')
    .send(raw);
}

const succeeded = {
  id: 'evt_1',
  type: 'payment.succeeded',
  payload: { id: 'p_1', amount: 5000, currency: 'ZAR', metadata: { checkoutId: 'ch_1' } },
};

describe('POST /api/public/purchase/yoco/webhook', () => {
  it('finalises a correctly signed payment.succeeded', async () => {
    const res = await signedPost(succeeded);

    expect(res.status).toBe(200);
    expect(mockFinalize).toHaveBeenCalledWith('ch_1', {
      type: 'payment.succeeded',
      amountCents: 5000,
      currency: 'ZAR',
    });
  });

  it('REJECTS an unsigned body — the request must never reach the finalizer', async () => {
    const res = await request(app)
      .post('/api/public/purchase/yoco/webhook')
      .send(succeeded);

    expect(res.status).toBe(401);
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('REJECTS a body signed with the wrong secret', async () => {
    const wrong = 'whsec_' + Buffer.from('attacker-key').toString('base64');
    const res = await signedPost(succeeded, { secret: wrong });

    expect(res.status).toBe(401);
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('REJECTS a replayed payload outside the timestamp window', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await signedPost(succeeded, { timestamp: stale });

    expect(res.status).toBe(401);
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('acknowledges a signed event that carries no checkoutId without finalising', async () => {
    const res = await signedPost({
      id: 'evt_2', type: 'payment.succeeded',
      payload: { id: 'p_2', amount: 5000, currency: 'ZAR', metadata: {} },
    });

    expect(res.status).toBe(200);
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('passes payment.failed through to the finalizer', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'failed' });
    const res = await signedPost({
      id: 'evt_3', type: 'payment.failed',
      payload: { id: 'p_3', amount: 5000, currency: 'ZAR', metadata: { checkoutId: 'ch_3' } },
    });

    expect(res.status).toBe(200);
    expect(mockFinalize).toHaveBeenCalledWith('ch_3', expect.objectContaining({ type: 'payment.failed' }));
  });

  it('still returns 200 when the finalizer rejects (never retry-storm Yoco)', async () => {
    mockFinalize.mockRejectedValueOnce(new Error('DB blew up'));
    const res = await signedPost(succeeded);

    expect(res.status).toBe(200);
  });
});

describe('Yoco return redirect', () => {
  const PAGE = 'https://carrottickets.com/payment-result';

  it('302s to the SPA result page carrying the checkout id and method', async () => {
    mockGetByRef.mockResolvedValueOnce({
      yocoCheckoutId: 'ch_9', paymentStatus: 'pending',
    } as any);

    const res = await request(app).get('/api/public/purchase/yoco/return?ref=TKT-9&outcome=success');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(`${PAGE}?id=ch_9&status=pending&method=yoco`);
  });

  it('NEVER finalises from the return redirect — only the signed webhook may mint', async () => {
    mockGetByRef.mockResolvedValueOnce({
      yocoCheckoutId: 'ch_9', paymentStatus: 'pending',
    } as any);

    const res = await request(app).get('/api/public/purchase/yoco/return?ref=TKT-9&outcome=success');

    // Assert the route actually handled it — without this the test would pass
    // vacuously against a 404, i.e. it would not notice the route disappearing.
    expect(res.status).toBe(302);
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('reports the sale as failed when the buyer cancelled and nothing has been paid', async () => {
    mockGetByRef.mockResolvedValueOnce({
      yocoCheckoutId: 'ch_c', paymentStatus: 'failed',
    } as any);

    const res = await request(app).get('/api/public/purchase/yoco/return?ref=TKT-C&outcome=cancel');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(`${PAGE}?id=ch_c&status=failed&method=yoco`);
  });

  it('302s to the bare result page when no ref is supplied', async () => {
    const res = await request(app).get('/api/public/purchase/yoco/return');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(PAGE);
  });

  it('302s to the bare result page when the ref matches no sale', async () => {
    const res = await request(app).get('/api/public/purchase/yoco/return?ref=TKT-NOPE');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(PAGE);
  });
});
