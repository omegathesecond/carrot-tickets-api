import { PaymentMethod } from '@interfaces/ticket.interface';

export type EventCurrency = 'SZL' | 'ZAR';

/** The two display currencies an organizer may pick for an event. */
export const EVENT_CURRENCIES: readonly EventCurrency[] = ['SZL', 'ZAR'] as const;

/**
 * The currency a payment rail natively settles in. Card (Peach) settles in ZAR;
 * every other rail (MoMo, DeltaPay, Keshless wallet, cash/POS) settles in SZL.
 * This is what the existing MoMo/card verify guards already assert — we only
 * persist it per sale, we do NOT change what the guards check.
 */
export function settlementCurrencyForMethod(method: PaymentMethod): EventCurrency {
  return method === PaymentMethod.PEACH_CARD ? 'ZAR' : 'SZL';
}
