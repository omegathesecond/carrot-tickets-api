import { round2 } from '@utils/serviceFee.util';

export interface MenuServiceFeeBreakdown {
  serviceFeeAmount: number;
  amountCharged: number; // subtotal + serviceFeeAmount — what the gateway charges
}

/**
 * Buyer-paid service charge for a Menu preorder — the fee for the convenience
 * of ordering bar/vendor items ahead through Carrot instead of queueing.
 * Unlike the per-ticket flat `serviceFee.util` fee, this is a PERCENTAGE of
 * the cart subtotal (a preorder can be anything from one drink to a full
 * round), configured via PaymentMethodConfig.menuServiceFeePercent.
 */
export function computeMenuServiceFee(subtotal: number, percent: number): MenuServiceFeeBreakdown {
  if (subtotal <= 0) {
    return { serviceFeeAmount: 0, amountCharged: round2(subtotal) };
  }
  const serviceFeeAmount = round2(subtotal * ((percent || 0) / 100));
  return { serviceFeeAmount, amountCharged: round2(subtotal + serviceFeeAmount) };
}
