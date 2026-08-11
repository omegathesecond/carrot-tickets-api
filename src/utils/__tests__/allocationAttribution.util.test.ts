import { resolveSaleResellerId } from '../allocationAttribution.util';
import mongoose from 'mongoose';

describe('resolveSaleResellerId', () => {
  const rid = new mongoose.Types.ObjectId();

  it('attributes an allocation-tier sale to the tier owner, even with no caller reseller', () => {
    expect(resolveSaleResellerId({ isAllocation: true, resellerId: rid }, undefined)).toBe(String(rid));
  });

  it('the allocation owner wins over any caller reseller context', () => {
    const other = String(new mongoose.Types.ObjectId());
    expect(resolveSaleResellerId({ isAllocation: true, resellerId: rid }, other)).toBe(String(rid));
  });

  it('passes through the caller reseller for a non-allocation tier', () => {
    const posReseller = String(new mongoose.Types.ObjectId());
    expect(resolveSaleResellerId({ isAllocation: false, resellerId: undefined }, posReseller)).toBe(posReseller);
  });

  it('returns undefined for an ordinary online buyer purchase (no reseller anywhere)', () => {
    expect(resolveSaleResellerId({ isAllocation: false, resellerId: undefined }, undefined)).toBeUndefined();
  });

  it('FAILS LOUDLY when an allocation tier has no resellerId (misconfiguration)', () => {
    expect(() => resolveSaleResellerId({ isAllocation: true, resellerId: undefined }, undefined))
      .toThrow(/resellerId/i);
  });
});
