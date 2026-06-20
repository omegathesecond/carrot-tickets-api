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
  // charge() exists for interface symmetry but is not used in the synchronous sellTickets path.
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    return { status: 'pending', message: 'MTN MoMo is processed asynchronously' };
  }
}
