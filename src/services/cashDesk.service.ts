import mongoose, { ClientSession } from 'mongoose';
import { CashDeskLock } from '@models/cashDeskLock.model';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { sumTopupMethod } from '@utils/topupTotals.util';
import { CashCollection } from '@models/cashCollection.model';

export class CashDeskService {
  static key(eventId: string, cashierId: string) { return `${eventId.toLowerCase()}:${cashierId.toLowerCase()}`; }
  // Create outside the money transaction: concurrent first uses may race the
  // unique _id, but the winner establishes the same serialization row.
  static async ensure(eventId: string, cashierId: string) {
    try { await CashDeskLock.updateOne({ _id: this.key(eventId, cashierId) }, { $setOnInsert: { revision: 0 } }, { upsert: true }); }
    catch (e) { if ((e as { code?: number }).code !== 11000) throw e; }
  }
  static async touch(eventId: string, cashierId: string, session: ClientSession) {
    const result = await CashDeskLock.updateOne({ _id: this.key(eventId, cashierId) }, { $inc: { revision: 1 } }, { session });
    if (result.matchedCount !== 1) throw new Error('Cash desk serialization row missing');
  }
  static async totals(eventId: string, cashierId: string, session?: ClientSession) {
    const match = { eventId: new mongoose.Types.ObjectId(eventId), recordedBy: cashierId, recordedByType: 'Cashier', status: 'completed' };
    async function sum(model: any, filter: any): Promise<number> {
      const q = model.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
      if (session) q.session(session);
      const rows = await q; return rows[0]?.total ?? 0;
    }
    async function topupTotals() {
      const query = WalletTopup.aggregate([{ $match: match }, { $group: { _id: null, cashTopups: sumTopupMethod('cash'), cardTopups: sumTopupMethod('card') } }]);
      if (session) query.session(session);
      const rows = await query;
      return { cashTopups: rows[0]?.cashTopups ?? 0, cardTopups: rows[0]?.cardTopups ?? 0 };
    }
    const withdrawals = () => sum(WalletWithdrawal, { ...match, method: 'cash' });
    const collections = () => sum(CashCollection, { eventId: match.eventId, cashierId: new mongoose.Types.ObjectId(cashierId), status: 'confirmed' });
    // Mongo transactions require sequential commands; independent report reads
    // run concurrently so adding the card breakdown adds no extra round-trip.
    const [topups, cashWithdrawals, collected] = session
      ? [await topupTotals(), await withdrawals(), await collections()] as const
      : await Promise.all([topupTotals(), withdrawals(), collections()]);
    const { cashTopups, cardTopups } = topups;
    return { cashTopups, cardTopups, cashWithdrawals, collected, cashOnHand: cashTopups - cashWithdrawals - collected };
  }
}
