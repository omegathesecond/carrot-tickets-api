import { NextFunction, Request, Response } from 'express';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { StockTransferService } from '@services/stockTransfer.service';
import { StockCountService } from '@services/stockCount.service';
import { StockAlertService } from '@services/stockAlert.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { createProductSchema, updateProductSchema, receiveStockSchema, thresholdSchema, transferStockSchema, stockCountSchema, allocationsSchema } from '@validators/stock.validator';
import { toBaseUnits } from '@utils/stockUnits.util';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

// Mirrors MerchantAdminController.loadOwnedEvent — a product/stock op is only
// allowed by the owner of the event it belongs to (super-admin bypasses).
async function loadOwnedEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  if (!eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return null; }
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  const actor = actorOf(req);
  if (!actor.isSuperAdmin && String(event.vendorId) !== actor.vendorId) {
    ApiResponseUtil.forbidden(res, 'Event belongs to a different vendor'); return null;
  }
  return event;
}

export class StockAdminController {
  /** POST /api/tickets/events/:eventId/products */
  static async createProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = createProductSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      try {
        const product = await Product.create({ ...value, eventId: event._id });
        ApiResponseUtil.created(res, product);
      } catch (e: any) {
        if (e?.code === 11000) { ApiResponseUtil.badRequest(res, 'A product with that barcode already exists at this event'); return; }
        throw e;
      }
    } catch (err) { next(err); }
  }

  /** GET /api/tickets/events/:eventId/products */
  static async listProducts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const products = await Product.find({ eventId: event._id }).sort({ name: 1 });
      ApiResponseUtil.success(res, products);
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/products/:id */
  static async updateProduct(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const product = await Product.findById(req.params['id']);
      if (!product) { ApiResponseUtil.notFound(res, 'Product not found'); return; }
      const event = await loadOwnedEvent(req, res, String(product.eventId));
      if (!event) return;
      const { error, value } = updateProductSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      Object.assign(product, value);
      try {
        await product.save();
      } catch (e: any) {
        if (e?.code === 11000) { ApiResponseUtil.badRequest(res, 'A product with that barcode already exists at this event'); return; }
        throw e;
      }
      ApiResponseUtil.success(res, product);
    } catch (err) { next(err); }
  }

  /** POST /api/tickets/events/:eventId/stock/receive */
  static async receiveStock(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = receiveStockSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }

      const merchant = await Merchant.findById(value.merchantId).lean();
      if (!merchant || String(merchant.eventId) !== String(event._id)) {
        ApiResponseUtil.badRequest(res, 'merchant does not belong to this event'); return;
      }
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) {
        ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return;
      }

      // Case->unit conversion: 'pack' quantities multiply by unitsPerPack.
      const baseUnits = toBaseUnits(product, value.quantity, value.unit);
      if (baseUnits == null) {
        ApiResponseUtil.badRequest(res, 'product has no pack size; receive in units'); return;
      }

      const actor = actorOf(req);
      const { onHand, movement } = await StockService.applyMovement({
        eventId: String(event._id),
        merchantId: value.merchantId,
        productId: value.productId,
        delta: baseUnits,
        reason: StockMovementReason.RECEIVE,
        refType: 'stock_receive',
        refId: String(movementRef()),
        byType: 'Organizer',
        by: actor.vendorId ?? 'platform',
        note: value.note,
      });
      // Fire-and-forget: a receive that pushes onHand back above threshold
      // re-arms the alert so the next downward crossing fires again. Never
      // await — a rearm failure must not turn a successful receive into a 500.
      StockAlertService.rearm(String(value.merchantId), String(value.productId)).catch(() => {});
      ApiResponseUtil.success(res, { onHand, movementId: String(movement._id) });
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/events/:eventId/stock/threshold */
  static async setThreshold(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = thresholdSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const merchant = await Merchant.findById(value.merchantId).lean();
      if (!merchant || String(merchant.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'merchant does not belong to this event'); return; }
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return; }
      // Upsert the bar-product stock row's threshold + re-arm (clear lowStockAlertedAt).
      const row = await ProductStock.findOneAndUpdate(
        { merchantId: value.merchantId, productId: value.productId },
        { $set: { lowStockThreshold: value.lowStockThreshold, lowStockAlertedAt: null }, $setOnInsert: { eventId: event._id, onHand: 0 } },
        { new: true, upsert: true },
      );
      ApiResponseUtil.success(res, { merchantId: value.merchantId, productId: value.productId, lowStockThreshold: row.lowStockThreshold });
    } catch (err) { next(err); }
  }

  /** POST /api/tickets/events/:eventId/stock/transfer */
  static async transferStock(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = transferStockSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      if (value.fromMerchantId === value.toMerchantId) { ApiResponseUtil.badRequest(res, 'cannot transfer to the same bar'); return; }
      for (const mid of [value.fromMerchantId, value.toMerchantId]) {
        const m = await Merchant.findById(mid).lean();
        if (!m || String(m.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'a merchant does not belong to this event'); return; }
      }
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return; }
      const actor = actorOf(req);
      try {
        const result = await StockTransferService.transfer({ eventId: String(event._id), productId: value.productId, fromMerchantId: value.fromMerchantId, toMerchantId: value.toMerchantId, qty: value.qty, byType: 'Organizer', by: actor.vendorId ?? 'platform', note: value.note });
        ApiResponseUtil.success(res, { transferId: String(result.transfer._id), fromOnHand: result.fromOnHand, toOnHand: result.toOnHand });
      } catch (e: any) {
        if (e instanceof StockDeclinedError) { ApiResponseUtil.error(res, 'Insufficient stock at source', 409, { reason: e.reason, productId: e.productId, available: e.available }); return; }
        throw e;
      }
    } catch (err) { next(err); }
  }

  /** POST /api/tickets/events/:eventId/stock/count */
  static async recordCount(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = stockCountSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const merchant = await Merchant.findById(value.merchantId).lean();
      if (!merchant || String(merchant.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'merchant does not belong to this event'); return; }
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) { ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return; }
      const actor = actorOf(req);
      const { count, onHand } = await StockCountService.recordCount({
        eventId: String(event._id), merchantId: value.merchantId, productId: value.productId,
        countedOnHand: value.countedOnHand, phase: value.phase, byType: 'Organizer', by: actor.vendorId ?? 'platform',
      });
      ApiResponseUtil.success(res, { countId: String(count._id), expectedOnHand: count.expectedOnHand, countedOnHand: count.countedOnHand, variance: count.variance, onHand });
    } catch (err) { next(err); }
  }

  /** GET /api/tickets/events/:eventId/stock/allocations */
  static async listAllocations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const products = await Product.find({ eventId: event._id }, { _id: 1 }).lean();
      const rows = await ProductStock.find(
        { eventId: event._id, productId: { $in: products.map((p) => p._id) } },
        { productId: 1, merchantId: 1 },
      ).lean();
      // Every product gets a key, even with no stalls — the dashboard needs the
      // empty list to flag "not on any stall" rather than infer it from absence.
      const allocations: Record<string, string[]> = {};
      for (const p of products) allocations[String(p._id)] = [];
      for (const r of rows) allocations[String(r.productId)]?.push(String(r.merchantId));
      ApiResponseUtil.success(res, { allocations });
    } catch (err) { next(err); }
  }

  /** PUT /api/tickets/events/:eventId/stock/allocations */
  static async setAllocations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = allocationsSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }

      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(event._id)) {
        ApiResponseUtil.badRequest(res, 'product does not belong to this event'); return;
      }
      const wanted: string[] = [...new Set<string>(value.merchantIds.map(String))];
      if (wanted.length) {
        const merchants = await Merchant.find(
          { _id: { $in: wanted }, eventId: event._id }, { _id: 1 },
        ).lean();
        if (merchants.length !== wanted.length) {
          ApiResponseUtil.badRequest(res, 'one or more stalls do not belong to this event'); return;
        }
      }

      const existing = await ProductStock.find({ eventId: event._id, productId: product._id }).lean();
      const want = new Set(wanted);

      const toRemove = existing.filter((r) => !want.has(String(r.merchantId)));
      // Deleting a row that still holds stock would discard inventory the
      // StockMovement ledger still accounts for, silently desyncing the
      // reconciliation report. Refuse the WHOLE request rather than delisting
      // the empty stalls and rejecting the rest — a partial apply would leave
      // the catalogue changed in a way the caller never asked for.
      const held = toRemove.filter((r) => (r.onHand ?? 0) > 0);
      if (held.length) {
        const names = await Merchant.find(
          { _id: { $in: held.map((r) => r.merchantId) } }, { name: 1 },
        ).lean();
        const byId = new Map(names.map((m) => [String(m._id), m.name]));
        const detail = held
          .map((r) => `${byId.get(String(r.merchantId)) ?? 'stall'} (${r.onHand})`)
          .join(', ');
        ApiResponseUtil.badRequest(
          res,
          `Cannot remove a stall that still holds stock: ${detail}. Transfer it, or record a count of 0, first.`,
        );
        return;
      }

      // Upsert rather than read-then-create: $setOnInsert cannot touch an
      // existing document, so "re-allocating never resets an existing
      // quantity" holds by construction, not by the `existing` snapshot above
      // staying fresh. This also makes a double-clicked Save (or any
      // concurrent receive/threshold/count for the same pair) collide safely
      // on the {merchantId,productId} unique index instead of raising E11000
      // — mirrors setThreshold's upsert above.
      for (const merchantId of wanted) {
        await ProductStock.updateOne(
          { merchantId, productId: product._id },
          { $setOnInsert: { eventId: event._id, onHand: 0 } },
          { upsert: true },
        );
      }
      if (toRemove.length) {
        // onHand: 0 re-checks at delete time rather than trusting the read at
        // the top of this handler — a receive landing in that window would
        // otherwise delete a row StockMovement still accounts for, silently
        // desyncing the reconciliation report. On the happy path every row in
        // toRemove already read as 0, so this clause is a no-op there.
        const { deletedCount } = await ProductStock.deleteMany({
          _id: { $in: toRemove.map((r) => r._id) }, onHand: 0,
        });
        if (deletedCount !== toRemove.length) {
          ApiResponseUtil.error(res, 'Stock arrived at a stall while this was saving — reload and try again', 409);
          return;
        }
      }

      ApiResponseUtil.success(res, { allocated: wanted.sort() });
    } catch (err) { next(err); }
  }
}

// A receive is organiser-initiated and not client-idempotent in v1; a fresh
// ObjectId gives each receive a stable refId for provenance without a
// clientTxnId contract (the sale path in Slice 2 will carry a real clientTxnId).
import mongoose from 'mongoose';
function movementRef() { return new mongoose.Types.ObjectId(); }
