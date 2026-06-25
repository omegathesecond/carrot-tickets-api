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

describe('POST /api/public/purchase/card/webhook', () => {
  it('returns 200 and calls finalizeCardSale when body contains { id }', async () => {
    const res = await request(app)
      .post('/api/public/purchase/card/webhook')
      .send({ id: 'pay_1' });

    expect(res.status).toBe(200);
    expect(mockFinalizeCardSale).toHaveBeenCalledWith('pay_1');
  });

  it('still returns 200 when finalizeCardSale rejects (never propagate errors to Peach)', async () => {
    mockFinalizeCardSale.mockRejectedValueOnce(new Error('DB blew up'));

    const res = await request(app)
      .post('/api/public/purchase/card/webhook')
      .send({ id: 'pay_err' });

    expect(res.status).toBe(200);
  });

  it('returns 200 and does not call finalizeCardSale for a Peach verification handshake', async () => {
    const res = await request(app)
      .post('/api/public/purchase/card/webhook')
      .send({ verificationCode: 'abc123' });

    expect(res.status).toBe(200);
    expect(mockFinalizeCardSale).not.toHaveBeenCalled();
  });
});
