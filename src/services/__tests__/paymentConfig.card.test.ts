import { PaymentConfigService } from '@services/paymentConfig.service';
import { PaymentMethodConfig } from '@models/paymentMethodConfig.model';
jest.mock('@models/paymentMethodConfig.model');
describe('PaymentConfigService cardEnabled', () => {
  afterEach(() => jest.clearAllMocks());
  it('defaults cardEnabled false', async () => {
    (PaymentMethodConfig.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    expect((await PaymentConfigService.get()).cardEnabled).toBe(false);
  });
  it('reads cardEnabled from doc', async () => {
    (PaymentMethodConfig.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve({ cardEnabled: true }) });
    expect((await PaymentConfigService.get()).cardEnabled).toBe(true);
  });
});
