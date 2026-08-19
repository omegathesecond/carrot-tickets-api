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

describe('PaymentConfigService — Yoco', () => {
  it('defaults Yoco to OFF with a zero fee until it is switched on', async () => {
    const cfg = await PaymentConfigService.get();
    expect(cfg.yocoEnabled).toBe(false);
    expect(cfg.yocoServiceFee).toBe(0);
  });

  it('round-trips a Yoco toggle and fee through update()', async () => {
    const saved = await PaymentConfigService.update({ yocoEnabled: true, yocoServiceFee: 7.5 });
    expect(saved.yocoEnabled).toBe(true);
    expect(saved.yocoServiceFee).toBe(7.5);

    const reread = await PaymentConfigService.get();
    expect(reread.yocoEnabled).toBe(true);
    expect(reread.yocoServiceFee).toBe(7.5);
  });

  it('leaves untouched methods alone when updating one field', async () => {
    await PaymentConfigService.update({ yocoEnabled: true });
    const cfg = await PaymentConfigService.get();
    expect(cfg.yocoEnabled).toBe(true);
    expect(cfg.mtnMomoEnabled).toBe(true);    // still the default
    expect(cfg.peachCardEnabled).toBe(false); // still the default
  });
});

describe('PaymentConfigService — explicit zero must beat the default', () => {
  it('lets a saved 0 fee win over the non-zero momo default', async () => {
    // The whole point of `??` rather than `||`: a deliberate 0 must not
    // silently revert to the E5 momo default.
    await PaymentConfigService.update({ momoServiceFee: 0 });
    expect((await PaymentConfigService.get()).momoServiceFee).toBe(0);
  });
});
