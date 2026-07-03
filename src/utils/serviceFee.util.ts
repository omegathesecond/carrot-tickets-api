import { PaymentMethod } from '@interfaces/ticket.interface';

/**
 * Buyer-paid service fee — a FLAT amount (in E) added ON TOP of the ticket
 * subtotal at online checkout, varying per payment method. Single source of
 * truth for the fee math; the checkout UI mirrors it so the amount displayed
 * always equals the amount charged.
 *
 * Distinct from platformFeePercent, which is a payout deduction the organizer
 * absorbs. Service fees apply to ONLINE sales only; POS / reseller stay at face.
 */
export interface ServiceFeeConfig {
  keshlessServiceFee: number;
  momoServiceFee: number;
  cardServiceFee: number;
}

/** Round to 2 decimals (cents), guarding against binary-float drift. */
export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** The configured flat fee for a method (0 for cash / anything without a fee). */
export function serviceFeeFor(method: PaymentMethod, cfg: ServiceFeeConfig): number {
  switch (method) {
    case PaymentMethod.KESHLESS_WALLET:
      return cfg.keshlessServiceFee || 0;
    case PaymentMethod.MTN_MOMO:
      return cfg.momoServiceFee || 0;
    case PaymentMethod.CARD:
      return cfg.cardServiceFee || 0;
    default:
      return 0;
  }
}

export interface ServiceFeeBreakdown {
  serviceFeeAmount: number;
  amountCharged: number; // subtotal + serviceFeeAmount — what the gateway charges
}

/** Compute the fee + total charged for a subtotal + method. */
export function computeServiceFee(
  subtotal: number,
  method: PaymentMethod,
  cfg: ServiceFeeConfig
): ServiceFeeBreakdown {
  const serviceFeeAmount = round2(serviceFeeFor(method, cfg));
  return { serviceFeeAmount, amountCharged: round2(subtotal + serviceFeeAmount) };
}
