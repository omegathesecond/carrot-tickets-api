import { Document, Types } from 'mongoose';

export type TableStatus = 'open' | 'settled' | 'voided';

/**
 * One line on a table. Name and unitPrice are SNAPSHOTTED at add time, the way
 * MerchantCharge.items already does: a price change at the stall must never
 * reprice a drink somebody already drank.
 */
export interface ITableLine {
  _id: Types.ObjectId;
  merchantId: Types.ObjectId;
  productId: Types.ObjectId;
  name: string;
  unitPrice: number;
  qty: number;
  addedBy: string;
  addedAt: Date;
}

export interface ITable extends Document {
  eventId: Types.ObjectId;
  label: string;
  status: TableStatus;
  openedBy: string;
  items: ITableLine[];
  subtotal: number;
  settledAt?: Date;
  settledBy?: string;
  walletId?: Types.ObjectId;
  /**
   * The id of the settling transaction/request that closed this table, set by
   * the (later) settlement task alongside its guarded
   * `findOneAndUpdate({ _id, status: 'open' }, ...)`. That guard is what stops
   * two simultaneous settles from both charging the guest — but a POS that
   * retries after a network timeout resends the SAME request, and the retry
   * must replay the original outcome rather than be refused as "already
   * settled". Storing the id here is what lets settlement tell a retry (same
   * id: replay the existing charges) apart from a genuine second attempt
   * (different id: refuse, already settled). Without it the guard and the
   * replay requirement contradict each other.
   */
  settleTxnId?: string;
  voidedAt?: Date;
  voidReason?: string;
  voidedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}
