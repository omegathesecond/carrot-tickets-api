import mongoose from 'mongoose';
import { Table } from '@models/table.model';
import { ITable } from '@interfaces/table.interface';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';

/** Thrown when a label is already open at this event — the caller maps it to 409. */
export class TableLabelTakenError extends Error {
  constructor(label: string) { super(`Table ${label} is already open`); }
}

export class TableService {
  static async open(params: { eventId: string; label: string; openedBy: string }): Promise<ITable> {
    const label = params.label.trim();
    if (!label) throw new Error('label is required');
    try {
      return await Table.create({
        eventId: new mongoose.Types.ObjectId(params.eventId),
        label, status: 'open', openedBy: params.openedBy, items: [], subtotal: 0,
      });
    } catch (err) {
      // The partial unique index is the arbiter, so two waiters opening "7" at
      // once cannot both win. Discriminated by keyPattern so an E11000 from any
      // other index is not mislabelled.
      if ((err as { keyPattern?: Record<string, unknown> })?.keyPattern?.label) {
        throw new TableLabelTakenError(label);
      }
      throw err;
    }
  }

  static async list(eventId: string, status?: string): Promise<ITable[]> {
    return Table.find({
      eventId: new mongoose.Types.ObjectId(eventId),
      ...(status ? { status } : {}),
    }).sort({ createdAt: -1 }).limit(200);
  }

  /**
   * Add one product line from a stall onto an open table, moving that
   * stall's stock in the same beat. name/unitPrice are SNAPSHOTTED from the
   * catalogue right now — a later price change at the stall must never
   * reprice a drink already drunk (ITableLine's documented invariant).
   */
  static async addItem(params: {
    tableId: string; eventId: string; merchantId: string; productId: string; qty: number; addedBy: string;
  }): Promise<ITable> {
    const { tableId, eventId, merchantId, productId, qty, addedBy } = params;
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('qty must be a positive whole number');

    const eventObjId = new mongoose.Types.ObjectId(eventId);
    const merchantObjId = new mongoose.Types.ObjectId(merchantId);
    const productObjId = new mongoose.Types.ObjectId(productId);
    const tableObjId = new mongoose.Types.ObjectId(tableId);

    // Resolved BEFORE the transaction, same reasoning as MerchantService.charge
    // resolving its item snapshots up front: prices are stable between here and
    // commit, so only the table push + the stock CAS below need to be atomic.
    const merchant = await Merchant.findOne({ _id: merchantObjId, eventId: eventObjId });
    if (!merchant) throw new Error('stall not found for this event');
    const product = await Product.findOne({ _id: productObjId, eventId: eventObjId, active: true });
    if (!product) throw new Error('product not found for this event');
    // A ProductStock row is what makes a product "sold at" a stall — the same
    // relationship StockService.applyMovement's own CAS depends on. No row
    // means this stall never stocked the product, whatever event it belongs to.
    const stockRow = await ProductStock.findOne({ merchantId: merchantObjId, productId: productObjId });
    if (!stockRow) throw new Error('product not sold at that stall');

    const line = {
      merchantId: merchantObjId, productId: productObjId,
      name: product.name, unitPrice: product.price, qty, addedBy, addedAt: new Date(),
    };
    const lineTotal = product.price * qty;

    const session = await mongoose.startSession();
    try {
      let result!: ITable;
      await session.withTransaction(async () => {
        // Single guarded update: $push the line and $inc the subtotal in the
        // SAME atomic op, with status:'open' in the FILTER — a read-modify-save
        // here would let two concurrent adds both read the same items array
        // and one clobber the other's push.
        const updated = await Table.findOneAndUpdate(
          { _id: tableObjId, eventId: eventObjId, status: 'open' },
          { $push: { items: line }, $inc: { subtotal: lineTotal } },
          { new: true, session },
        );
        if (!updated) {
          const existing = await Table.findOne({ _id: tableObjId, eventId: eventObjId }).session(session);
          if (!existing) throw new Error('table not found');
          throw new Error(`table is not open (status: ${existing.status})`);
        }

        // Stock leaves the shelf when the waiter takes it, not when the tab is
        // settled — written in the SAME transaction as the table push, so a
        // decline here (out of stock) rolls the push back too.
        await StockService.applyMovement({
          eventId: eventObjId, merchantId: merchantObjId, productId: productObjId,
          delta: -qty, reason: StockMovementReason.SALE, refType: 'table', refId: tableId,
          // A waiter is neither the stall's own till ('Merchant') nor the
          // organizer's own admin action ('Organizer') — attributing their
          // movement to either would misreport who actually took the stock.
          byType: 'Waiter', by: addedBy, session,
        });

        result = updated;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Remove a mis-punched line. This is the "never left the counter" case —
   * the bottle goes back on the shelf, so the stall's stock must go back up.
   * Line-pull + subtotal-decrement + stock-return all happen in ONE
   * transaction, same idiom as addItem: a stock return that lands while the
   * line removal fails would credit the stall with a bottle it still doesn't
   * have back.
   */
  static async removeItem(params: { tableId: string; eventId: string; lineId: string; removedBy: string }): Promise<ITable> {
    const { tableId, eventId, lineId, removedBy } = params;
    const tableObjId = new mongoose.Types.ObjectId(tableId);
    const eventObjId = new mongoose.Types.ObjectId(eventId);
    const lineObjId = new mongoose.Types.ObjectId(lineId);

    // Resolved BEFORE the transaction, same reasoning as addItem's merchant/
    // product lookups: a line's merchantId/productId/unitPrice/qty are a
    // snapshot nothing else can mutate — only removal ever touches it — so
    // reading it up front races with nothing. eventId is in THIS filter too —
    // a table belonging to another event must read exactly like a missing
    // one, not surface a distinct "wrong event" error that would confirm to
    // a waiter at event A that some id exists at event B.
    const table = await Table.findOne({ _id: tableObjId, eventId: eventObjId });
    if (!table) throw new Error('table not found');
    const line = table.items.find((i) => String(i._id) === lineId);
    if (!line) throw new Error('line not found on this table');
    if (table.status !== 'open') throw new Error(`table is not open (status: ${table.status})`);
    const lineTotal = line.unitPrice * line.qty;

    const session = await mongoose.startSession();
    try {
      let result!: ITable;
      await session.withTransaction(async () => {
        // Single guarded update: $pull the line and $inc the subtotal down in
        // the SAME atomic op, with status:'open', eventId, AND the line's own
        // _id in the FILTER — so a concurrent settle/void, a concurrent
        // removal of the same line, or (as above) a cross-event id simply
        // fails to match rather than double-applying or leaking existence.
        const updated = await Table.findOneAndUpdate(
          { _id: tableObjId, eventId: eventObjId, status: 'open', 'items._id': lineObjId },
          { $pull: { items: { _id: lineObjId } }, $inc: { subtotal: -lineTotal } },
          { new: true, session },
        );
        if (!updated) {
          const existing = await Table.findOne({ _id: tableObjId, eventId: eventObjId }).session(session);
          if (!existing) throw new Error('table not found');
          if (existing.status !== 'open') throw new Error(`table is not open (status: ${existing.status})`);
          throw new Error('line not found on this table');
        }

        // The compensating movement is its OWN event (MANUAL, not a smaller
        // SALE) so the stock history can be read backwards: "this bottle came
        // back because a line was removed", not silently absorbed into the sale.
        await StockService.applyMovement({
          eventId: table.eventId, merchantId: line.merchantId, productId: line.productId,
          delta: line.qty, reason: StockMovementReason.MANUAL,
          refType: 'table_line_removed', refId: lineId,
          byType: 'Waiter', by: removedBy, session,
        });

        result = updated;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Close an unpaid table WITHOUT returning stock. The drinks were consumed
   * or the table walked out — that loss is real, and voidReason/voidedBy is
   * the venue's record of it. Returning stock here would let a walked table
   * look, on the shelf, exactly like a table that never happened. No
   * transaction needed: unlike addItem/removeItem this touches only the
   * table document, nothing in ProductStock.
   */
  static async voidTable(params: { tableId: string; eventId: string; reason: string; voidedBy: string }): Promise<ITable> {
    const { tableId, eventId, voidedBy } = params;
    const reason = params.reason.trim();
    if (!reason) throw new Error('reason is required');
    const eventObjId = new mongoose.Types.ObjectId(eventId);

    // eventId lives in BOTH the guarded update's filter and the fallback
    // lookup below — same reasoning as removeItem: a table belonging to
    // another event must be indistinguishable from a missing one, in every
    // branch, or the error message itself becomes the leak.
    const updated = await Table.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(tableId), eventId: eventObjId, status: 'open' },
      { $set: { status: 'voided', voidedAt: new Date(), voidReason: reason, voidedBy } },
      { new: true },
    );
    if (!updated) {
      const existing = await Table.findOne({ _id: tableId, eventId: eventObjId });
      if (!existing) throw new Error('table not found');
      throw new Error(`table is not open (status: ${existing.status})`);
    }
    return updated;
  }
}
