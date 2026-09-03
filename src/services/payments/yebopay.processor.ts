import { PaymentMethod } from '@interfaces/ticket.interface';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';

export class YeboPayProcessor implements PaymentProcessor {
  method = PaymentMethod.YEBOPAY;

  isConfigured() {
    return true;
  }

  // YeboPay is async (hosted-checkout redirect): TicketService.initiateYeboPayPurchase
  // drives the provider directly. charge() must NEVER be reached via the synchronous
  // sellTickets path — that path treats non-failed as COMPLETED and would mint
  // tickets without payment. Same rule as CardProcessor / DeltapayProcessor / YocoProcessor.
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    throw new Error(
      'YeboPay is async — use TicketService.initiateYeboPayPurchase, not the synchronous charge path'
    );
  }
}
