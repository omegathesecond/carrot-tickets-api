import { chargeSchema } from '@validators/merchant.validator';

const base = { bandUid: '04aabbccddee', clientTxnId: 'c1' };

describe('chargeSchema amount|items xor', () => {
  it('accepts an amount-only charge', () => {
    expect(chargeSchema.validate({ ...base, amount: 300 }).error).toBeUndefined();
  });
  it('accepts an itemised charge with staffName', () => {
    const { error } = chargeSchema.validate({ ...base, staffName: 'Sipho', items: [{ productId: 'p1', qty: 2 }] });
    expect(error).toBeUndefined();
  });
  it('rejects sending BOTH amount and items', () => {
    expect(chargeSchema.validate({ ...base, amount: 300, items: [{ productId: 'p1', qty: 1 }] }).error).toBeDefined();
  });
  it('rejects sending NEITHER', () => {
    expect(chargeSchema.validate({ ...base }).error).toBeDefined();
  });
  it('rejects an empty items array', () => {
    expect(chargeSchema.validate({ ...base, items: [] }).error).toBeDefined();
  });
  it('rejects a non-positive qty', () => {
    expect(chargeSchema.validate({ ...base, items: [{ productId: 'p1', qty: 0 }] }).error).toBeDefined();
  });
});
