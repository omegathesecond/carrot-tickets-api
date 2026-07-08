import { PaymentMethod } from '@interfaces/ticket.interface';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';

export class CardProcessor implements PaymentProcessor {
  method = PaymentMethod.PEACH_CARD;

  isConfigured() {
    return true;
  }

  // Card is async: TicketService.initiateCardPurchase drives Peach directly.
  // charge() must NEVER be reached via the synchronous sellTickets path — that
  // path treats non-failed as COMPLETED and would mint tickets without payment.
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    throw new Error('Card is async — use TicketService.initiateCardPurchase, not the synchronous charge path');
  }
}
