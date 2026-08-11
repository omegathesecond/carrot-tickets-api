// api/src/services/organizerCashless.service.ts
import mongoose from 'mongoose';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Merchant } from '@models/merchant.model';
import { Cashier } from '@models/cashier.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { Wallet } from '@models/wallet.model';

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const sumField = (field: string) => [{ $group: { _id: null, total: { $sum: field }, count: { $sum: 1 } } }];

/**
 * The organizer's-eye view of everything cashless in ONE event (cashless spec —
 * cashier slice). The organizer owns the event and "is in charge", so this is
 * the full picture: how much circulated, how much each vendor made, what each
 * cashier moved, and how much attendees left behind un-withdrawn.
 *
 * Every figure is derived from the durable money records + wallets (the same
 * sources the ledger reconciles), never recomputed from app state.
 */
export class OrganizerCashlessService {
  static async summary(eventId: string) {
    const eid = oid(eventId);

    const [topupAgg, withdrawAgg, chargeAgg, leftBehindAgg, fundedAgg, vendorAgg, cashierTopupAgg, cashierWithdrawAgg] =
      await Promise.all([
        WalletTopup.aggregate([{ $match: { eventId: eid } }, ...sumField('$amount')]),
        WalletWithdrawal.aggregate([{ $match: { eventId: eid } }, ...sumField('$amount')]),
        MerchantCharge.aggregate([
          { $match: { eventId: eid } },
          { $group: { _id: null, gross: { $sum: '$amount' }, fee: { $sum: '$fee' }, count: { $sum: 1 } } },
        ]),
        Wallet.aggregate([{ $match: { eventId: eid } }, { $group: { _id: null, total: { $sum: '$balance' } } }]),
        WalletTopup.aggregate([{ $match: { eventId: eid } }, { $group: { _id: '$walletId' } }, { $count: 'n' }]),
        MerchantCharge.aggregate([
          { $match: { eventId: eid } },
          { $group: { _id: '$merchantId', gross: { $sum: '$amount' }, commission: { $sum: '$fee' }, net: { $sum: '$netAmount' }, chargeCount: { $sum: 1 } } },
        ]),
        WalletTopup.aggregate([
          { $match: { eventId: eid, recordedByType: 'Cashier' } },
          { $group: { _id: '$recordedBy', toppedUp: { $sum: '$amount' }, n: { $sum: 1 } } },
        ]),
        WalletWithdrawal.aggregate([
          { $match: { eventId: eid, recordedByType: 'Cashier' } },
          { $group: { _id: '$recordedBy', withdrawn: { $sum: '$amount' }, n: { $sum: 1 } } },
        ]),
      ]);

    const circulated = topupAgg[0]?.total ?? 0;
    const withdrawn = withdrawAgg[0]?.total ?? 0;
    const spent = chargeAgg[0]?.gross ?? 0;
    const fees = chargeAgg[0]?.fee ?? 0;
    const leftBehind = leftBehindAgg[0]?.total ?? 0;

    // Per-vendor takings, joined to merchant names.
    const merchantIds = vendorAgg.map((v: any) => v._id).filter(Boolean);
    const merchants = merchantIds.length
      ? await Merchant.find({ _id: { $in: merchantIds } }).select('name').lean()
      : [];
    const merchantName = new Map(merchants.map((m: any) => [String(m._id), m.name]));
    const vendors = vendorAgg
      .map((v: any) => ({
        merchantId: String(v._id),
        name: merchantName.get(String(v._id)) || 'Unknown vendor',
        gross: v.gross, commission: v.commission, net: v.net, chargeCount: v.chargeCount,
      }))
      .sort((a: any, b: any) => b.gross - a.gross);

    // Per-cashier activity, merging top-ups + withdrawals, joined to cashier names.
    const byCashier = new Map<string, { toppedUp: number; withdrawn: number; txnCount: number }>();
    for (const t of cashierTopupAgg) {
      const k = String(t._id);
      const c = byCashier.get(k) || { toppedUp: 0, withdrawn: 0, txnCount: 0 };
      c.toppedUp += t.toppedUp; c.txnCount += t.n; byCashier.set(k, c);
    }
    for (const w of cashierWithdrawAgg) {
      const k = String(w._id);
      const c = byCashier.get(k) || { toppedUp: 0, withdrawn: 0, txnCount: 0 };
      c.withdrawn += w.withdrawn; c.txnCount += w.n; byCashier.set(k, c);
    }
    const cashierIds = [...byCashier.keys()].filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
    const cashierDocs = cashierIds.length
      ? await Cashier.find({ _id: { $in: cashierIds.map(oid) } }).select('fullName').lean()
      : [];
    const cashierName = new Map(cashierDocs.map((c: any) => [String(c._id), c.fullName]));
    const cashiers = [...byCashier.entries()]
      .map(([id, c]) => ({ cashierId: id, name: cashierName.get(id) || 'Unknown cashier', ...c }))
      .sort((a, b) => (b.toppedUp + b.withdrawn) - (a.toppedUp + a.withdrawn));

    return {
      circulated, spent, withdrawn, leftBehind, fees,
      walletsFunded: fundedAgg[0]?.n ?? 0,
      vendors,
      cashiers,
    };
  }

  /**
   * The full event transaction log — top-ups, withdrawals, and vendor charges —
   * merged, newest first, page-bounded. `type` filters to one kind. Simple
   * skip/limit paging (the organizer report is a reviewing surface, not a hot
   * path); returns `hasMore` so the dashboard can page.
   */
  static async transactions(params: {
    eventId: string;
    type?: 'topup' | 'withdrawal' | 'purchase';
    page?: number;
    limit?: number;
  }) {
    const { eventId, type } = params;
    const eid = oid(eventId);
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const page = Math.max(params.page ?? 1, 1);

    // Over-fetch each source to the page window, merge, then slice — correct for
    // a reviewing surface without a cross-collection cursor.
    const window = page * limit + 1;
    const wantTopups = !type || type === 'topup';
    const wantWithdrawals = !type || type === 'withdrawal';
    const wantPurchases = !type || type === 'purchase';

    const [topups, withdrawals, charges] = await Promise.all([
      wantTopups ? WalletTopup.find({ eventId: eid }).sort({ createdAt: -1 }).limit(window).lean() : [],
      wantWithdrawals ? WalletWithdrawal.find({ eventId: eid }).sort({ createdAt: -1 }).limit(window).lean() : [],
      wantPurchases ? MerchantCharge.find({ eventId: eid }).sort({ createdAt: -1 }).limit(window).lean() : [],
    ]);

    const merged = [
      ...topups.map((t: any) => ({ id: String(t._id), type: 'topup' as const, amount: t.amount, at: t.createdAt, actorType: t.recordedByType, actorId: t.recordedBy ? String(t.recordedBy) : null })),
      ...withdrawals.map((w: any) => ({ id: String(w._id), type: 'withdrawal' as const, amount: w.amount, at: w.createdAt, actorType: w.recordedByType, actorId: w.recordedBy ? String(w.recordedBy) : null })),
      ...charges.map((c: any) => ({ id: String(c._id), type: 'purchase' as const, amount: c.amount, at: c.createdAt, bandUid: c.bandUid, fee: c.fee, netAmount: c.netAmount, actorType: 'Merchant', actorId: c.merchantId ? String(c.merchantId) : null })),
    ].sort((a: any, b: any) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const start = (page - 1) * limit;
    const pageRows: any[] = merged.slice(start, start + limit);

    // Resolve WHO for just this page — the vendor name on a purchase, the
    // cashier/reseller name on a top-up or cash-out. Batched per population so a
    // page costs at most 3 extra look-ups regardless of row count.
    const idsOfType = (t: string) =>
      [...new Set(pageRows.filter((r) => r.actorType === t && r.actorId && /^[0-9a-fA-F]{24}$/.test(r.actorId)).map((r) => r.actorId))];
    const [merchants, cashiers, resellers] = await Promise.all([
      Merchant.find({ _id: { $in: idsOfType('Merchant').map(oid) } }).select('name').lean(),
      Cashier.find({ _id: { $in: idsOfType('Cashier').map(oid) } }).select('fullName').lean(),
      ResellerOperator.find({ _id: { $in: idsOfType('ResellerOperator').map(oid) } }).select('fullName').lean(),
    ]);
    const nameOf = new Map<string, string>();
    merchants.forEach((m: any) => nameOf.set(String(m._id), m.name));
    cashiers.forEach((c: any) => nameOf.set(String(c._id), c.fullName));
    resellers.forEach((r: any) => nameOf.set(String(r._id), r.fullName));

    const fallback: Record<string, string> = {
      Merchant: 'Vendor', Cashier: 'Cashier', ResellerOperator: 'Reseller', Platform: 'Platform',
    };
    const withActor = pageRows.map((r) => ({
      ...r,
      actorName: (r.actorId && nameOf.get(r.actorId)) || fallback[r.actorType] || 'Unknown',
    }));

    const hasMore = merged.length > start + limit;
    return { transactions: withActor, page, limit, hasMore };
  }
}
