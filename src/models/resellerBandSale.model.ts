import { Schema, model, Document, Types } from 'mongoose';

export type ResellerBandSaleStatus = 'pending' | 'completed';

/**
 * Idempotency + progress record for POST /api/reseller/sales/sell-band (Task 7,
 * cashless spec §5.1).
 *
 * `createSale`/`TicketSale` have no `clientTxnId` field (mirrors every other
 * cash-sale path — see resellerSale.service.ts), so a naive retry could mint a
 * SECOND ticket for the same physical tap. This collection is a minimal,
 * sell-band-local fix: it does NOT touch TicketSale/Ticket/createSale, or any
 * already-reviewed cashless model (Wallet/BandBinding).
 *
 * `ResellerSaleService.createBandSale` reserves a row here (`status:'pending'`,
 * unique on `clientTxnId`) BEFORE calling `createSale` — not after the whole
 * orchestration succeeds — because a failure between minting the ticket and
 * finishing (e.g. `bindBand`/`topUpCash` throwing) must still be resumable
 * without re-running `createSale` and minting a second ticket. `saleId` /
 * `ticketId` / `walletId` are stamped onto the row as each step completes, so
 * a retry can tell exactly how far the previous attempt got:
 *
 *  - no row yet                          → fresh attempt, run the full flow.
 *  - row exists, status 'completed'      → idempotent hit, replay the result.
 *  - row exists, status 'pending', has
 *    `ticketId`                          → RESUME from wallet/band/cash-load;
 *                                           the ticket already exists, so
 *                                           `createSale` is NOT called again.
 *  - row exists, status 'pending', NO
 *    `ticketId`                          → the prior attempt crashed at/inside
 *                                           `createSale` itself, which is NOT
 *                                           safe to blindly retry (it may or
 *                                           may not have minted). Fails loudly
 *                                           instead of silently double-issuing.
 *
 * A DIFFERENT clientTxnId reusing the same bandUid is a fresh row (this table
 * is keyed on clientTxnId only, never on bandUid), so it always runs the full
 * orchestration — a genuine band-reuse collision still surfaces loudly via
 * WalletService.bindBand's own {eventId,bandUid} uniqueness guard.
 */
export interface IResellerBandSale extends Document {
  clientTxnId: string;
  status: ResellerBandSaleStatus;
  eventId: Types.ObjectId;
  ticketTypeId: string;
  bandUid: string;
  cashAmount: number;
  resellerId: string;
  operatorId: string;
  customerName?: string;
  customerPhone?: string;
  saleId?: Types.ObjectId;
  ticketId?: Types.ObjectId;
  walletId?: Types.ObjectId;
  createdAt: Date;
}

const resellerBandSaleSchema = new Schema<IResellerBandSale>(
  {
    clientTxnId: { type: String, required: true, unique: true, trim: true },
    status: { type: String, enum: ['pending', 'completed'], required: true, default: 'pending' },
    eventId: { type: Schema.Types.ObjectId, required: true, index: true },
    ticketTypeId: { type: String, required: true },
    bandUid: { type: String, required: true, trim: true },
    cashAmount: { type: Number, required: true, default: 0 },
    resellerId: { type: String, required: true },
    operatorId: { type: String, required: true },
    customerName: { type: String, trim: true },
    customerPhone: { type: String, trim: true },
    saleId: { type: Schema.Types.ObjectId },
    ticketId: { type: Schema.Types.ObjectId },
    walletId: { type: Schema.Types.ObjectId },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const ResellerBandSale = model<IResellerBandSale>('ResellerBandSale', resellerBandSaleSchema);
