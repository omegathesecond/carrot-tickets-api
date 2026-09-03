import { computeServiceFee, serviceFeeFor, MAX_TICKETS_PER_ORDER } from '@utils/serviceFee.util';
import { PaymentMethod } from '@interfaces/ticket.interface';

const cfg = { keshlessServiceFee: 0, momoServiceFee: 5, cardServiceFee: 10, deltapayServiceFee: 5, yocoServiceFee: 0, yebopayServiceFee: 10 };

describe('serviceFeeFor', () => {
  it('returns the configured per-ticket amount per method', () => {
    expect(serviceFeeFor(PaymentMethod.MTN_MOMO, cfg)).toBe(5);
    expect(serviceFeeFor(PaymentMethod.PEACH_CARD, cfg)).toBe(10);
    expect(serviceFeeFor(PaymentMethod.KESHLESS_WALLET, cfg)).toBe(0);
    expect(serviceFeeFor(PaymentMethod.DELTAPAY, cfg)).toBe(5);
  });
});

describe('computeServiceFee — per ticket', () => {
  it('multiplies the per-method fee by quantity (momo)', () => {
    expect(computeServiceFee(100, 1, PaymentMethod.MTN_MOMO, cfg)).toEqual({ serviceFeeAmount: 5, amountCharged: 105, absorbedServiceFeeAmount: 0 });
    expect(computeServiceFee(200, 2, PaymentMethod.MTN_MOMO, cfg)).toEqual({ serviceFeeAmount: 10, amountCharged: 210, absorbedServiceFeeAmount: 0 });
  });

  it('multiplies the per-method fee by quantity (card)', () => {
    expect(computeServiceFee(300, 3, PaymentMethod.PEACH_CARD, cfg)).toEqual({ serviceFeeAmount: 30, amountCharged: 330, absorbedServiceFeeAmount: 0 });
  });

  it('multiplies the per-method fee by quantity (deltapay)', () => {
    expect(computeServiceFee(150, 2, PaymentMethod.DELTAPAY, cfg)).toEqual({ serviceFeeAmount: 10, amountCharged: 160, absorbedServiceFeeAmount: 0 });
  });

  it('is zero for a zero-fee method regardless of quantity (wallet)', () => {
    expect(computeServiceFee(50, 4, PaymentMethod.KESHLESS_WALLET, cfg)).toEqual({ serviceFeeAmount: 0, amountCharged: 50, absorbedServiceFeeAmount: 0 });
  });

  it('charges NO fee for a free ticket (subtotal 0) on any paid method', () => {
    expect(computeServiceFee(0, 1, PaymentMethod.MTN_MOMO, cfg)).toEqual({ serviceFeeAmount: 0, amountCharged: 0, absorbedServiceFeeAmount: 0 });
    expect(computeServiceFee(0, 3, PaymentMethod.PEACH_CARD, cfg)).toEqual({ serviceFeeAmount: 0, amountCharged: 0, absorbedServiceFeeAmount: 0 });
    expect(computeServiceFee(0, 2, PaymentMethod.DELTAPAY, cfg)).toEqual({ serviceFeeAmount: 0, amountCharged: 0, absorbedServiceFeeAmount: 0 });
  });

  it('rounds the multiplied fee to 2 decimals', () => {
    const frac = { keshlessServiceFee: 0, momoServiceFee: 0.1, cardServiceFee: 0, deltapayServiceFee: 0, yocoServiceFee: 0, yebopayServiceFee: 0 };
    // 0.1 * 3 = 0.30000000000000004 in float — must round to 0.3
    expect(computeServiceFee(10, 3, PaymentMethod.MTN_MOMO, frac)).toEqual({ serviceFeeAmount: 0.3, amountCharged: 10.3, absorbedServiceFeeAmount: 0 });
  });
});

describe('MAX_TICKETS_PER_ORDER', () => {
  it('is 10', () => {
    expect(MAX_TICKETS_PER_ORDER).toBe(10);
  });
});

describe('serviceFeeFor — Yoco', () => {
  it('returns the configured Yoco fee', () => {
    expect(serviceFeeFor(PaymentMethod.YOCO, { ...cfg, yocoServiceFee: 7 })).toBe(7);
  });
});

describe('computeServiceFee — organizer absorbs the fee', () => {
  it('charges the buyer face only, and records the fee as organizer-absorbed', () => {
    expect(computeServiceFee(100, 1, PaymentMethod.MTN_MOMO, cfg, { absorbedByOrganizer: true }))
      .toEqual({ serviceFeeAmount: 0, amountCharged: 100, absorbedServiceFeeAmount: 5 });
  });

  it('scales the absorbed fee by quantity and method', () => {
    expect(computeServiceFee(300, 3, PaymentMethod.PEACH_CARD, cfg, { absorbedByOrganizer: true }))
      .toEqual({ serviceFeeAmount: 0, amountCharged: 300, absorbedServiceFeeAmount: 30 });
  });

  it('absorbs nothing on a free ticket — there is no fee to move', () => {
    expect(computeServiceFee(0, 2, PaymentMethod.MTN_MOMO, cfg, { absorbedByOrganizer: true }))
      .toEqual({ serviceFeeAmount: 0, amountCharged: 0, absorbedServiceFeeAmount: 0 });
  });

  it('lets a waived allocation tier win — nobody pays, not even the organizer', () => {
    expect(computeServiceFee(100, 2, PaymentMethod.MTN_MOMO, cfg, { absorbedByOrganizer: true, waiveServiceFee: true }))
      .toEqual({ serviceFeeAmount: 0, amountCharged: 100, absorbedServiceFeeAmount: 0 });
  });

  it('absorbs nothing by default — the buyer keeps paying the fee', () => {
    expect(computeServiceFee(100, 1, PaymentMethod.MTN_MOMO, cfg))
      .toEqual({ serviceFeeAmount: 5, amountCharged: 105, absorbedServiceFeeAmount: 0 });
  });
});
