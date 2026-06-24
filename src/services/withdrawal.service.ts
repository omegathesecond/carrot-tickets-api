import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import {
  ResellerCommissionWithdrawal,
  IResellerCommissionWithdrawal,
} from '@models/resellerCommissionWithdrawal.model';

const round2 = (n: number) => Math.round(n * 100) / 100;

export class WithdrawalService {
  /** Gross accrued commission from carrot-custody operator sales, not yet withdrawn. */
  static async availableCommission(resellerId: string): Promise<number> {
    const result = await TicketSale.aggregate([
      {
        $match: {
          paymentStatus: 'completed',
          fundsCustody: 'carrot',
          soldByType: 'ResellerOperator',
          resellerId: new mongoose.Types.ObjectId(resellerId),
          commissionWithdrawn: { $ne: true },
        },
      },
      { $group: { _id: null, total: { $sum: '$resellerCommissionAmount' } } },
    ]);
    return round2(result[0]?.total ?? 0);
  }

  /** Open a withdrawal for the full available balance. One open request at a time. */
  static async requestWithdrawal(
    resellerId: string,
    operatorId: string,
  ): Promise<IResellerCommissionWithdrawal> {
    const existing = await ResellerCommissionWithdrawal.findOne({
      resellerId: new mongoose.Types.ObjectId(resellerId),
      status: { $in: ['requested', 'approved'] },
    });
    if (existing) throw new Error('A withdrawal request is already open');

    const amount = await WithdrawalService.availableCommission(resellerId);
    if (amount <= 0) throw new Error('No commission available to withdraw');

    return ResellerCommissionWithdrawal.create({
      resellerId: new mongoose.Types.ObjectId(resellerId),
      amount,
      status: 'requested',
      requestedBy: operatorId,
      requestedAt: new Date(),
      snapshotAt: new Date(),
    });
  }
}
