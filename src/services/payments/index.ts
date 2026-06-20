import { PaymentMethod } from '@interfaces/ticket.interface';
import { PaymentProcessor } from './types';
import { CashProcessor } from './cash.processor';
import { KeshlessWalletProcessor } from './keshlessWallet.processor';

const processors: Record<string, PaymentProcessor> = {
  [PaymentMethod.CASH]: new CashProcessor(),
  [PaymentMethod.KESHLESS_WALLET]: new KeshlessWalletProcessor(),
};

export function getProcessor(method: PaymentMethod): PaymentProcessor {
  const p = processors[method];
  if (!p) throw new Error(`Unsupported payment method: ${method}`);
  return p;
}
export * from './types';
