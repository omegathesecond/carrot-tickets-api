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

  static async approve(id: string, adminId: string): Promise<IResellerCommissionWithdrawal> {
    const w = await ResellerCommissionWithdrawal.findOneAndUpdate(
      { _id: id, status: 'requested' },
      { $set: { status: 'approved', approvedBy: adminId } },
      { new: true },
    );
    if (!w) throw new Error(`Withdrawal not found or not in requested state: ${id}`);
    return w;
  }

  /** Crash-safe stamp-then-flip, mirroring markResellerSettlementPaid. */
  static async markPaid(
    id: string,
    adminId: string,
    paymentReference?: string,
  ): Promise<IResellerCommissionWithdrawal> {
    const existing = await ResellerCommissionWithdrawal.findById(id);
    if (!existing) throw new Error(`Withdrawal not found: ${id}`);
    if (existing.status === 'paid') throw new Error(`Withdrawal already paid: ${id}`);
    if (existing.status === 'rejected') throw new Error(`Withdrawal was rejected: ${id}`);

    // Step 1 — idempotent stamp FIRST
    await TicketSale.updateMany(
      {
        resellerId: existing.resellerId,
        fundsCustody: 'carrot',
        soldByType: 'ResellerOperator',
        soldAt: { $lte: existing.snapshotAt },
        commissionWithdrawn: { $ne: true },
      },
      { commissionWithdrawn: true },
    );

    // Step 2 — irreversible flip LAST
    const updatePayload: any = { status: 'paid', paidAt: new Date(), approvedBy: adminId };
    if (paymentReference) updatePayload.paymentReference = paymentReference;
    const w = await ResellerCommissionWithdrawal.findOneAndUpdate(
      { _id: id, status: { $ne: 'paid' } },
      { $set: updatePayload },
      { new: true },
    );
    if (!w) throw new Error(`Withdrawal already paid: ${id}`);
    return w;
  }

  static async reject(id: string, adminId: string, notes?: string): Promise<IResellerCommissionWithdrawal> {
    const w = await ResellerCommissionWithdrawal.findOneAndUpdate(
      { _id: id, status: { $in: ['requested', 'approved'] } },
      { $set: { status: 'rejected', approvedBy: adminId, ...(notes ? { notes } : {}) } },
      { new: true },
    );
    if (!w) throw new Error(`Withdrawal not found or not pending: ${id}`);
    return w;
  }
}
