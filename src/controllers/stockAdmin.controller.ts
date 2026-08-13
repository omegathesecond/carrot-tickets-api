import { NextFunction, Request, Response } from 'express';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { createProductSchema, updateProductSchema, receiveStockSchema, thresholdSchema } from '@validators/stock.validator';

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
      const perPack = product.unitsPerPack && product.unitsPerPack > 0 ? product.unitsPerPack : 1;
      if (value.unit === 'pack' && perPack === 1) {
        ApiResponseUtil.badRequest(res, 'product has no pack size; receive in units'); return;
      }
      const baseUnits = value.unit === 'pack' ? value.quantity * perPack : value.quantity;

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
}

// A receive is organiser-initiated and not client-idempotent in v1; a fresh
// ObjectId gives each receive a stable refId for provenance without a
// clientTxnId contract (the sale path in Slice 2 will carry a real clientTxnId).
import mongoose from 'mongoose';
function movementRef() { return new mongoose.Types.ObjectId(); }
