import { PaymentMethod } from '@interfaces/ticket.interface';

/**
 * Buyer-paid service fee — a PER-TICKET amount (in E) added ON TOP of the
 * ticket subtotal at online checkout, varying per payment method. The buyer
 * pays the configured method fee for EACH ticket in the order (fee × quantity).
 * Single source of truth for the fee math; the checkout UI mirrors it
 * (landing src/lib/pricing.ts) so the amount displayed equals the amount charged.
 *
 * Distinct from platformFeePercent, which is a payout deduction the organizer
 * absorbs. Service fees apply to ONLINE sales only; POS / reseller stay at face.
 */
export interface ServiceFeeConfig {
  keshlessServiceFee: number;
  momoServiceFee: number;
  cardServiceFee: number;
  deltapayServiceFee: number;
  yocoServiceFee: number;
  yebopayServiceFee: number;
}

/** Hard cap on tickets a buyer may purchase in a single online order. */
export const MAX_TICKETS_PER_ORDER = 10;

/** Round to 2 decimals (cents), guarding against binary-float drift. */
export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Integer CENTS from a decimal amount. Guards binary-float drift
 * (80.7 * 100 = 8069.999…).
 *
 * Lives here rather than in a provider client because more than one rail needs
 * it: Yoco sends cents on the wire, and the YeboPay rail normalises YeboPay's
 * DECIMAL amounts to cents purely to compare them safely — float equality on
 * "150.0000" vs 150 is a trap worth designing out.
 */
export function toCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100);
}

/** The configured PER-TICKET fee for a method (0 for cash / anything without a fee). */
export function serviceFeeFor(method: PaymentMethod, cfg: ServiceFeeConfig): number {
  switch (method) {
    case PaymentMethod.KESHLESS_WALLET:
      return cfg.keshlessServiceFee || 0;
    case PaymentMethod.MTN_MOMO:
      return cfg.momoServiceFee || 0;
    case PaymentMethod.PEACH_CARD:
      return cfg.cardServiceFee || 0;
    case PaymentMethod.DELTAPAY:
      return cfg.deltapayServiceFee || 0;
    case PaymentMethod.YOCO:
      return cfg.yocoServiceFee || 0;
    case PaymentMethod.YEBOPAY:
      return cfg.yebopayServiceFee || 0;
    default:
      return 0;
  }
}

export interface ServiceFeeBreakdown {
  serviceFeeAmount: number;
  amountCharged: number; // subtotal + serviceFeeAmount — what the gateway charges
  /**
   * The fee the ORGANIZER owes on this sale. Non-zero only when the event is
   * flagged `organizerAbsorbsServiceFee`: the buyer is charged face, and this
   * amount is deducted from organizerProceeds at settlement instead. It is
   * Carrot revenue either way — only the payer changes.
   */
  absorbedServiceFeeAmount: number;
}

/** Compute the fee + total charged for a subtotal + method + ticket quantity.
 *
 *  Two independent overrides, deliberately different in who ends up paying:
 *  - `opts.waiveServiceFee` (allocation tiers) — NOBODY pays. The fee simply
 *    does not exist; Carrot earns nothing on the reseller's pre-bought block.
 *  - `opts.absorbedByOrganizer` (event-level) — the ORGANIZER pays. The buyer
 *    is charged exactly face, and the same per-method fee is booked against
 *    the organizer's proceeds.
 *
 *  Waiving wins when both are set: a tier that was sold with no fee attached
 *  must not quietly generate a bill for the organizer after the fact.
 */
export function computeServiceFee(
  subtotal: number,
  quantity: number,
  method: PaymentMethod,
  cfg: ServiceFeeConfig,
  opts: { waiveServiceFee?: boolean; absorbedByOrganizer?: boolean } = {}
): ServiceFeeBreakdown {
  // A free ticket (subtotal 0) carries NO service fee, on any method — there's
  // nothing to book, so there's nothing to surcharge. Charging a fee would turn
  // a "Free" ticket into a paid one, which is exactly what we don't want. That
  // holds for the organizer too: absorbing a fee on a free ticket would bill
  // them for giving something away.
  if (subtotal <= 0) {
    return { serviceFeeAmount: 0, amountCharged: round2(subtotal), absorbedServiceFeeAmount: 0 };
  }
  const fee = opts.waiveServiceFee ? 0 : round2(serviceFeeFor(method, cfg) * quantity);
  if (opts.absorbedByOrganizer) {
    return { serviceFeeAmount: 0, amountCharged: round2(subtotal), absorbedServiceFeeAmount: fee };
  }
  return { serviceFeeAmount: fee, amountCharged: round2(subtotal + fee), absorbedServiceFeeAmount: 0 };
}
