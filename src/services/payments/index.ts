import { PaymentMethod } from '@interfaces/ticket.interface';
import { PaymentProcessor } from './types';
import { CashProcessor } from './cash.processor';
import { KeshlessWalletProcessor } from './keshlessWallet.processor';
import { MtnMomoProcessor } from './mtnMomo.processor';
import { CardProcessor } from './card.processor';
import { DeltapayProcessor } from './deltapay.processor';
import { YocoProcessor } from './yoco.processor';

const processors: Record<string, PaymentProcessor> = {
  [PaymentMethod.CASH]: new CashProcessor(),
  [PaymentMethod.KESHLESS_WALLET]: new KeshlessWalletProcessor(),
  [PaymentMethod.MTN_MOMO]: new MtnMomoProcessor(),
  [PaymentMethod.PEACH_CARD]: new CardProcessor(),
  [PaymentMethod.DELTAPAY]: new DeltapayProcessor(),
  [PaymentMethod.YOCO]: new YocoProcessor(),
};

export function getProcessor(method: PaymentMethod): PaymentProcessor {
  const p = processors[method];
  if (!p) throw new Error(`Unsupported payment method: ${method}`);
  return p;
}
export * from './types';
