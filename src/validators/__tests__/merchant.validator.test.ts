import { chargeSchema } from '@validators/merchant.validator';

const base = { bandUid: '04aabbccddee', clientTxnId: 'c1' };
const PID = '64b7f0c2e4a1b2c3d4e5f6a7'; // a well-formed ObjectId

describe('chargeSchema amount|items xor', () => {
  it('accepts an amount-only charge', () => {
    expect(chargeSchema.validate({ ...base, amount: 300 }).error).toBeUndefined();
  });
  it('accepts an itemised charge with staffName', () => {
    const { error } = chargeSchema.validate({ ...base, staffName: 'Sipho', items: [{ productId: PID, qty: 2 }] });
    expect(error).toBeUndefined();
  });
  it('rejects sending BOTH amount and items', () => {
    expect(chargeSchema.validate({ ...base, amount: 300, items: [{ productId: PID, qty: 1 }] }).error).toBeDefined();
  });
  it('rejects sending NEITHER', () => {
    expect(chargeSchema.validate({ ...base }).error).toBeDefined();
  });
  it('rejects an empty items array', () => {
    expect(chargeSchema.validate({ ...base, items: [] }).error).toBeDefined();
  });
  it('rejects a non-positive qty', () => {
    expect(chargeSchema.validate({ ...base, items: [{ productId: PID, qty: 0 }] }).error).toBeDefined();
  });
  it('rejects a productId that is not a 24-hex ObjectId (a CastError 500 otherwise)', () => {
    for (const productId of ['p1', 'not-an-object-id', '64b7f0c2e4a1b2c3d4e5f6a', '64b7f0c2e4a1b2c3d4e5f6a7z']) {
      const { error } = chargeSchema.validate({ ...base, items: [{ productId, qty: 1 }] });
      expect(error?.message).toMatch(/productId/);
    }
  });
});
