import { Schema, model, Document, Types } from 'mongoose';

/**
 * Idempotency + audit record for POST /api/reseller/sales/sell-band (Task 7,
 * cashless spec §5.1).
 *
 * `createSale`/`TicketSale` have no `clientTxnId` field (mirrors every other
 * cash-sale path — see resellerSale.service.ts), so a retried sell-band would
 * otherwise re-run `createSale` and mint a SECOND ticket for the same physical
 * tap. This collection is a minimal, sell-band-local fix: it does NOT touch
 * TicketSale/Ticket/createSale, or any already-reviewed cashless model
 * (Wallet/BandBinding).
 *
 * `ResellerSaleService.createBandSale` consults it BEFORE minting — a hit on
 * `clientTxnId` means "this exact request already completed," and the stored
 * ids are used to reconstruct the original result instead of re-running the
 * mint. A miss (including a DIFFERENT clientTxnId reusing the same bandUid)
 * proceeds through the full orchestration, so a genuine band-reuse collision
 * still surfaces loudly via WalletService.bindBand's own {eventId,bandUid}
 * uniqueness guard — this table deliberately does NOT key on bandUid alone,
 * so it never silently succeeds a second, different request for an
 * already-claimed band.
 *
 * The row is written only AFTER the ticket + wallet + band all succeed, so a
 * failed attempt (e.g. "already bound") never poisons this collection with a
 * false success.
 */
export interface IResellerBandSale extends Document {
  clientTxnId: string;
  eventId: Types.ObjectId;
  bandUid: string;
  resellerId: string;
  operatorId: string;
  saleId: Types.ObjectId;
  ticketId: Types.ObjectId;
  walletId: Types.ObjectId;
  createdAt: Date;
}

const resellerBandSaleSchema = new Schema<IResellerBandSale>(
  {
    clientTxnId: { type: String, required: true, unique: true, trim: true },
    eventId: { type: Schema.Types.ObjectId, required: true, index: true },
    bandUid: { type: String, required: true, trim: true },
    resellerId: { type: String, required: true },
    operatorId: { type: String, required: true },
    saleId: { type: Schema.Types.ObjectId, required: true },
    ticketId: { type: Schema.Types.ObjectId, required: true },
    walletId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const ResellerBandSale = model<IResellerBandSale>('ResellerBandSale', resellerBandSaleSchema);
