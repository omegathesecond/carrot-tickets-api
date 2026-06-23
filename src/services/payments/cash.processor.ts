import { PaymentMethod } from '@interfaces/ticket.interface';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';

export class CashProcessor implements PaymentProcessor {
  method = PaymentMethod.CASH;
  isConfigured() { return true; }
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    return { status: 'completed', message: 'Cash payment received' };
  }
}
