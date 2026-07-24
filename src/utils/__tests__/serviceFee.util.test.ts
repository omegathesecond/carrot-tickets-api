import { computeServiceFee, serviceFeeFor, round2, MAX_TICKETS_PER_ORDER } from '@utils/serviceFee.util';
import { PaymentMethod } from '@interfaces/ticket.interface';

const cfg = { keshlessServiceFee: 0, momoServiceFee: 5, cardServiceFee: 10 };

describe('serviceFeeFor', () => {
  it('returns the configured per-ticket amount per method', () => {
    expect(serviceFeeFor(PaymentMethod.MTN_MOMO, cfg)).toBe(5);
    expect(serviceFeeFor(PaymentMethod.PEACH_CARD, cfg)).toBe(10);
    expect(serviceFeeFor(PaymentMethod.KESHLESS_WALLET, cfg)).toBe(0);
  });
});

describe('computeServiceFee — per ticket', () => {
  it('multiplies the per-method fee by quantity (momo)', () => {
    expect(computeServiceFee(100, 1, PaymentMethod.MTN_MOMO, cfg)).toEqual({ serviceFeeAmount: 5, amountCharged: 105 });
    expect(computeServiceFee(200, 2, PaymentMethod.MTN_MOMO, cfg)).toEqual({ serviceFeeAmount: 10, amountCharged: 210 });
  });

  it('multiplies the per-method fee by quantity (card)', () => {
    expect(computeServiceFee(300, 3, PaymentMethod.PEACH_CARD, cfg)).toEqual({ serviceFeeAmount: 30, amountCharged: 330 });
  });

  it('is zero for a zero-fee method regardless of quantity (wallet)', () => {
    expect(computeServiceFee(50, 4, PaymentMethod.KESHLESS_WALLET, cfg)).toEqual({ serviceFeeAmount: 0, amountCharged: 50 });
  });

  it('rounds the multiplied fee to 2 decimals', () => {
    const frac = { keshlessServiceFee: 0, momoServiceFee: 0.1, cardServiceFee: 0 };
    // 0.1 * 3 = 0.30000000000000004 in float — must round to 0.3
    expect(computeServiceFee(10, 3, PaymentMethod.MTN_MOMO, frac)).toEqual({ serviceFeeAmount: 0.3, amountCharged: 10.3 });
  });
});

describe('MAX_TICKETS_PER_ORDER', () => {
  it('is 10', () => {
    expect(MAX_TICKETS_PER_ORDER).toBe(10);
  });
});
