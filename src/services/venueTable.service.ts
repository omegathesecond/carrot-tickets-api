import mongoose from 'mongoose';
import { Table } from '@models/table.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { VenuePayment } from '@models/venuePayment.model';
import { ITable, ITableOrder, TableOrderStatus, TableStatus } from '@interfaces/table.interface';
import { IVenuePayment } from '@interfaces/venuePayment.interface';
import { StockMovementReason } from '@interfaces/stock.interface';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { advanceArrayRow, waiterNames, TableService, TableAlreadySettledError, TableFulfilmentNotFoundError, TableFulfilmentStateError, WaiterTableView } from '@services/table.service';
import { TenderInput, normalizeTenders, sumTenders } from '@utils/tenders.util';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** A table with anything on it, or anything paid, is not the waiter's to close. */
export class WalkoutNeedsManagerError extends Error {
  constructor() {
    super('Walkouts are closed by a manager');
    this.name = 'WalkoutNeedsManagerError';
  }
}

export interface RoundItem { merchantId: string; productId: string; qty: number }

/** A round's item that the shelf could not cover — the whole round rolled back. */
export class RoundOutOfStockError extends Error {
  readonly reason = 'insufficient_stock';
  constructor(public productId: string, public productName: string, public available: number) {
    super(`Out of stock: ${productName}`);
    this.name = 'RoundOutOfStockError';
  }
}

/** Control flow: the round was already sent (a retry). Carries the table as it stands. */
class ReplayedRound extends Error {
  constructor(public table: ITable) { super('replayed round'); }
}

const sentAlready = (table: ITable, clientTxnId: string) => (table.orders ?? []).some((o) => o.clientTxnId === clientTxnId);

/**
 * Money already taken, and removing this line would leave nothing to pay: the
 * table would sit `open` with no balance, which no payment can ever close — so
 * the stalls' takings for money already in the till would never be written.
 * (A part payment without `lines` raises `paidTotal` and marks no line paid, so
 * the line's own `paidQty` guard cannot see it.)
 */
const strandsPaidBill = (table: ITable, lineTotal: number): boolean => (table.paidTotal ?? 0) > 0 && table.subtotal - lineTotal <= (table.paidTotal ?? 0);
const PART_PAID_REMOVAL = 'part of this bill is paid — that item can no longer be removed';

/** A line that can no longer be taken off the bill. */
export class LineLockedError extends Error {
  constructor(message: string) { super(message); this.name = 'LineLockedError'; }
}

/** A payment the bill does not allow. 400 — nothing is written. */
export class PaymentRefusedError extends Error {
  constructor(message: string, public reason: string, public detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PaymentRefusedError';
  }
}

/** The balance moved while this payment was being taken: a round landed, or someone else paid. */
export class BillChangedError extends Error {
  readonly reason = 'bill_changed';
  constructor() { super('the bill changed — check the balance'); this.name = 'BillChangedError'; }
}

export class PaymentIdempotencyMismatchError extends Error {
  readonly reason = 'idempotency_mismatch';
  constructor() { super('that payment id was already used for a different payment'); this.name = 'PaymentIdempotencyMismatchError'; }
}

/** Control flow: this clientTxnId already committed (a retry). */
class ReplayedPayment extends Error {}

export interface TablePayment { payment: IVenuePayment; table: ITable; closed: boolean }

export interface StallOrderView {
  tableId: string; tableLabel: string; orderId: string; status: TableOrderStatus;
  sentAt: Date; handedOutAt?: Date; acceptedAt?: Date; waiterName: string;
  items: Array<{ name: string; qty: number; unitPrice: number }>; total: number;
}

/** One order as its stall sees it: only that order's own lines, and who sent it. */
function stallOrderViewOf(table: ITable, order: ITableOrder, names: Map<string, string>): StallOrderView {
  const items = table.items.filter((l) => String(l.orderId) === String(order._id)).map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice }));
  return {
    tableId: String(table._id), tableLabel: table.label, orderId: String(order._id), status: order.status,
    sentAt: order.sentAt, ...(order.handedOutAt ? { handedOutAt: order.handedOutAt } : {}), ...(order.acceptedAt ? { acceptedAt: order.acceptedAt } : {}),
    waiterName: names.get(order.sentBy) ?? 'Unknown waiter',
    items, total: items.reduce((sum, l) => sum + l.unitPrice * l.qty, 0),
  };
}

export interface VenueTableRow {
  id: string; label: string; status: TableStatus; waiterId: string; waiterName: string; openedAt: Date;
  subtotal: number; paidTotal: number;
  /** What is still owed. On a voided table this is what was written off. */
  balance: number;
  orders: { sent: number; handedOut: number; collected: number };
  settledAt?: Date; voidedAt?: Date; voidReason?: string;
}

export interface VenueTableDetail extends VenueTableRow {
  items: Array<{ lineId: string; name: string; unitPrice: number; qty: number; paidQty: number; merchantId: string; merchantName: string; orderId: string | null }>;
  rounds: Array<{ orderId: string; merchantId: string; merchantName: string; status: TableOrderStatus; sentAt: Date; handedOutAt?: Date; acceptedAt?: Date; lineIds: string[] }>;
  payments: Array<{ id: string; at: Date; staffName: string; applied: number; tips: number; tenders: IVenuePayment['tenders'] }>;
}

function toRow(t: WaiterTableView): VenueTableRow {
  const orders = t.orders ?? [];
  const count = (status: TableOrderStatus) => orders.filter((o) => o.status === status).length;
  const paidTotal = t.paidTotal ?? 0;
  return {
    id: String(t._id), label: t.label, status: t.status, waiterId: t.openedBy, waiterName: t.openedByName, openedAt: t.createdAt,
    subtotal: t.subtotal, paidTotal, balance: t.subtotal - paidTotal,
    orders: { sent: count('sent'), handedOut: count('handed_out'), collected: count('collected') },
    ...(t.settledAt ? { settledAt: t.settledAt } : {}), ...(t.voidedAt ? { voidedAt: t.voidedAt } : {}), ...(t.voidReason ? { voidReason: t.voidReason } : {}),
  };
}

/**
 * What a VENUE table does that an event table does not (venue trading Phase 3):
 * rounds sent to the bar, a handover per round, payments against a running
 * bill. Event tables stay in TableService; the two share open / list / void.
 */
export class VenueTableService {
  /**
   * A waiter cancels a table opened by mistake. Only an EMPTY table with
   * nothing paid: anything else is a walkout, which a manager closes from the
   * dashboard (TableService.voidTable) so the write-off has an owner.
   */
  static async cancelEmptyTable(params: { venueId: string; tableId: string; reason: string; voidedBy: string }): Promise<ITable> {
    const reason = params.reason.trim();
    if (!reason) throw new Error('reason is required');
    const mine = { _id: oid(params.tableId), venueId: oid(params.venueId) };
    const updated = await Table.findOneAndUpdate(
      { ...mine, status: 'open', items: { $size: 0 }, paidTotal: 0 },
      { $set: { status: 'voided', voidedAt: new Date(), voidReason: reason, voidedBy: params.voidedBy } },
      { new: true },
    );
    if (updated) return updated;
    const existing = await Table.findOne(mine);
    if (!existing) throw new Error('table not found');
    if (existing.status !== 'open') throw new Error(`table is not open (status: ${existing.status})`);
    throw new WalkoutNeedsManagerError();
  }

  /**
   * Send a round. ONE transaction: the lines, one order row per stall, and
   * every stock movement — a single short item rolls all of it back. A retry
   * with the same clientTxnId returns the table as it stands.
   */
  static async sendOrder(params: { venueId: string; tableId: string; clientTxnId: string; items: RoundItem[]; sentBy: string }): Promise<ITable> {
    const { clientTxnId, sentBy } = params;
    const venueId = oid(params.venueId);
    const mine = { _id: oid(params.tableId), venueId };

    const table = await Table.findOne(mine);
    if (!table) throw new Error('table not found');
    if (sentAlready(table, clientTxnId)) return table;
    if (table.status !== 'open') throw new Error(`table is not open (status: ${table.status})`);

    // The same product from the same stall twice in one round is one line.
    const merged = new Map<string, RoundItem>();
    for (const item of params.items) {
      const key = `${item.merchantId}:${item.productId}`;
      merged.set(key, { ...item, qty: (merged.get(key)?.qty ?? 0) + item.qty });
    }
    const merchantIds = [...new Set(params.items.map((i) => i.merchantId))];
    const productIds = [...new Set(params.items.map((i) => i.productId))];

    const [stalls, products, stockRows] = await Promise.all([
      Merchant.find({ _id: { $in: merchantIds.map(oid) }, venueId, status: 'active' }).select('_id').lean(),
      Product.find({ _id: { $in: productIds.map(oid) }, venueId, active: true }).select('name price').lean<{ _id: mongoose.Types.ObjectId; name: string; price: number }[]>(),
      ProductStock.find({ merchantId: { $in: merchantIds.map(oid) }, productId: { $in: productIds.map(oid) } }).select('merchantId productId').lean(),
    ]);
    if (stalls.length !== merchantIds.length) throw new Error('stall not found at this venue');
    if (products.length !== productIds.length) throw new Error('product not found at this venue');
    const productById = new Map(products.map((p) => [String(p._id), p]));
    const stocked = new Set(stockRows.map((r) => `${r.merchantId}:${r.productId}`));

    const now = new Date();
    const orderIdOf = new Map(merchantIds.map((id) => [id, new mongoose.Types.ObjectId()]));
    const lines = [...merged.entries()].map(([key, item]) => {
      const product = productById.get(item.productId)!;
      if (!stocked.has(key)) throw new Error(`${product.name} is not sold at that stall`);
      return {
        _id: new mongoose.Types.ObjectId(), merchantId: oid(item.merchantId), productId: oid(item.productId),
        name: product.name, unitPrice: product.price, qty: item.qty, addedBy: sentBy, addedAt: now,
        orderId: orderIdOf.get(item.merchantId)!, paidQty: 0,
      };
    });
    const orders = merchantIds.map((merchantId) => ({
      _id: orderIdOf.get(merchantId)!, merchantId: oid(merchantId),
      lineIds: lines.filter((l) => String(l.merchantId) === merchantId).map((l) => l._id),
      clientTxnId, status: 'sent' as const, sentAt: now, sentBy,
    }));
    const total = lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);

    const session = await mongoose.startSession();
    let sent: ITable | undefined;
    try {
      await session.withTransaction(async () => {
        const updated = await Table.findOneAndUpdate(
          { ...mine, status: 'open', 'orders.clientTxnId': { $ne: clientTxnId } },
          { $push: { items: { $each: lines }, orders: { $each: orders } }, $inc: { subtotal: total, revision: 1 } },
          { new: true, session },
        );
        if (!updated) {
          const current = await Table.findOne(mine).session(session);
          if (!current) throw new Error('table not found');
          if (sentAlready(current, clientTxnId)) throw new ReplayedRound(current);
          throw new Error(`table is not open (status: ${current.status})`);
        }
        for (const line of lines) {
          try {
            await StockService.applySaleMovement({
              venueId, merchantId: line.merchantId, productId: line.productId, delta: -line.qty,
              reason: StockMovementReason.SALE, refType: 'table_order', refId: String(line.orderId),
              byType: 'Waiter', by: sentBy, session,
            });
          } catch (e) {
            if (e instanceof StockDeclinedError) throw new RoundOutOfStockError(String(line.productId), line.name, e.available);
            throw e;
          }
        }
        sent = updated;
      });
    } catch (e) {
      if (e instanceof ReplayedRound) return e.table;
      throw e;
    } finally {
      await session.endSession();
    }
    return sent!;
  }

  /**
   * One stall's queue: the rounds waiters have sent it, carrying only that
   * stall's own lines. `sent` reads oldest first (the next one to make).
   * A walked-out (voided) table has no one left to serve, so its rounds are
   * not queued; a SETTLED table's rounds stay — paying first is normal.
   */
  static async ordersForStall(params: { venueId: string; merchantId: string; status?: TableOrderStatus }): Promise<StallOrderView[]> {
    const { status } = params;
    const merchantId = oid(params.merchantId);
    const tables = await Table.find({
      venueId: oid(params.venueId),
      status: { $ne: 'voided' },
      orders: { $elemMatch: { merchantId, ...(status ? { status } : {}) } },
    }).sort({ updatedAt: -1 }).limit(200).lean<ITable[]>();

    const names = await waiterNames(tables.flatMap((t) => (t.orders ?? []).map((o) => o.sentBy)));
    const views = tables.flatMap((t) => (t.orders ?? [])
      .filter((o) => String(o.merchantId) === params.merchantId && (!status || o.status === status))
      .map((o) => stallOrderViewOf(t, o, names)));
    const time = (v: StallOrderView) => new Date(v.sentAt).getTime();
    return views.sort((a, b) => (status === 'sent' ? time(a) - time(b) : time(b) - time(a)));
  }

  /**
   * One order of a table as its stall sees it — read off the table an update
   * just returned, so a request that moved an order answers from the very row
   * it moved (a later change by someone else cannot make it vanish).
   */
  static async stallOrderView(table: ITable, orderId: string): Promise<StallOrderView> {
    const plain = TableService.plain(table);
    const order = (plain.orders ?? []).find((o) => String(o._id) === orderId);
    if (!order) throw new Error(`order ${orderId} is not on table ${String(plain._id)}`);
    return stallOrderViewOf(plain, order, await waiterNames([order.sentBy]));
  }

  /** The stall hands a round over the counter. `sent` → `handed_out`. */
  static async handOutOrder(params: { venueId: string; tableId: string; orderId: string; merchantId: string; handedOutBy: string }): Promise<ITable> {
    return VenueTableService.advanceOrder({
      ...params, row: { _id: oid(params.orderId), merchantId: oid(params.merchantId) },
      from: 'sent', to: 'handed_out', stamp: { handedOutAt: new Date(), handedOutBy: params.handedOutBy },
    });
  }

  /** The waiter takes it. `handed_out` → `collected`. */
  static async acceptOrder(params: { venueId: string; tableId: string; orderId: string; acceptedBy: string }): Promise<ITable> {
    return VenueTableService.advanceOrder({
      ...params, row: { _id: oid(params.orderId) },
      from: 'handed_out', to: 'collected', stamp: { acceptedAt: new Date(), acceptedBy: params.acceptedBy },
    });
  }

  private static async advanceOrder(params: {
    venueId: string; tableId: string; orderId: string; row: Record<string, unknown>;
    from: TableOrderStatus; to: TableOrderStatus; stamp: Record<string, unknown>;
  }): Promise<ITable> {
    const mine = { _id: oid(params.tableId), venueId: oid(params.venueId) };
    // A walked-out table's rounds are not served or collected: the guards live in the filter, not in a read before it.
    const updated = await advanceArrayRow({ table: { ...mine, status: { $ne: 'voided' } }, array: 'orders', row: params.row, from: params.from, to: params.to, stamp: params.stamp });
    if (updated) return updated;
    // Why not? A voided table answers first (409, before any ownership answer); after that a row of another stall reads exactly like a missing one.
    const current = await Table.findOne(mine).lean<ITable | null>();
    if (current?.status === 'voided') throw new TableAlreadySettledError('voided');
    const row = current?.orders?.find((o) => String(o._id) === params.orderId
      && (!params.row['merchantId'] || String(o.merchantId) === String(params.row['merchantId'])));
    if (!row) throw new TableFulfilmentNotFoundError();
    throw new TableFulfilmentStateError(row.status as any, params.from as any);
  }

  /**
   * Take a payment against a venue table. ONE transaction: the guarded table
   * update, the VenuePayment and — when it brings the bill to zero — one
   * MerchantCharge per stall. A table takes any number of payments; the one
   * that pays it off closes it, exactly once.
   */
  static async pay(params: {
    venueId: string; tableId: string; clientTxnId: string; tenders: TenderInput[];
    lines?: Array<{ lineId: string; qty: number }>; takenBy: string; staffName: string;
  }): Promise<TablePayment> {
    const { clientTxnId, takenBy, staffName } = params;
    const venueId = oid(params.venueId);
    const mine = { _id: oid(params.tableId), venueId };
    const tenders = normalizeTenders(params.tenders);
    const { applied, tips } = sumTenders(tenders);

    // A retry returns the payment it already made — never a second one.
    const replay = async (): Promise<TablePayment | null> => {
      const payment = await VenuePayment.findOne({ venueId, clientTxnId });
      if (!payment) return null;
      if (String(payment.tableId) !== params.tableId || payment.applied !== applied) throw new PaymentIdempotencyMismatchError();
      const table = await Table.findOne(mine);
      if (!table) throw new Error('table not found');
      // Closed BY this payment, not merely closed since: a replayed part payment still reads `false`.
      return { payment, table, closed: table.settleTxnId === clientTxnId };
    };

    // Read the bill FIRST, then look for an earlier attempt: a retry racing its
    // original that commits between the two reads must still find it (the other
    // order would refuse the retry against the state the original left).
    const table = await Table.findOne(mine);
    if (!table) throw new Error('table not found');
    const earlier = await replay();
    if (earlier) return earlier;
    if (table.status !== 'open') throw new TableAlreadySettledError(table.status);
    if (applied < 1) throw new PaymentRefusedError('a payment must take something off the bill', 'nothing_applied');
    const paidSoFar = table.paidTotal ?? 0;
    const outstanding = table.subtotal - paidSoFar;
    if (applied > outstanding) throw new PaymentRefusedError('that is more than the balance on this table', 'exceeds_balance', { outstanding });

    // Paying for specific items: within what is still unpaid on each line, and
    // the tenders must add up to exactly those items.
    const paying = new Map<string, number>();
    for (const l of params.lines ?? []) paying.set(l.lineId, (paying.get(l.lineId) ?? 0) + l.qty);
    let itemsTotal = 0;
    for (const [lineId, qty] of paying) {
      const line = table.items.find((i) => String(i._id) === lineId);
      if (!line) throw new PaymentRefusedError('line not found on this table', 'line_not_found', { lineId });
      const unpaid = line.qty - (line.paidQty ?? 0);
      if (qty > unpaid) throw new PaymentRefusedError(`only ${unpaid} of ${line.name} left to pay`, 'line_overpaid', { lineId, unpaid });
      itemsTotal += line.unitPrice * qty;
    }
    if (paying.size > 0 && itemsTotal !== applied) throw new PaymentRefusedError('the payment must equal the selected items', 'items_mismatch', { itemsTotal });

    const closing = paidSoFar + applied === table.subtotal;
    // Stall takings are attributed to the table's own waiter, whoever keyed the last payment.
    const tableWaiterName = closing ? (await waiterNames([table.openedBy])).get(table.openedBy) : undefined;
    if (closing && !tableWaiterName) throw new Error('the waiter who opened this table was not found');

    const now = new Date();
    const inc: Record<string, number> = { paidTotal: applied };
    const arrayFilters = [...paying.entries()].map(([lineId, qty], i) => {
      inc[`items.$[l${i}].paidQty`] = qty;
      return { [`l${i}._id`]: oid(lineId) };
    });

    const session = await mongoose.startSession();
    let out: TablePayment | undefined;
    try {
      await session.withTransaction(async () => {
        const updated = await Table.findOneAndUpdate(
          // The bill exactly as it was read: any round, removal or payment in between fails this.
          { ...mine, status: 'open', revision: table.revision, paidTotal: paidSoFar },
          { $inc: inc, ...(closing ? { $set: { status: 'settled', settledAt: now, settledBy: takenBy, settleTxnId: clientTxnId } } : {}) },
          { new: true, session, ...(arrayFilters.length ? { arrayFilters } : {}) },
        );
        if (!updated) {
          const current = await Table.findOne(mine).session(session);
          if (!current) throw new Error('table not found');
          if (await VenuePayment.exists({ venueId, clientTxnId }).session(session)) throw new ReplayedPayment();
          if (current.status !== 'open') throw new TableAlreadySettledError(current.status);
          throw new BillChangedError();
        }
        const [payment] = await VenuePayment.create([{
          venueId, source: 'table', tableId: mine._id, tableLabel: table.label,
          merchantIds: [...new Set(table.items.map((i) => String(i.merchantId)))].map(oid),
          clientTxnId, tenders, applied, tips,
          ...(paying.size ? { lines: [...paying.entries()].map(([lineId, qty]) => ({ lineId: oid(lineId), qty })) } : {}),
          takenBy, takenByType: 'Waiter', staffName, at: now,
        }], { session });

        if (closing) {
          const byStall = new Map<string, typeof table.items>();
          for (const line of table.items) byStall.set(String(line.merchantId), [...(byStall.get(String(line.merchantId)) ?? []), line]);
          const charges = [...byStall.entries()].map(([merchantId, lines]) => ({
            merchantId: oid(merchantId), venueId,
            amount: lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0),
            lines,
          })).filter((c) => c.amount >= 1).map((c) => ({
            merchantId: c.merchantId, venueId, amount: c.amount, fee: 0, netAmount: c.amount,
            clientTxnId: `${clientTxnId}:${c.merchantId}`, status: 'completed' as const,
            items: c.lines.map((l) => ({ productId: l.productId, name: l.name, unitPrice: l.unitPrice, qty: l.qty, lineTotal: l.unitPrice * l.qty })),
            waiterId: oid(table.openedBy), staffName: tableWaiterName!,
          }));
          // The money path fails loudly: what the stalls are credited must be exactly the bill.
          const takings = charges.reduce((sum, c) => sum + c.amount, 0);
          if (takings !== table.subtotal) throw new Error(`stall takings (${takings}) do not add up to the bill (${table.subtotal})`);
          // ordered: Mongoose saves an array in parallel on one transaction otherwise, which Mongo does not support.
          if (charges.length) await MerchantCharge.create(charges, { session, ordered: true });
        }
        out = { payment: payment!, table: updated, closed: closing };
      });
    } catch (e: any) {
      // Committed by an earlier attempt of this same request (or a duplicate key race): hand that one back.
      if (e instanceof ReplayedPayment || e?.code === 11000) {
        const again = await replay();
        if (again) return again;
      }
      throw e;
    } finally {
      await session.endSession();
    }
    return out!;
  }

  /**
   * Take a line off the bill — only while its round is still at the counter
   * (`sent`) and nothing has been paid against it. Its stock goes back. An
   * order left with no lines is removed with it.
   */
  static async removeLine(params: { venueId: string; tableId: string; lineId: string; removedBy: string }): Promise<ITable> {
    const venueId = oid(params.venueId);
    const mine = { _id: oid(params.tableId), venueId };
    const lineId = oid(params.lineId);

    const table = await Table.findOne(mine);
    if (!table) throw new Error('table not found');
    const line = table.items.find((l) => String(l._id) === params.lineId);
    if (!line) throw new Error('line not found on this table');
    if (table.status !== 'open') throw new Error(`table is not open (status: ${table.status})`);
    if ((line.paidQty ?? 0) > 0) throw new LineLockedError('that item is already paid for');
    const order = (table.orders ?? []).find((o) => String(o._id) === String(line.orderId));
    if (!order || order.status !== 'sent') throw new LineLockedError('that round has already been handed out');
    const lineTotal = line.unitPrice * line.qty;
    if (strandsPaidBill(table, lineTotal)) throw new LineLockedError(PART_PAID_REMOVAL);

    const session = await mongoose.startSession();
    let result: ITable | undefined;
    try {
      await session.withTransaction(async () => {
        const updated = await Table.findOneAndUpdate(
          {
            ...mine, status: 'open',
            items: { $elemMatch: { _id: lineId, paidQty: 0 } },
            orders: { $elemMatch: { _id: order._id, status: 'sent' } },
            // The same rule as the pre-check, enforced where it cannot go stale: a payment may land after the read.
            $expr: { $or: [{ $eq: ['$paidTotal', 0] }, { $gt: [{ $subtract: ['$subtotal', lineTotal] }, '$paidTotal'] }] },
          },
          { $pull: { items: { _id: lineId }, 'orders.$[order].lineIds': lineId }, $inc: { subtotal: -lineTotal, revision: 1 } },
          { new: true, session, arrayFilters: [{ 'order._id': order._id }] },
        );
        // It moved between the read and the write: handed out, paid, or closed.
        if (!updated) throw new LineLockedError('that item can no longer be removed — refresh the table');
        const emptied = await Table.findOneAndUpdate(
          { ...mine, orders: { $elemMatch: { _id: order._id, lineIds: { $size: 0 } } } },
          { $pull: { orders: { _id: order._id } } },
          { new: true, session },
        );
        await StockService.applySaleMovement({
          venueId, merchantId: line.merchantId, productId: line.productId, delta: line.qty,
          reason: StockMovementReason.MANUAL, refType: 'table_line_removed', refId: params.lineId,
          byType: 'Waiter', by: params.removedBy, session,
        });
        result = emptied ?? updated;
      });
    } finally {
      await session.endSession();
    }
    return result!;
  }

  /**
   * The manager's floor: the 200 most recent tables of one status, newest first.
   * `totals` cover EVERY table of that status — it is its own aggregate, because
   * the list is capped — and `truncated` says when the rows are fewer than the
   * totals, so a long history can never read as the whole picture.
   */
  static async dashboardList(params: { venueId: string; status: TableStatus }): Promise<{ tables: VenueTableRow[]; totals: { count: number; balance: number }; truncated: boolean }> {
    const [listed, [sum]] = await Promise.all([
      TableService.list({ venueId: params.venueId }, { status: params.status }),
      Table.aggregate<{ count: number; balance: number }>([
        { $match: { venueId: oid(params.venueId), status: params.status } },
        { $group: { _id: null, count: { $sum: 1 }, balance: { $sum: { $subtract: ['$subtotal', { $ifNull: ['$paidTotal', 0] }] } } } },
      ]),
    ]);
    const tables = listed.map(toRow);
    const totals = { count: sum?.count ?? 0, balance: sum?.balance ?? 0 };
    return { tables, totals, truncated: totals.count > tables.length };
  }

  /** One table in full: its lines, its rounds and every payment taken against it. Null when it is not this venue's. */
  static async dashboardDetail(params: { venueId: string; tableId: string }): Promise<VenueTableDetail | null> {
    const venueId = oid(params.venueId);
    const table = await Table.findOne({ _id: oid(params.tableId), venueId }).lean<ITable | null>();
    if (!table) return null;
    const [[view], payments] = await Promise.all([
      TableService.present([table]),
      VenuePayment.find({ venueId, tableId: table._id }).sort({ at: 1 }).lean<IVenuePayment[]>(),
    ]);
    const stallName = new Map(view!.items.map((i) => [String(i.merchantId), i.merchantName]));
    return {
      ...toRow(view!),
      items: view!.items.map((i) => ({
        lineId: String(i._id), name: i.name, unitPrice: i.unitPrice, qty: i.qty, paidQty: i.paidQty ?? 0,
        merchantId: String(i.merchantId), merchantName: i.merchantName, orderId: i.orderId ? String(i.orderId) : null,
      })),
      rounds: (table.orders ?? []).map((o) => ({
        orderId: String(o._id), merchantId: String(o.merchantId), merchantName: stallName.get(String(o.merchantId)) ?? 'Unknown stall',
        status: o.status, sentAt: o.sentAt, ...(o.handedOutAt ? { handedOutAt: o.handedOutAt } : {}), ...(o.acceptedAt ? { acceptedAt: o.acceptedAt } : {}),
        lineIds: o.lineIds.map(String),
      })),
      payments: payments.map((p) => ({ id: String(p._id), at: p.at, staffName: p.staffName, applied: p.applied, tips: p.tips, tenders: p.tenders })),
    };
  }
}
