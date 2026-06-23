export interface IResellerSettlementPreview {
  cashOwedToCarrot: number;
  commissionOwedByCarrot: number;
  netAmount: number;
  byMethod: Record<string, number>;
}

export interface IOrganizerPayoutPreview {
  proceedsOwed: number;
  feeOwedByVendor: number;
  availableProceeds: number;
  netAmount: number;
}
