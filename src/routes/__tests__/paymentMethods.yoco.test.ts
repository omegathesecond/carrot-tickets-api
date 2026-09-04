// GET /api/public/payment-methods — Yoco visibility gating.
//
// The invariant under test: a method appears at checkout ONLY when BOTH the
// admin toggle is on AND the rail is fully credentialed. A half-configured
// deploy must HIDE the button rather than fail the buyer mid-purchase.

import request from 'supertest';

const yocoIsConfigured = jest.fn();
jest.mock('@services/payments/yoco.client', () => ({
  classifyEventType: jest.requireActual('@services/payments/yoco.client').classifyEventType,
  toCents: jest.requireActual('@services/payments/yoco.client').toCents,
  YocoClient: jest.fn().mockImplementation(() => ({ isConfigured: yocoIsConfigured })),
}));

jest.mock('@services/paymentConfig.service');

import app from '@/app';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';

const mockGet = PaymentConfigService.get as jest.MockedFunction<typeof PaymentConfigService.get>;

const baseCfg = {
  cashEnabled: true, mtnMomoEnabled: false, keshlessWalletEnabled: false,
  peachCardEnabled: false, deltapayEnabled: false, yocoEnabled: false,
  defaultResellerCommissionPercent: 0, platformFeePercent: 0,
  keshlessServiceFee: 0, momoServiceFee: 5, cardServiceFee: 10,
  deltapayServiceFee: 5, yocoServiceFee: 7,
  yebopayEnabled: false, yebopayServiceFee: 0,
  menuServiceFeePercent: 8,
};

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(() => jest.clearAllMocks());

describe('GET /api/public/payment-methods — Yoco', () => {
  it('offers Yoco when the toggle is on AND credentials are present', async () => {
    mockGet.mockResolvedValue({ ...baseCfg, yocoEnabled: true });
    yocoIsConfigured.mockReturnValue(true);

    const res = await request(app).get('/api/public/payment-methods');

    expect(res.status).toBe(200);
    expect(res.body.data.methods).toContain('yoco');
  });

  it('HIDES Yoco when the toggle is on but credentials are missing', async () => {
    mockGet.mockResolvedValue({ ...baseCfg, yocoEnabled: true });
    yocoIsConfigured.mockReturnValue(false);

    const res = await request(app).get('/api/public/payment-methods');

    expect(res.body.data.methods).not.toContain('yoco');
  });

  it('HIDES Yoco when credentials are present but the toggle is off', async () => {
    mockGet.mockResolvedValue({ ...baseCfg, yocoEnabled: false });
    yocoIsConfigured.mockReturnValue(true);

    const res = await request(app).get('/api/public/payment-methods');

    expect(res.body.data.methods).not.toContain('yoco');
  });

  it('publishes the Yoco service fee so checkout can show a live breakdown', async () => {
    mockGet.mockResolvedValue({ ...baseCfg, yocoEnabled: true });
    yocoIsConfigured.mockReturnValue(true);

    const res = await request(app).get('/api/public/payment-methods');

    expect(res.body.data.serviceFees.yoco).toBe(7);
  });
});
