/** The one public shape for "a brand" in lists/search. Never includes email/phone/password. */
export interface VendorSummary {
  id: string;
  businessName: string;
  slug: string | null;
  logoUrl: string | null;
}

export function toVendorSummary(vendor: any): VendorSummary {
  return {
    id: String(vendor._id),
    businessName: vendor.businessName,
    slug: vendor.slug ?? null,
    logoUrl: vendor.logoUrl ?? null,
  };
}
