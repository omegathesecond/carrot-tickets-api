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
 *
 * `subtotal` is integer minor units (cents), same convention as MenuItem.price —
 * math here must stay integer-cents (Math.round), NOT round2's 2-decimal
 * rounding, which would leave fractional cents on the stored order.
 */
export function computeMenuServiceFee(subtotal: number, percent: number): MenuServiceFeeBreakdown {
  if (subtotal <= 0) {
    return { serviceFeeAmount: 0, amountCharged: subtotal };
  }
  const serviceFeeAmount = Math.round(subtotal * ((percent || 0) / 100));
  return { serviceFeeAmount, amountCharged: subtotal + serviceFeeAmount };
}

/**
 * Convert an integer-cents amount to the major-unit decimal (E) the Keshless
 * wallet and MTN MoMo gateways expect — mirrors how ticket purchase already
 * charges `ticketType.price` (stored in major units) with no conversion.
 * Menu amounts are the only ones crossing from a cents-denominated model
 * (MenuItem.price) into those major-unit gateways.
 */
export function centsToMajorUnits(cents: number): number {
  return round2(cents / 100);
}
