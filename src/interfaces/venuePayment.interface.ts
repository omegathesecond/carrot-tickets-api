import { Document, Types } from 'mongoose';

export type TenderMethod = 'cash' | 'card';
export const TENDER_METHODS: readonly TenderMethod[] = ['cash', 'card'] as const;

/** One way a payment was made. `amount` comes off the bill; `tip` never does. */
export interface IVenueTender {
  method: TenderMethod;
  amount: number;
  tip: number;
  /** A card slip reference. Card only. */
  reference?: string;
}

export type VenuePaymentSource = 'table' | 'counter';

/** Money a venue took: a table payment (one of possibly several) or a counter sale. */
export interface IVenuePayment extends Document {
  venueId: Types.ObjectId;
  source: VenuePaymentSource;
  tableId?: Types.ObjectId;
  /** Snapshot — a table label is reused once its table closes. */
  tableLabel?: string;
  merchantChargeId?: Types.ObjectId;
  /** Snapshot of the stall's name, for a counter sale. */
  merchantName?: string;
  /** The stalls with items on the bill when this was taken (one for a counter sale). */
  merchantIds: Types.ObjectId[];
  clientTxnId: string;
  tenders: IVenueTender[];
  /** Σ tender.amount — what this took off the bill. */
  applied: number;
  /** Σ tender.tip — never counted as sales. */
  tips: number;
  /** Present only when the guest paid for specific items. */
  lines?: Array<{ lineId: Types.ObjectId; qty: number }>;
  takenBy: string;
  takenByType: 'Waiter' | 'MerchantOperator';
  staffName: string;
  at: Date;
  createdAt: Date;
}
