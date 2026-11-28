import { PaymentMethod } from '@interfaces/ticket.interface';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';

/** Records money collected by the seller outside Carrot's payment gateways. */
export class ManualPaymentProcessor implements PaymentProcessor {
  constructor(public readonly method: PaymentMethod.CASH | PaymentMethod.POS_PAYMENT) {}
  isConfigured() { return true; }
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    return {
      status: 'completed',
      message: this.method === PaymentMethod.CASH ? 'Cash payment received' : 'POS payment recorded',
    };
  }
}
