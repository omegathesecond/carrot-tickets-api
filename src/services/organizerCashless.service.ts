// api/src/services/organizerCashless.service.ts
import mongoose from 'mongoose';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Merchant } from '@models/merchant.model';
import { Cashier } from '@models/cashier.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { Wallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';

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
   * Every band UID ever seen in this event that matches `q`, resolved to the
   * WALLETS behind them. A UID search must go through the binding history and
   * not just `wallet.bandUid`: a reissued tag leaves its old UID only in
   * BandBinding, and the organizer searching the number printed on the plastic
   * they are holding is exactly the reissue case.
   */
  private static async walletIdsForTagQuery(eid: mongoose.Types.ObjectId, q: string) {
    // Escaped — a UID typed by an organizer is user input, and an unescaped
    // regex here is both a correctness bug and a ReDoS foothold.
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [wallets, bindings] = await Promise.all([
      Wallet.find({ eventId: eid, bandUid: rx }).select('_id').lean(),
      BandBinding.find({ eventId: eid, bandUid: rx }).select('walletId').lean(),
    ]);
    return [
      ...new Set([
        ...wallets.map((w: any) => String(w._id)),
        ...bindings.map((b: any) => String(b.walletId)),
      ]),
    ];
  }

  /**
   * The UID that was on a wallet at a given moment. Top-ups and cash-outs are
   * recorded against the wallet, not the plastic, so the tag column has to be
   * reconstructed from the binding that was live at the time — showing the
   * CURRENT uid against a pre-reissue top-up would misattribute it to a tag
   * that did not exist yet.
   */
  private static tagAt(bindings: Array<{ bandUid: string; boundAt: Date; unboundAt?: Date | null }>, at: Date) {
    const t = new Date(at).getTime();
    const live = bindings.find((b) => {
      const from = new Date(b.boundAt).getTime();
      const to = b.unboundAt ? new Date(b.unboundAt).getTime() : Infinity;
      return t >= from && t <= to;
    });
    return live?.bandUid ?? null;
  }

  /**
   * The full event transaction log — top-ups, withdrawals, and vendor charges —
   * merged, newest first, page-bounded. `type` filters to one kind, `tagUid`
   * narrows to one band (matched against every UID that band has ever carried).
   * Simple skip/limit paging (the organizer report is a reviewing surface, not
   * a hot path); returns `hasMore` so the dashboard can page.
   */
  static async transactions(params: {
    eventId: string;
    type?: 'topup' | 'withdrawal' | 'purchase';
    tagUid?: string;
    page?: number;
    limit?: number;
  }) {
    const { eventId, type } = params;
    const eid = oid(eventId);
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const page = Math.max(params.page ?? 1, 1);
    const tagUid = params.tagUid?.trim();

    // A UID that has never been bound in this event matches nothing — an empty
    // page, not every transaction in the event.
    let walletScope: Record<string, unknown> = {};
    if (tagUid) {
      const walletIds = await OrganizerCashlessService.walletIdsForTagQuery(eid, tagUid);
      if (walletIds.length === 0) return { transactions: [], page, limit, hasMore: false };
      walletScope = { walletId: { $in: walletIds.map(oid) } };
    }

    // Over-fetch each source to the page window, merge, then slice — correct for
    // a reviewing surface without a cross-collection cursor.
    const window = page * limit + 1;
    const wantTopups = !type || type === 'topup';
    const wantWithdrawals = !type || type === 'withdrawal';
    const wantPurchases = !type || type === 'purchase';

    const [topups, withdrawals, charges] = await Promise.all([
      wantTopups ? WalletTopup.find({ eventId: eid, ...walletScope }).sort({ createdAt: -1 }).limit(window).lean() : [],
      wantWithdrawals ? WalletWithdrawal.find({ eventId: eid, ...walletScope }).sort({ createdAt: -1 }).limit(window).lean() : [],
      wantPurchases ? MerchantCharge.find({ eventId: eid, ...walletScope }).sort({ createdAt: -1 }).limit(window).lean() : [],
    ]);

    const merged = [
      ...topups.map((t: any) => ({ id: String(t._id), type: 'topup' as const, amount: t.amount, at: t.createdAt, ref: t.clientTxnId ?? null, status: t.status ?? 'completed', walletId: String(t.walletId), actorType: t.recordedByType, actorId: t.recordedBy ? String(t.recordedBy) : null })),
      ...withdrawals.map((w: any) => ({ id: String(w._id), type: 'withdrawal' as const, amount: w.amount, at: w.createdAt, ref: w.clientTxnId ?? null, status: w.status ?? 'completed', walletId: String(w.walletId), actorType: w.recordedByType, actorId: w.recordedBy ? String(w.recordedBy) : null })),
      ...charges.map((c: any) => ({ id: String(c._id), type: 'purchase' as const, amount: c.amount, at: c.createdAt, ref: c.clientTxnId ?? null, status: c.status ?? 'completed', walletId: String(c.walletId), bandUid: c.bandUid, fee: c.fee, netAmount: c.netAmount, actorType: 'Merchant', actorId: c.merchantId ? String(c.merchantId) : null })),
    ].sort((a: any, b: any) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const start = (page - 1) * limit;
    const pageRows: any[] = merged.slice(start, start + limit);

    // Resolve WHO for just this page — the vendor name on a purchase, the
    // cashier/reseller name on a top-up or cash-out. Batched per population so a
    // page costs at most 3 extra look-ups regardless of row count.
    const idsOfType = (t: string) =>
      [...new Set(pageRows.filter((r) => r.actorType === t && r.actorId && /^[0-9a-fA-F]{24}$/.test(r.actorId)).map((r) => r.actorId))];
    const walletIdsOnPage = [...new Set(pageRows.map((r) => r.walletId).filter((id) => id && /^[0-9a-fA-F]{24}$/.test(id)))];
    const [merchants, cashiers, resellers, bindings] = await Promise.all([
      Merchant.find({ _id: { $in: idsOfType('Merchant').map(oid) } }).select('name').lean(),
      Cashier.find({ _id: { $in: idsOfType('Cashier').map(oid) } }).select('fullName').lean(),
      ResellerOperator.find({ _id: { $in: idsOfType('ResellerOperator').map(oid) } }).select('fullName').lean(),
      BandBinding.find({ walletId: { $in: walletIdsOnPage.map(oid) } }).sort({ boundAt: -1 }).lean(),
    ]);
    const nameOf = new Map<string, string>();
    merchants.forEach((m: any) => nameOf.set(String(m._id), m.name));
    cashiers.forEach((c: any) => nameOf.set(String(c._id), c.fullName));
    resellers.forEach((r: any) => nameOf.set(String(r._id), r.fullName));

    const bindingsByWallet = new Map<string, Array<{ bandUid: string; boundAt: Date; unboundAt?: Date | null }>>();
    bindings.forEach((b: any) => {
      const k = String(b.walletId);
      const list = bindingsByWallet.get(k) ?? [];
      list.push({ bandUid: b.bandUid, boundAt: b.boundAt, unboundAt: b.unboundAt ?? null });
      bindingsByWallet.set(k, list);
    });

    const fallback: Record<string, string> = {
      Merchant: 'Vendor', Cashier: 'Cashier', ResellerOperator: 'Reseller', Platform: 'Platform',
    };
    const withActor = pageRows.map((r) => ({
      ...r,
      actorName: (r.actorId && nameOf.get(r.actorId)) || fallback[r.actorType] || 'Unknown',
      // A charge carries the UID it was tapped with; wallet-side movements are
      // dated back to whichever tag was live at the time.
      tagUid: r.bandUid ?? OrganizerCashlessService.tagAt(bindingsByWallet.get(r.walletId) ?? [], r.at),
    }));

    const hasMore = merged.length > start + limit;
    return { transactions: withActor, page, limit, hasMore };
  }
}
