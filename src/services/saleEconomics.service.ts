import type { PaymentMethod } from '@interfaces/ticket.interface';

export type FundsCustody = 'carrot' | 'reseller' | 'vendor';
export type SaleSoldByType = 'Vendor' | 'VendorSubUser' | 'ResellerOperator';

export interface SaleEconomicsInput {
  faceAmount: number;
  /**
   * Derived from the PaymentMethod enum's VALUES (not the enum type) so this
   * module stays decoupled at runtime and callers may still pass plain string
   * literals — while a new payment method automatically widens this union
   * instead of silently missing the custody rule below.
   */
  paymentMethod: `${PaymentMethod}`;
  soldByType: SaleSoldByType;
  resellerCommissionPercent: number;
  platformFeePercent: number;
  /**
   * Booking fee the ORGANIZER agreed to cover instead of the buyer (events
   * flagged `organizerAbsorbsServiceFee`). Already computed per-method and
   * per-ticket by computeServiceFee; here it is simply another deduction from
   * what the organizer takes home. Absent/0 on every ordinary sale, where the
   * buyer paid the fee on top of face and it never touched organizer money.
   */
  absorbedServiceFeeAmount?: number;
}

export interface SaleEconomics {
  faceAmount: number;
  resellerCommissionPercent: number;
  resellerCommissionAmount: number;
  platformFeePercent: number;
  platformFeeAmount: number;
  absorbedServiceFeeAmount: number;
  organizerProceeds: number;
  fundsCustody: FundsCustody;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeSaleEconomics(input: SaleEconomicsInput): SaleEconomics {
  const { faceAmount, paymentMethod, soldByType, resellerCommissionPercent, platformFeePercent } = input;

  const resellerCommissionAmount = round2(faceAmount * (resellerCommissionPercent / 100));
  const platformFeeAmount = round2(faceAmount * (platformFeePercent / 100));
  const absorbedServiceFeeAmount = round2(input.absorbedServiceFeeAmount ?? 0);
  const organizerProceeds = round2(
    faceAmount - resellerCommissionAmount - platformFeeAmount - absorbedServiceFeeAmount
  );

  let fundsCustody: FundsCustody;
  if (paymentMethod !== 'cash') {
    fundsCustody = 'carrot';
  } else if (soldByType === 'ResellerOperator') {
    fundsCustody = 'reseller';
  } else {
    fundsCustody = 'vendor';
  }

  return {
    faceAmount, resellerCommissionPercent, resellerCommissionAmount,
    platformFeePercent, platformFeeAmount, absorbedServiceFeeAmount,
    organizerProceeds, fundsCustody,
  };
}
