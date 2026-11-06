import mongoose from 'mongoose';
import { VenuePayment } from '@models/venuePayment.model';
import { Table } from '@models/table.model';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { IVenuePayment, TenderMethod, VenuePaymentSource } from '@interfaces/venuePayment.interface';
import { sumTenders } from '@utils/tenders.util';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

export interface PaymentFilters {
  from: Date; to: Date;
  method?: TenderMethod; staffId?: string; merchantId?: string; source?: VenuePaymentSource; reference?: string;
}

export interface PaymentRow {
  id: string; at: Date; source: VenuePaymentSource; where: string; tableId: string | null;
  staffName: string; takenByType: 'Waiter' | 'MerchantOperator';
  cash: number; card: number; tip: number; total: number; references: string[]; byItems: boolean;
}

const whereOf = (p: IVenuePayment) => (p.source === 'table' ? `Table ${p.tableLabel}` : `Counter · ${p.merchantName}`);

function toRow(p: IVenuePayment): PaymentRow {
  const sums = sumTenders(p.tenders);
  return {
    id: String(p._id), at: p.at, source: p.source, where: whereOf(p), tableId: p.tableId ? String(p.tableId) : null,
    staffName: p.staffName, takenByType: p.takenByType,
    cash: sums.cash, card: sums.card, tip: sums.tips, total: sums.applied + sums.tips,
    references: p.tenders.flatMap((t) => (t.reference ? [t.reference] : [])), byItems: !!p.lines?.length,
  };
}

/** The dashboard's read of a venue's money (venue trading Phase 3). Read-only. */
export class VenuePaymentService {
  static async list(venueIdRaw: string, filters: PaymentFilters, page: number, limit: number) {
    const venueId = oid(venueIdRaw);
    const match: Record<string, unknown> = { venueId, at: { $gte: filters.from, $lt: filters.to } };
    if (filters.method) match['tenders.method'] = filters.method;
    if (filters.staffId) match['takenBy'] = filters.staffId;
    if (filters.merchantId) match['merchantIds'] = oid(filters.merchantId);
    if (filters.source) match['source'] = filters.source;
    if (filters.reference) match['tenders.reference'] = filters.reference;

    const [rows, total, byMethod, open, staff, stalls] = await Promise.all([
      VenuePayment.find(match).sort({ at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean<IVenuePayment[]>(),
      VenuePayment.countDocuments(match),
      // The WHOLE filtered range, never just the page.
      VenuePayment.aggregate<{ _id: TenderMethod; amount: number; tip: number }>([
        { $match: match }, { $unwind: '$tenders' },
        { $group: { _id: '$tenders.method', amount: { $sum: '$tenders.amount' }, tip: { $sum: '$tenders.tip' } } },
      ]),
      // "Now": independent of the date range.
      Table.aggregate<{ unpaid: number }>([
        { $match: { venueId, status: 'open' } },
        { $group: { _id: null, unpaid: { $sum: { $subtract: ['$subtotal', { $ifNull: ['$paidTotal', 0] }] } } } },
      ]),
      VenuePayment.aggregate<{ _id: { id: string; type: string }; name: string }>([
        { $match: { venueId } }, { $sort: { at: 1 } },
        { $group: { _id: { id: '$takenBy', type: '$takenByType' }, name: { $last: '$staffName' } } },
      ]),
      Merchant.find({ venueId }).select('name').sort({ name: 1 }).lean<{ _id: mongoose.Types.ObjectId; name: string }[]>(),
    ]);

    const of = (method: TenderMethod) => byMethod.find((m) => m._id === method) ?? { amount: 0, tip: 0 };
    const [cash, card] = [of('cash'), of('card')];
    return {
      payments: rows.map(toRow),
      totals: { sales: cash.amount + card.amount, cash: cash.amount, card: card.amount, tips: cash.tip + card.tip, cashTips: cash.tip, cardTips: card.tip },
      unpaidOnOpenTables: open[0]?.unpaid ?? 0,
      filterOptions: {
        staff: staff.map((s) => ({ id: s._id.id, name: s.name, type: s._id.type })).sort((a, b) => a.name.localeCompare(b.name)),
        stalls: stalls.map((s) => ({ id: String(s._id), name: s.name })),
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * One payment in full. Null when it is not this venue's. A payment whose own
   * sale or table is missing is corruption (both are written with, or before,
   * the payment) and throws — it is never answered as an empty stand-in.
   */
  static async detail(venueIdRaw: string, paymentId: string) {
    const venueId = oid(venueIdRaw);
    const payment = await VenuePayment.findOne({ _id: oid(paymentId), venueId }).lean<IVenuePayment | null>();
    if (!payment) return null;
    const row = toRow(payment);
    const head = { ...row, tenders: payment.tenders, applied: payment.applied, tips: payment.tips };

    if (payment.source === 'counter') {
      const charge = await MerchantCharge.findOne({ _id: payment.merchantChargeId, venueId }).select('items').lean();
      if (!charge) throw new Error('that payment\'s sale is not on record');
      const items = (charge.items ?? []).map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice, lineTotal: i.lineTotal }));
      return { ...head, covers: { kind: 'sale' as const, items } };
    }

    const [table, others] = await Promise.all([
      Table.findOne({ _id: payment.tableId, venueId }).select('label status subtotal paidTotal items').lean(),
      VenuePayment.find({ venueId, tableId: payment.tableId, _id: { $ne: payment._id } }).sort({ at: 1 }).lean<IVenuePayment[]>(),
    ]);
    if (!table) throw new Error('that payment\'s table is not on record');
    const lineById = new Map((table.items ?? []).map((i) => [String(i._id), i]));
    const covers = payment.lines?.length
      ? {
          kind: 'items' as const,
          // A line removed since (it cannot be, once paid) would simply not resolve; a paid line always does.
          items: payment.lines.flatMap((l) => {
            const line = lineById.get(String(l.lineId));
            return line ? [{ name: line.name, qty: l.qty, unitPrice: line.unitPrice, lineTotal: line.unitPrice * l.qty }] : [];
          }),
        }
      : { kind: 'amount' as const };
    return {
      ...head, covers,
      table: {
        id: String(table._id), label: table.label, status: table.status, subtotal: table.subtotal, paidTotal: table.paidTotal ?? 0,
        otherPayments: others.map((p) => ({ id: String(p._id), at: p.at, staffName: p.staffName, applied: p.applied, tips: p.tips })),
      },
    };
  }
}
