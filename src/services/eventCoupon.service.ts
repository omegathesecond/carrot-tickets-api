import crypto from 'crypto';
import mongoose from 'mongoose';
import { EventCoupon } from '@models/eventCoupon.model';
import { TicketSale } from '@models/ticketSale.model';
import { Event } from '@models/event.model';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { CouponSnapshot, IEventCoupon } from '@interfaces/eventCoupon.interface';
import type { ResolvedLine } from '@interfaces/cart.interface';
import type { ITicketSale } from '@interfaces/ticket.interface';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import { round2 } from '@utils/serviceFee.util';
import { assertCarrotTicketing } from '@utils/ticketingGuard.util';

export interface CreateCouponsInput {
  count: number;
  label: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  ticketTypeIds: string[];
  expiresAt?: Date;
}

export class EventCouponService {
  private static async ownedEvent(eventId: string, vendorId: string) {
    if (!HEX24.test(eventId)) throw new HttpError(400, 'Invalid event ID');
    const event = await Event.findOne({ _id: eventId, vendorId });
    if (!event) throw new HttpError(404, 'Event not found');
    assertCarrotTicketing(event);
    return event;
  }

  static async create(eventId: string, vendorId: string, input: CreateCouponsInput) {
    const event = await this.ownedEvent(eventId, vendorId);
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100) throw new HttpError(400, 'Generate 1 to 100 codes at a time');
    if (!['percentage', 'fixed'].includes(input.discountType) || !Number.isFinite(input.discountValue) || input.discountValue < 0.01 ||
        round2(input.discountValue) !== input.discountValue || (input.discountType === 'percentage' && input.discountValue > 100)) {
      throw new HttpError(400, 'Enter a valid discount (percentage up to 100%, or a positive amount with up to two decimals)');
    }
    if (input.expiresAt && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date())) throw new HttpError(400, 'Expiry must be in the future');
    for (const id of input.ticketTypeIds) {
      const tier = event.ticketTypes.find(t => String(t._id) === id);
      if (!tier || tier.isAllocation) throw new HttpError(400, 'Choose ticket types owned by this organizer');
    }
    // Sale creation and this lock use transactions; create the indexed collection
    // before the first checkout rather than implicitly creating it in a transaction.
    await EventCoupon.init();
    return EventCoupon.insertMany(Array.from({ length: input.count }, () => ({
      eventId, vendorId, code: `CT-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      label: input.label, discountType: input.discountType, discountValue: input.discountValue,
      ticketTypeIds: [...new Set(input.ticketTypeIds)], expiresAt: input.expiresAt,
    })));
  }

  static async list(eventId: string, vendorId: string, page: number) {
    await this.ownedEvent(eventId, vendorId);
    const [coupons, total] = await Promise.all([
      EventCoupon.find({ eventId }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 50).limit(50).lean(),
      EventCoupon.countDocuments({ eventId }),
    ]);
    const sales = await TicketSale.find({ _id: { $in: coupons.map(c => c.saleId).filter(Boolean) } })
      .select('paymentStatus customerName soldAt coupon ticketIds').lean();
    const byId = new Map(sales.map(s => [String(s._id), s]));
    return { total, page, coupons: coupons.map(c => {
      const sale = c.saleId ? byId.get(String(c.saleId)) : undefined;
      const status = c.saleId && sale?.paymentStatus !== PaymentStatus.FAILED
        ? sale?.paymentStatus === PaymentStatus.COMPLETED ? 'used' : 'pending'
        : c.disabled ? 'disabled' : c.expiresAt && c.expiresAt <= new Date() ? 'expired' : 'available';
      return { ...c, status, redemption: sale?.paymentStatus === PaymentStatus.COMPLETED ? {
        saleId: sale._id, customerName: sale.customerName, usedAt: sale.coupon?.redeemedAt,
        discountAmount: sale.coupon?.discountAmount,
      } : null };
    }) };
  }

  static async disable(eventId: string, vendorId: string, couponId: string) {
    await this.ownedEvent(eventId, vendorId);
    if (!HEX24.test(couponId)) throw new HttpError(400, 'Invalid coupon ID');
    // Disabling prevents future locks; it never revokes a discount that a
    // buyer has already reserved with a payment provider.
    const coupon = await EventCoupon.findOneAndUpdate({ _id: couponId, eventId }, { $set: { disabled: true } }, { new: true });
    if (!coupon) throw new HttpError(404, 'Coupon not found');
    return coupon;
  }

  private static assertEnabled(coupon: IEventCoupon | null): asserts coupon is IEventCoupon {
    if (!coupon) throw new HttpError(400, 'That coupon is not valid for this event');
    if (coupon.disabled) throw new HttpError(400, 'That coupon has been disabled');
    if (coupon.expiresAt && coupon.expiresAt <= new Date()) throw new HttpError(400, 'That coupon has expired');
  }

  /** Applies to exactly ONE ticket: the highest-priced eligible ticket in the
   * basket. Split that line so ticket prices, refunds, revenue and fees all
   * use the actual paid price rather than an average or the original price. */
  static async apply(eventId: string, code: string, lines: ResolvedLine[]): Promise<CouponSnapshot> {
    const coupon = await EventCoupon.findOne({ eventId, code: code.trim().toUpperCase() });
    this.assertEnabled(coupon);
    if (coupon.saleId) {
      const sale = await TicketSale.findById(coupon.saleId).select('paymentStatus');
      if (sale?.paymentStatus !== PaymentStatus.FAILED) throw new HttpError(409,
        sale?.paymentStatus === PaymentStatus.COMPLETED ? 'That coupon has already been used' : 'That coupon is reserved for a payment in progress');
    }
    const eligible = lines.filter(l => l.unitPrice > 0 && !l.ticketType.isAllocation &&
      (!coupon.ticketTypeIds.length || coupon.ticketTypeIds.includes(l.ticketTypeId)));
    const target = eligible.sort((a, b) => b.unitPrice - a.unitPrice)[0];
    if (!target) throw new HttpError(400, 'That coupon does not apply to the tickets in your basket');
    const discountAmount = Math.min(target.unitPrice, round2(coupon.discountType === 'percentage'
      ? target.unitPrice * coupon.discountValue / 100 : coupon.discountValue));
    if (discountAmount <= 0) throw new HttpError(400, 'This discount is too small for the selected ticket');
    const originalAmount = round2(lines.reduce((sum, l) => sum + l.subtotal, 0));
    const discountedPrice = round2(target.unitPrice - discountAmount);
    const discounted = { ...target, quantity: 1, unitPrice: discountedPrice, subtotal: discountedPrice };
    if (target.quantity > 1) {
      target.quantity -= 1;
      target.subtotal = round2(target.unitPrice * target.quantity);
      lines.push(discounted);
    } else {
      lines[lines.indexOf(target)] = discounted;
    }
    return { couponId: coupon._id as mongoose.Types.ObjectId, code: coupon.code,
      discountType: coupon.discountType, discountValue: coupon.discountValue,
      discountAmount, originalAmount, ticketTypeId: target.ticketTypeId };
  }

  /** Persist the pending sale and exclusively bind its coupon in ONE transaction.
   * Competing requests conflict on the coupon document. Only confirmed FAILED
   * attempts can be replaced: inventory-hold expiry is not payment failure. */
  static async saveCheckout(sale: ITicketSale, snapshot?: CouponSnapshot): Promise<void> {
    if (!snapshot) { await sale.save(); return; }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const coupon = await EventCoupon.findOne({ _id: snapshot.couponId, eventId: sale.eventId }).session(session);
        this.assertEnabled(coupon);
        if (coupon.saleId) {
          const previous = await TicketSale.findById(coupon.saleId).select('paymentStatus').session(session);
          if (previous?.paymentStatus !== PaymentStatus.FAILED) throw new HttpError(409, 'That coupon has already been used or is reserved for another payment');
        }
        coupon.saleId = sale._id;
        await coupon.save({ session });
        sale.coupon = snapshot;
        await sale.save({ session });
      });
    } finally { await session.endSession(); }
  }
}
