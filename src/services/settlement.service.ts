import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
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
}
