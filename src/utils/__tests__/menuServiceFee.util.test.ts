import { computeMenuServiceFee, centsToMajorUnits } from '@utils/menuServiceFee.util';

/**
 * The Menu preorder money path has two rules that fail silently rather than
 * loudly if they regress, so they are pinned here:
 *
 *  1. The Carrot service charge is a PERCENTAGE of the cart subtotal (the fee
 *     for ordering ahead instead of queueing), not the flat per-ticket booking
 *     fee in serviceFee.util — and it must land on whole cents.
 *  2. MenuItem.price is stored in cents, but the Keshless wallet and MTN MoMo
 *     gateways are charged in major units (E). Getting that seam wrong charges
 *     100x or 1/100x without throwing anything.
 */
describe('computeMenuServiceFee', () => {
  it('adds the configured percentage of the subtotal on top of it', () => {
    expect(computeMenuServiceFee(10_000, 10)).toEqual({ serviceFeeAmount: 1_000, amountCharged: 11_000 });
    expect(computeMenuServiceFee(4_500, 10)).toEqual({ serviceFeeAmount: 450, amountCharged: 4_950 });
  });

  it('rounds the fee to whole cents rather than storing a fractional cent', () => {
    // 4500 * 7.5% = 337.5 cents
    const { serviceFeeAmount, amountCharged } = computeMenuServiceFee(4_500, 7.5);
    expect(serviceFeeAmount).toBe(338);
    expect(amountCharged).toBe(4_838);
    expect(Number.isInteger(computeMenuServiceFee(3_333, 12.5).serviceFeeAmount)).toBe(true);
  });

  it('charges the buyer only the subtotal when the event has the fee switched off', () => {
    expect(computeMenuServiceFee(10_000, 0)).toEqual({ serviceFeeAmount: 0, amountCharged: 10_000 });
  });

  it('treats a missing percent as no fee instead of NaN-ing the charge', () => {
    expect(computeMenuServiceFee(10_000, undefined as unknown as number)).toEqual({
      serviceFeeAmount: 0,
      amountCharged: 10_000,
    });
  });

  it('never invents a fee on an empty or non-positive cart', () => {
    expect(computeMenuServiceFee(0, 10)).toEqual({ serviceFeeAmount: 0, amountCharged: 0 });
    expect(computeMenuServiceFee(-100, 10)).toEqual({ serviceFeeAmount: 0, amountCharged: -100 });
  });

  it('is a percentage of the cart, so it scales with the order size', () => {
    const one = computeMenuServiceFee(4_500, 10).serviceFeeAmount;
    const round = computeMenuServiceFee(45_000, 10).serviceFeeAmount;
    expect(round).toBe(one * 10);
  });
});

describe('centsToMajorUnits', () => {
  it('converts the stored cents amount to the major-unit figure the gateways charge', () => {
    expect(centsToMajorUnits(4_500)).toBe(45);
    expect(centsToMajorUnits(12_050)).toBe(120.5);
    expect(centsToMajorUnits(0)).toBe(0);
  });

  it('rounds to two decimals so no gateway ever sees a sub-cent amount', () => {
    expect(centsToMajorUnits(4_838)).toBe(48.38);
    expect(centsToMajorUnits(1)).toBe(0.01);
  });

  it('matches what a full preorder is actually charged end to end', () => {
    // Two drinks at E45.00 + one plate at E60.00 = E150.00, plus a 10% charge.
    const subtotal = 4_500 * 2 + 6_000;
    const { serviceFeeAmount, amountCharged } = computeMenuServiceFee(subtotal, 10);
    expect(centsToMajorUnits(subtotal)).toBe(150);
    expect(centsToMajorUnits(serviceFeeAmount)).toBe(15);
    expect(centsToMajorUnits(amountCharged)).toBe(165);
  });
});
