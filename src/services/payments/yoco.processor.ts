import { PaymentMethod } from '@interfaces/ticket.interface';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';

export class YocoProcessor implements PaymentProcessor {
  method = PaymentMethod.YOCO;

  isConfigured() {
    return true;
  }

  // Yoco is async (hosted-checkout redirect): TicketService.initiateYocoPurchase
  // drives the provider directly. charge() must NEVER be reached via the synchronous
  // sellTickets path — that path treats non-failed as COMPLETED and would mint
  // tickets without payment. Same rule as CardProcessor / DeltapayProcessor.
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    throw new Error(
      'Yoco is async — use TicketService.initiateYocoPurchase, not the synchronous charge path'
    );
  }
}
