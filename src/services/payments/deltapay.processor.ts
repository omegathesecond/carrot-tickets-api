import { PaymentMethod } from '@interfaces/ticket.interface';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';

export class DeltapayProcessor implements PaymentProcessor {
  method = PaymentMethod.DELTAPAY;

  isConfigured() {
    return true;
  }

  // DeltaPay is async (hosted-checkout redirect): TicketService.initiateDeltapayPurchase
  // drives the provider directly. charge() must NEVER be reached via the synchronous
  // sellTickets path — that path treats non-failed as COMPLETED and would mint
  // tickets without payment. Same rule as CardProcessor.
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    throw new Error(
      'DeltaPay is async — use TicketService.initiateDeltapayPurchase, not the synchronous charge path'
    );
  }
}
