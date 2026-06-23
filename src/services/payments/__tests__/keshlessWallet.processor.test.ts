import { KeshlessWalletProcessor } from '@services/payments/keshlessWallet.processor';
import { KeshlessPaymentService } from '@services/keshlessPayment.service';
import { PaymentMethod } from '@interfaces/ticket.interface';

jest.mock('@services/keshlessPayment.service');

describe('KeshlessWalletProcessor.charge', () => {
  it('returns completed + providerRef when the keshless API accepts', async () => {
    (KeshlessPaymentService.acceptPayment as jest.Mock).mockResolvedValue({
      status: 'completed', transactionId: 'TX1', message: 'ok'
    });
    const p = new KeshlessWalletProcessor();
    const r = await p.charge({ method: PaymentMethod.KESHLESS_WALLET, amount: 100, description: 'd', keshlessCardNumber: 'ABCD1234', keshlessPin: '1234' });
    expect(r.status).toBe('completed');
    expect(r.providerRef).toBe('TX1');
  });
  it('returns failed when the keshless API rejects', async () => {
    (KeshlessPaymentService.acceptPayment as jest.Mock).mockResolvedValue({
      status: 'failed', error: 'Insufficient balance', message: 'Insufficient balance...'
    });
    const p = new KeshlessWalletProcessor();
    const r = await p.charge({ method: PaymentMethod.KESHLESS_WALLET, amount: 100, description: 'd', keshlessCardNumber: 'ABCD1234' });
    expect(r.status).toBe('failed');
  });
  it('fails fast when card number missing', async () => {
    const p = new KeshlessWalletProcessor();
    const r = await p.charge({ method: PaymentMethod.KESHLESS_WALLET, amount: 100, description: 'd' });
    expect(r.status).toBe('failed');
  });
});
