import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { PaymentConfigService } from '@services/paymentConfig.service';

beforeAll(async () => {
  await connectTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('PaymentConfigService.get', () => {
  it('returns defaults (mtnMomo on, keshless off) when no doc exists', async () => {
    const cfg = await PaymentConfigService.get();
    expect(cfg.keshlessWalletEnabled).toBe(false);
    expect(cfg.mtnMomoEnabled).toBe(true);
  });

  it('defaults: cash on, keshless off, fee 0, default commission 0', async () => {
    const cfg = await PaymentConfigService.get();
    expect(cfg.cashEnabled).toBe(true);
    expect(cfg.keshlessWalletEnabled).toBe(false);
    expect(cfg.platformFeePercent).toBe(0);
    expect(cfg.defaultResellerCommissionPercent).toBe(0);
  });
});

describe('PaymentConfigService.update', () => {
  it('creates config doc and returns updated values', async () => {
    const cfg = await PaymentConfigService.update({ keshlessWalletEnabled: false });
    expect(cfg.keshlessWalletEnabled).toBe(false);
    expect(cfg.mtnMomoEnabled).toBe(true);
  });

  it('updates an existing config doc', async () => {
    await PaymentConfigService.update({ mtnMomoEnabled: false });
    const cfg = await PaymentConfigService.get();
    expect(cfg.mtnMomoEnabled).toBe(false);
  });

  it('persists updated rates', async () => {
    await PaymentConfigService.update({ defaultResellerCommissionPercent: 8, platformFeePercent: 5, keshlessWalletEnabled: false });
    const cfg = await PaymentConfigService.get();
    expect(cfg.defaultResellerCommissionPercent).toBe(8);
    expect(cfg.platformFeePercent).toBe(5);
  });
});
