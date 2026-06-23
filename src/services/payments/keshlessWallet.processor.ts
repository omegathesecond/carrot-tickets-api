import { PaymentMethod } from '@interfaces/ticket.interface';
import { KeshlessPaymentService } from '@services/keshlessPayment.service';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';

export class KeshlessWalletProcessor implements PaymentProcessor {
  method = PaymentMethod.KESHLESS_WALLET;
  isConfigured() { return true; }
  async charge(input: ChargeInput): Promise<ChargeResult> {
    if (!input.keshlessCardNumber) {
      return { status: 'failed', message: 'Card number is required for Keshless wallet payment', error: 'missing_card' };
    }
    const result = await KeshlessPaymentService.acceptPayment({
      cardNumber: input.keshlessCardNumber,
      amount: input.amount,
      pin: input.keshlessPin,
      description: input.description,
    });
    if (result.status === 'failed') {
      return { status: 'failed', message: result.message || result.error || 'Payment failed', error: result.error };
    }
    return { status: 'completed', providerRef: result.transactionId, message: result.message || 'Wallet payment successful' };
  }
}
