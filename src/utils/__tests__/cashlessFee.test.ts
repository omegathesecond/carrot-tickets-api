import { purchaseChargeAmount, purchaseChargeSchema, withdrawalQuote, PurchaseCharge } from '../purchaseCharge.util';
const tiers: PurchaseCharge = { type: 'tiered', tiers: [{ min: 0, max: 10000, fee: 0 }, { min: 10000, max: 50000, fee: 250 }, { min: 50000, max: null, fee: 500 }] };
it.each([[1, 0], [9999, 0], [10000, 250], [49999, 250], [50000, 500], [10000000, 500]])('applies exactly one fee to %i cents', (amount, fee) => {
  expect(purchaseChargeAmount(amount!, tiers)).toBe(fee);
  expect(withdrawalQuote(amount!, tiers)).toEqual({ amount, feeAmount: fee, payoutAmount: amount! - fee! });
});
const invalid = [
  [], [{ min: 1, max: null, fee: 0 }], [{ min: 0, max: 100, fee: 0 }],
  [{ min: 0, max: 100, fee: 0 }, { min: 101, max: null, fee: 1 }],
  [{ min: 0, max: 100, fee: 0 }, { min: 99, max: null, fee: 1 }],
  [{ min: 0, max: null, fee: 0 }, { min: 100, max: null, fee: 1 }],
  [{ min: 0, max: null, fee: -1 }], [{ min: 0, max: null, fee: 1.5 }],
];
it.each(invalid.map(tiers => ({ tiers })))('rejects incomplete, overlapping or non-cent tiers $tiers', ({ tiers }) => {
  const setting = { type: 'tiered', tiers };
  expect(purchaseChargeSchema.validate(setting, { convert: false }).error).toBeDefined();
});
it('fails loudly on malformed stored settings', () => {
  expect(() => purchaseChargeAmount(100, { type: 'tiered', tiers: [{ min: 0, max: 50, fee: 1 }] })).toThrow();
});
