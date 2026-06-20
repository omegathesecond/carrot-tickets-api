import { PaymentMethod } from '@interfaces/ticket.interface';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';
import { MtnMomoClient } from './mtnMomo.client';

export class MtnMomoProcessor implements PaymentProcessor {
  method = PaymentMethod.MTN_MOMO;
  private client = new MtnMomoClient();

  isConfigured() {
    return this.client.isConfigured();
  }

  // MoMo is async: TicketService.initiateMomoPurchase drives requestToPay directly.
  // charge() must NEVER be reached via the synchronous sellTickets path — that
  // path treats non-failed as COMPLETED and would mint tickets without payment.
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    throw new Error('MTN MoMo is async — use TicketService.initiateMomoPurchase, not the synchronous charge path');
  }
}
