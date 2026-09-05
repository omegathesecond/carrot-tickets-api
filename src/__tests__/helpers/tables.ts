/**
 * Shared fixtures for waiter-table tests (Tasks 8, 9, 10). Modelled on the
 * stall/product/stock seeding in merchantCharge.items.service.test.ts, so
 * a table's "stall" is exactly the same shape a merchant tap-to-pay sees:
 * a Merchant + a priced Product + a ProductStock row.
 *
 * price/onHand are REQUIRED, not defaulted, so no one task's numbers leak
 * into another's as an accidental default.
 */
import mongoose from 'mongoose';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { Table } from '@models/table.model';
import { ITable } from '@interfaces/table.interface';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';
import { StockService } from '@services/stock.service';

/** The one event every fixture in this file seeds against. */
export const EVENT = new mongoose.Types.ObjectId();

let tableLabelSeq = 0;

export interface SeedStallOptions {
  price: number;
  onHand: number;
  name?: string;
  category?: ProductCategory;
  /**
   * The stall's own platform commission. Optional and defaulted to the
   * model's own 0 — only settlement cares, and pinning a non-zero default
   * here would silently change the arithmetic of every existing fixture.
   */
  commissionPercent?: number;
}

export interface SeededStall {
  merchantId: string;
  productId: string;
}

/** A Merchant on EVENT, a Product on it at `price` cents, stocked `onHand` units. */
export async function seedStall(opts: SeedStallOptions): Promise<SeededStall> {
  const merchant = await Merchant.create({
    name: 'Test Stall', eventId: EVENT,
    ...(opts.commissionPercent == null ? {} : { commissionPercent: opts.commissionPercent }),
  });
  const product = await Product.create({
    eventId: EVENT,
    name: opts.name ?? 'Beer',
    category: opts.category ?? ProductCategory.BEER,
    price: opts.price,
  });
  // Mirrors merchantCharge.items.service.test.ts's seed(): only write a
  // RECEIVE movement when there is one, since applyMovement rejects a
  // zero delta — a fixture asking for onHand:0 must still be able to seed
  // a stall that carries the product but has none on the shelf.
  if (opts.onHand) {
    await StockService.applyMovement({
      eventId: EVENT, merchantId: merchant._id, productId: product._id,
      delta: opts.onHand, reason: StockMovementReason.RECEIVE,
      byType: 'Organizer', by: String(merchant._id),
    });
  }
  return { merchantId: String(merchant._id), productId: String(product._id) };
}

export interface SeededStallAndTable extends SeededStall {
  table: ITable;
}

/** seedStall, plus a fresh OPEN table at EVENT (a distinct label per call). */
export async function seedStallAndTable(opts: SeedStallOptions): Promise<SeededStallAndTable> {
  const { merchantId, productId } = await seedStall(opts);
  const table = await Table.create({
    eventId: EVENT, label: `T${tableLabelSeq++}`, status: 'open',
    openedBy: 'fixture-waiter', items: [], subtotal: 0,
  });
  return { table, merchantId, productId };
}

/** Current on-hand for a stall/product, so a test asserts the shelf, not the movement log. */
export async function onHandFor(merchantId: string, productId: string): Promise<number> {
  return StockService.getOnHand(merchantId, productId);
}
