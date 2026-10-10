import { CashierAuthService } from '@services/cashierAuth.service';
import mongoose from 'mongoose';
import { Cashier } from '@models/cashier.model';
import { CashCollection, ICashCollection } from '@models/cashCollection.model';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { topupTotalsGroup, readTopupTotals, sumTopupTotals } from '@utils/topupTotals.util';
import { CashDeskService } from '@services/cashDesk.service';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import { MAX_TOPUP_CENTS } from '@services/wallet.service';

export class CashCollectionService {
  static async actor(cashierId: string, event: any, collect = false) {
    const actor = await Cashier.findById(cashierId).lean();
    if (!actor?.isActive) throw new HttpError(403, 'Staff account is inactive');
    if (actor.scope !== 'platform' && (String(actor.eventId) !== String(event._id) || String(actor.vendorId) !== String(event.vendorId))) throw new HttpError(403, 'You are not assigned to this event');
    if (collect && !actor.grants?.includes(OperatorGrant.COLLECT_CASH)) throw new HttpError(403, 'Cash collection permission required');
    return actor;
  }
  static async create(event: any, collectorId: string, params: { cashierId: string; amount: number; clientTxnId: string }) {
    const { cashierId, amount, clientTxnId } = params;
    if (!HEX24.test(cashierId ?? '') || !Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_TOPUP_CENTS || typeof clientTxnId !== 'string' || !clientTxnId.trim() || clientTxnId.length > 100) throw new HttpError(400, 'Cashier, positive cash amount and request ID are required');
    if (cashierId.toLowerCase() === collectorId.toLowerCase()) throw new HttpError(400, 'A collector cannot collect from themselves');
    const collector = await this.actor(collectorId, event, true);
    const cashier = await this.actor(cashierId, event);
    const eventId = String(event._id);
    const matches = (row: ICashCollection) => {
      if (String(row.cashierId) !== cashierId.toLowerCase() || String(row.eventId) !== eventId || row.amount !== amount) throw new HttpError(409, 'This request ID was used for a different collection');
      return row;
    };
    await CashCollection.init(); // The unique request index must exist before money requests are accepted.
    const existing = await CashCollection.findOne({ collectorId, clientTxnId });
    if (existing) return matches(existing);
    const totals = await CashDeskService.totals(eventId, cashierId);
    if (amount > totals.cashOnHand) throw new HttpError(409, 'Amount exceeds the cashier’s recorded cash on hand');
    try {
      return await CashCollection.create({ eventId, cashierId, collectorId, cashierName: cashier.fullName, collectorName: collector.fullName, amount, clientTxnId, status: 'pending' });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const winner = await CashCollection.findOne({ collectorId, clientTxnId });
        if (winner) return matches(winner);
      }
      throw e;
    }
  }
  static async resolve(event: any, actorId: string, collectionId: string, decision: 'confirm' | 'reject' | 'cancel', pin: unknown) {
    if (!HEX24.test(collectionId)) throw new HttpError(400, 'Invalid collection ID');
    await this.actor(actorId, event, decision === 'cancel');
    const eventId = String(event._id);
    const initial = await CashCollection.findOne({ _id: collectionId, eventId });
    if (!initial) throw new HttpError(404, 'Collection not found');
    const expectedActor = decision === 'cancel' ? initial.collectorId : initial.cashierId;
    if (String(expectedActor) !== actorId) throw new HttpError(403, 'Only the named cashier can confirm or reject; only the collector can cancel');
    if (decision === 'confirm') await CashierAuthService.confirmPin(actorId, pin);
    const status = decision === 'confirm' ? 'confirmed' : decision === 'reject' ? 'rejected' : 'cancelled';
    await CashDeskService.ensure(eventId, String(initial.cashierId));
    const session = await mongoose.startSession();
    try {
      let result!: ICashCollection;
      await session.withTransaction(async () => {
        // Lock before reading: cash reloads, cash-outs and other confirmations
        // write this same row. A conflict retries against a fresh snapshot.
        await CashDeskService.touch(eventId, String(initial.cashierId), session);
        const row = await CashCollection.findOne({ _id: collectionId, eventId }).session(session);
        if (!row) throw new HttpError(404, 'Collection not found');
        if (row.status === status) { result = row; return; }
        if (row.status !== 'pending') throw new HttpError(409, `Collection already ${row.status}`);
        if (decision === 'confirm') {
          const totals = await CashDeskService.totals(eventId, String(row.cashierId), session);
          if (row.amount > totals.cashOnHand) throw new HttpError(409, 'Cash on hand has changed. Reject this request and enter the correct amount');
          row.ledgerTxnId = await LedgerService.post({ eventId, postings: [
            { account: { type: LedgerAccountType.FLOAT }, delta: -row.amount, tag: FloatTag.CASH_DESK },
            { account: { type: LedgerAccountType.FLOAT }, delta: row.amount, tag: FloatTag.COLLECTOR_CASH },
          ], refType: 'cash_collection', refId: String(row._id), session });
        }
        row.status = status; row.resolvedAt = new Date(); row.resolvedBy = new mongoose.Types.ObjectId(actorId);
        await row.save({ session }); result = row;
      });
      return result;
    } finally { await session.endSession(); }
  }
  static async desk(event: any, actorId: string) {
    const actor = await this.actor(actorId, event);
    const eventId = String(event._id);
    const canCollect = !!actor.grants?.includes(OperatorGrant.COLLECT_CASH);
    const [totals, collections, heldRows] = await Promise.all([
      CashDeskService.totals(eventId, actorId),
      CashCollection.find({ eventId, $or: [{ cashierId: actorId }, { collectorId: actorId }] }).sort({ createdAt: -1 }).limit(100).lean(),
      CashCollection.aggregate([{ $match: { eventId: event._id, collectorId: actor._id, status: 'confirmed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);
    // Pending requests are returned separately, without the history's cap.
    const pending = await CashCollection.find({ eventId, cashierId: actorId, status: 'pending' }).sort({ createdAt: 1 }).lean();
    const cashiers = canCollect ? (await this.report(eventId)).cashiers.filter(c => c.id !== actorId && c.isActive) : [];
    return { currency: event.currency, canCollect, ...totals, collectorHeld: heldRows[0]?.total ?? 0, pending, collections, cashiers };
  }
  static async report(eventId: string) {
    const id = new mongoose.Types.ObjectId(eventId);
    const [topups, withdrawals, confirmed, pendingCount, history, assigned] = await Promise.all([
      WalletTopup.aggregate([{ $match: { eventId: id, recordedByType: 'Cashier', status: 'completed' } }, { $group: { _id: '$recordedBy', ...topupTotalsGroup() } }]),
      WalletWithdrawal.aggregate([{ $match: { eventId: id, recordedByType: 'Cashier', method: 'cash', status: 'completed' } }, { $group: { _id: '$recordedBy', total: { $sum: '$amount' } } }]),
      CashCollection.find({ eventId, status: 'confirmed' }).select('cashierId collectorId collectorName amount').lean(),
      CashCollection.countDocuments({ eventId, status: 'pending' }),
      CashCollection.find({ eventId }).sort({ createdAt: -1 }).limit(100).lean(),
      Cashier.find({ $or: [{ eventId }, { scope: 'platform' }] }).select('fullName isActive').lean(),
    ]);
    const ids = [...new Set([...assigned.map(c => String(c._id)), ...topups.map(t => String(t._id)), ...withdrawals.map(t => String(t._id)), ...confirmed.map(c => String(c.cashierId))])].filter(i => HEX24.test(i));
    const names = await Cashier.find({ _id: { $in: ids } }).select('fullName isActive').lean();
    const cashiers = ids.map(cashierId => {
      const c = names.find(row => String(row._id) === cashierId);
      const topup = topups.find(t => String(t._id) === cashierId);
      const totals = readTopupTotals(topup);
      const { cashTopups } = totals;
      const cashWithdrawals = withdrawals.find(t => String(t._id) === cashierId)?.total ?? 0;
      const collected = confirmed.filter(t => String(t.cashierId) === cashierId).reduce((n, t) => n + t.amount, 0);
      return { id: cashierId, fullName: c?.fullName ?? history.find(row => String(row.cashierId) === cashierId)?.cashierName ?? `Removed staff (${cashierId})`, isActive: c?.isActive === true, ...totals, cashWithdrawals, collected, cashOnHand: cashTopups - cashWithdrawals - collected };
    });
    const collectors = new Map<string, { id: string; fullName: string; held: number }>();
    for (const row of confirmed) { const key = String(row.collectorId); const c = collectors.get(key) ?? { id: key, fullName: row.collectorName, held: 0 }; c.held += row.amount; collectors.set(key, c); }
    return { cashiers, ...sumTopupTotals(cashiers), collectors: [...collectors.values()], cashOnHand: cashiers.reduce((n, c) => n + c.cashOnHand, 0), collectorHeld: confirmed.reduce((n, c) => n + c.amount, 0), pendingCount, collections: history };
  }
}
