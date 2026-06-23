import { computeSaleEconomics } from '@services/saleEconomics.service';

describe('computeSaleEconomics', () => {
  it('reseller cash sale: funds held by reseller, proceeds net of commission', () => {
    const r = computeSaleEconomics({
      faceAmount: 100, paymentMethod: 'cash', soldByType: 'ResellerOperator',
      resellerCommissionPercent: 8, platformFeePercent: 0,
    });
    expect(r.resellerCommissionAmount).toBe(8);
    expect(r.platformFeeAmount).toBe(0);
    expect(r.organizerProceeds).toBe(92);
    expect(r.fundsCustody).toBe('reseller');
  });

  it('reseller electronic sale: funds pool in carrot', () => {
    const r = computeSaleEconomics({
      faceAmount: 100, paymentMethod: 'mtn_momo', soldByType: 'ResellerOperator',
      resellerCommissionPercent: 8, platformFeePercent: 5,
    });
    expect(r.platformFeeAmount).toBe(5);
    expect(r.organizerProceeds).toBe(87);
    expect(r.fundsCustody).toBe('carrot');
  });

  it('direct vendor cash sale: funds held by vendor, no reseller commission', () => {
    const r = computeSaleEconomics({
      faceAmount: 50, paymentMethod: 'cash', soldByType: 'Vendor',
      resellerCommissionPercent: 0, platformFeePercent: 10,
    });
    expect(r.resellerCommissionAmount).toBe(0);
    expect(r.platformFeeAmount).toBe(5);
    expect(r.organizerProceeds).toBe(45);
    expect(r.fundsCustody).toBe('vendor');
  });

  it('rounds to 2 decimals', () => {
    const r = computeSaleEconomics({
      faceAmount: 33.33, paymentMethod: 'mtn_momo', soldByType: 'VendorSubUser',
      resellerCommissionPercent: 0, platformFeePercent: 7.5,
    });
    expect(r.platformFeeAmount).toBe(2.5);          // 33.33 * 0.075 = 2.49975 -> 2.5
    expect(r.organizerProceeds).toBe(30.83);        // 33.33 - 2.5
  });
});
