import { toVendorSummary } from '@utils/vendorSummary.util';

describe('toVendorSummary', () => {
  it('maps a vendor doc to the public brand summary (no sensitive fields)', () => {
    const v: any = { _id: 'abc', businessName: 'Bhora Fest', slug: 'bhora-fest', logoUrl: 'https://cdn/x.png', email: 'secret@x.com', password: 'h' };
    expect(toVendorSummary(v)).toEqual({ id: 'abc', businessName: 'Bhora Fest', slug: 'bhora-fest', logoUrl: 'https://cdn/x.png' });
  });

  it('nulls missing slug/logoUrl', () => {
    const v: any = { _id: 'abc', businessName: 'Solo' };
    expect(toVendorSummary(v)).toEqual({ id: 'abc', businessName: 'Solo', slug: null, logoUrl: null });
  });
});
