import { PaymentConfigService } from '@services/paymentConfig.service';
import { PaymentMethodConfig } from '@models/paymentMethodConfig.model';
jest.mock('@models/paymentMethodConfig.model');
describe('PaymentConfigService peachCardEnabled', () => {
  afterEach(() => jest.clearAllMocks());
  it('defaults peachCardEnabled false', async () => {
    (PaymentMethodConfig.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    expect((await PaymentConfigService.get()).peachCardEnabled).toBe(false);
  });
  it('reads peachCardEnabled from doc', async () => {
    (PaymentMethodConfig.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve({ peachCardEnabled: true }) });
    expect((await PaymentConfigService.get()).peachCardEnabled).toBe(true);
  });
});
