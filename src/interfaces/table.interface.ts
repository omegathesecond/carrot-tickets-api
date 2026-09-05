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
  /**
   * Bumped by EVERY update that changes the line set. Settlement prices the
   * lines outside its transaction, then names this value in its guarded flip,
   * so any change committed in that window makes the flip miss.
   *
   * subtotal cannot do this job alone: removing a line at one stall and adding
   * one of identical value at ANOTHER leaves subtotal and the line count both
   * unchanged, while the split between merchants has moved. The guest's total
   * would be right and the money would go to the wrong stall.
   */
  revision: number;
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
