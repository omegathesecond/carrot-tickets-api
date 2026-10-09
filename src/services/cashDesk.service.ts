import mongoose, { ClientSession } from 'mongoose';
import { CashDeskLock } from '@models/cashDeskLock.model';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
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
    const match = { eventId: new mongoose.Types.ObjectId(eventId), recordedBy: cashierId, recordedByType: 'Cashier', status: 'completed', method: 'cash' };
    async function sum(model: any, filter: any): Promise<number> {
      const q = model.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
      if (session) q.session(session);
      const rows = await q; return rows[0]?.total ?? 0;
    }
    // Mongo sessions do not support parallel commands. Confirmation reads use
    // one locked transaction snapshot; reports can read independent totals.
    const inputs = [() => sum(WalletTopup, match), () => sum(WalletWithdrawal, match), () => sum(CashCollection, { eventId: match.eventId, cashierId: new mongoose.Types.ObjectId(cashierId), status: 'confirmed' })];
    const values: number[] = [];
    if (session) { for (const read of inputs) values.push(await read()); }
    else values.push(...await Promise.all(inputs.map(read => read())));
    const [cashTopups = 0, cashWithdrawals = 0, collected = 0] = values;
    return { cashTopups, cashWithdrawals, collected, cashOnHand: cashTopups - cashWithdrawals - collected };
  }
}
