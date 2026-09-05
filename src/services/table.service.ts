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
          // 'Platform' is the closest fit of the three fixed actor types
          // (stock.interface.ts): a waiter is neither a MerchantOperator (the
          // stall's own till, 'Merchant') nor the organizer's own admin action
          // ('Organizer') — and 'Platform' is otherwise unused, so this can't
          // be confused with either in a stock report.
          byType: 'Platform', by: addedBy, session,
        });

        result = updated;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
}
