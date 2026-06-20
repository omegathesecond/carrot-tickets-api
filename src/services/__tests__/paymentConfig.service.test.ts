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
  it('returns defaults (both online methods on) when no doc exists', async () => {
    const cfg = await PaymentConfigService.get();
    expect(cfg.keshlessWalletEnabled).toBe(true);
    expect(cfg.mtnMomoEnabled).toBe(true);
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
});
