import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import {
  ResellerSettlement,
  IResellerSettlement,
} from '@models/resellerSettlement.model';
import { OrganizerPayout, IOrganizerPayout } from '@models/organizerPayout.model';
import {
  IResellerSettlementPreview,
  IOrganizerPayoutPreview,
} from '@interfaces/settlement.interface';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Shared $match for completed sales within the given period. */
function periodMatch(from: Date, to: Date) {
  return { paymentStatus: 'completed', soldAt: { $gte: from, $lte: to } };
}

export class SettlementService {
  /**
   * Ledger A — reseller settlement preview.
   *
   * cashOwedToCarrot      = Σ (faceAmount − resellerCommissionAmount)
   *                         where fundsCustody = 'reseller'
   * commissionOwedByCarrot = Σ resellerCommissionAmount
   *                         where fundsCustody = 'carrot' AND soldByType = 'ResellerOperator'
   * netAmount              = cashOwedToCarrot − commissionOwedByCarrot
   * byMethod               = cashOwedToCarrot broken down by paymentMethod
   */
  static async previewResellerSettlement(
    resellerId: string,
    from: Date,
    to: Date,
  ): Promise<IResellerSettlementPreview> {
    const resellerOid = new mongoose.Types.ObjectId(resellerId);

    const [ledgerResult, byMethodResult] = await Promise.all([
      TicketSale.aggregate([
        { $match: { ...periodMatch(from, to), resellerId: resellerOid } },
        {
          $group: {
            _id: null,
            cashOwedToCarrot: {
              $sum: {
                $cond: [
                  { $eq: ['$fundsCustody', 'reseller'] },
                  { $subtract: ['$faceAmount', '$resellerCommissionAmount'] },
                  0,
                ],
              },
            },
            commissionOwedByCarrot: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$fundsCustody', 'carrot'] },
                      { $eq: ['$soldByType', 'ResellerOperator'] },
                    ],
                  },
                  '$resellerCommissionAmount',
                  0,
                ],
              },
            },
          },
        },
      ]),

      TicketSale.aggregate([
        {
          $match: {
            ...periodMatch(from, to),
            resellerId: resellerOid,
            fundsCustody: 'reseller',
          },
        },
        {
          $group: {
            _id: '$paymentMethod',
            total: {
              $sum: { $subtract: ['$faceAmount', '$resellerCommissionAmount'] },
            },
          },
        },
      ]),
    ]);

    const row = ledgerResult[0] ?? { cashOwedToCarrot: 0, commissionOwedByCarrot: 0 };
    const cashOwedToCarrot = round2(row.cashOwedToCarrot);
    const commissionOwedByCarrot = round2(row.commissionOwedByCarrot);

    const byMethod: Record<string, number> = {};
    for (const entry of byMethodResult) {
      byMethod[entry._id as string] = round2(entry.total as number);
    }

    return {
      cashOwedToCarrot,
      commissionOwedByCarrot,
      netAmount: round2(cashOwedToCarrot - commissionOwedByCarrot),
      byMethod,
    };
  }

  /**
   * Ledger B — organizer payout preview.
   *
   * proceedsOwed      = Σ organizerProceeds  where fundsCustody ∈ {carrot, reseller}
   * feeOwedByVendor   = Σ platformFeeAmount  where fundsCustody = 'vendor'
   * availableProceeds = Σ organizerProceeds  where fundsCustody = 'carrot'
   *                      OR (fundsCustody = 'reseller' AND resellerRemitted = true)
   * netAmount         = proceedsOwed − feeOwedByVendor
   */
  static async previewOrganizerPayout(
    vendorId: string,
    from: Date,
    to: Date,
  ): Promise<IOrganizerPayoutPreview> {
    const vendorOid = new mongoose.Types.ObjectId(vendorId);

    const result = await TicketSale.aggregate([
      { $match: { ...periodMatch(from, to), vendorId: vendorOid } },
      {
        $group: {
          _id: null,
          proceedsOwed: {
            $sum: {
              $cond: [
                { $in: ['$fundsCustody', ['carrot', 'reseller']] },
                '$organizerProceeds',
                0,
              ],
            },
          },
          feeOwedByVendor: {
            $sum: {
              $cond: [
                { $eq: ['$fundsCustody', 'vendor'] },
                '$platformFeeAmount',
                0,
              ],
            },
          },
          availableProceeds: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$fundsCustody', 'carrot'] },
                    {
                      $and: [
                        { $eq: ['$fundsCustody', 'reseller'] },
                        { $eq: ['$resellerRemitted', true] },
                      ],
                    },
                  ],
                },
                '$organizerProceeds',
                0,
              ],
            },
          },
        },
      },
    ]);

    const row = result[0] ?? { proceedsOwed: 0, feeOwedByVendor: 0, availableProceeds: 0 };
    const proceedsOwed = round2(row.proceedsOwed);
    const feeOwedByVendor = round2(row.feeOwedByVendor);
    const availableProceeds = round2(row.availableProceeds);

    return {
      proceedsOwed,
      feeOwedByVendor,
      availableProceeds,
      netAmount: round2(proceedsOwed - feeOwedByVendor),
    };
  }

  /**
   * Freeze a reseller settlement for the given period.
   * Computes aggregates via previewResellerSettlement and persists an immutable snapshot.
   * Status is set to 'pending_payment' — aggregates are NEVER recomputed after this point.
   */
  static async closeResellerSettlement(
    resellerId: string,
    from: Date,
    to: Date,
    adminId: string,
  ): Promise<IResellerSettlement> {
    const overlapping = await ResellerSettlement.findOne({
      resellerId: new mongoose.Types.ObjectId(resellerId),
      status: { $in: ['pending_payment', 'settled'] },
      periodStart: { $lte: to },
      periodEnd: { $gte: from },
    });
    if (overlapping) {
      throw new Error('An overlapping reseller settlement period already exists');
    }

    const preview = await SettlementService.previewResellerSettlement(resellerId, from, to);
    return ResellerSettlement.create({
      resellerId: new mongoose.Types.ObjectId(resellerId),
      periodStart: from,
      periodEnd: to,
      status: 'pending_payment',
      cashOwedToCarrot: preview.cashOwedToCarrot,
      commissionOwedByCarrot: preview.commissionOwedByCarrot,
      netAmount: preview.netAmount,
      byMethod: preview.byMethod,
      settledBy: adminId,
    });
  }

  /**
   * Mark a frozen reseller settlement as paid.
   *
   * Crash-safe stamp-then-flip order:
   * 1. Load the settlement — throw if not found, throw if already settled.
   * 2. Idempotently stamp all covered reseller-cash sales as resellerRemitted:true FIRST
   *    so their proceeds unlock for organizer payout (Ledger B).
   * 3. Atomically flip status to 'settled' LAST — if a concurrent call already flipped it,
   *    findOneAndUpdate returns null and we throw 'already settled'.
   *
   * This order ensures that if the process crashes between steps 2 and 3, re-running is safe:
   * the stamp is idempotent and the flip has not yet occurred, so the settlement can be retried.
   */
  static async markResellerSettlementPaid(
    settlementId: string,
    adminId: string,
    paymentReference?: string,
  ): Promise<IResellerSettlement> {
    // Step 1 — load and validate
    const existing = await ResellerSettlement.findById(settlementId);
    if (!existing) {
      throw new Error(`Settlement not found: ${settlementId}`);
    }
    if (existing.status === 'settled') {
      throw new Error(`Settlement already settled: ${settlementId}`);
    }

    // Step 2 — idempotent stamp FIRST
    await TicketSale.updateMany(
      {
        resellerId: existing.resellerId,
        fundsCustody: 'reseller',
        soldAt: { $gte: existing.periodStart, $lte: existing.periodEnd },
      },
      { resellerRemitted: true },
    );

    // Step 3 — irreversible flip LAST
    const settledAt = new Date();
    const updatePayload: any = { status: 'settled', settledAt, settledBy: adminId };
    if (paymentReference) updatePayload.paymentReference = paymentReference;

    const settlement = await ResellerSettlement.findOneAndUpdate(
      { _id: settlementId, status: { $ne: 'settled' } },
      { $set: updatePayload },
      { new: true },
    );
    if (!settlement) {
      throw new Error(`Settlement already settled: ${settlementId}`);
    }

    return settlement;
  }

  /**
   * Freeze an organizer payout for the given period.
   * Computes aggregates via previewOrganizerPayout and persists an immutable snapshot.
   */
  static async closeOrganizerPayout(
    vendorId: string,
    from: Date,
    to: Date,
    adminId: string,
  ): Promise<IOrganizerPayout> {
    const overlapping = await OrganizerPayout.findOne({
      vendorId: new mongoose.Types.ObjectId(vendorId),
      status: { $in: ['pending_payment', 'settled'] },
      periodStart: { $lte: to },
      periodEnd: { $gte: from },
    });
    if (overlapping) {
      throw new Error('An overlapping organizer payout period already exists');
    }

    const preview = await SettlementService.previewOrganizerPayout(vendorId, from, to);
    return OrganizerPayout.create({
      vendorId: new mongoose.Types.ObjectId(vendorId),
      periodStart: from,
      periodEnd: to,
      status: 'pending_payment',
      proceedsOwed: preview.proceedsOwed,
      feeOwedByVendor: preview.feeOwedByVendor,
      availableProceeds: preview.availableProceeds,
      netAmount: preview.netAmount,
      settledBy: adminId,
    });
  }

  /**
   * Mark a frozen organizer payout as paid.
   * Atomically transitions status to 'settled' + audit fields.
   */
  static async markOrganizerPayoutPaid(
    payoutId: string,
    adminId: string,
    paymentReference?: string,
  ): Promise<IOrganizerPayout> {
    const updatePayload: any = {
      status: 'settled',
      settledAt: new Date(),
      settledBy: adminId,
    };
    if (paymentReference) updatePayload.paymentReference = paymentReference;

    const payout = await OrganizerPayout.findOneAndUpdate(
      { _id: payoutId, status: { $ne: 'settled' } },
      { $set: updatePayload },
      { new: true },
    );
    if (!payout) {
      throw new Error(`OrganizerPayout ${payoutId} not found or already settled`);
    }

    return payout;
  }
}
