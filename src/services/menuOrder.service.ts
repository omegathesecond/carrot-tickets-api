import { Event } from '@models/event.model';
import { MenuItem } from '@models/menuItem.model';
import { MenuOrder, IMenuOrderItem } from '@models/menuOrder.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { computeMenuServiceFee } from '@utils/menuServiceFee.util';
import { KeshlessPaymentService } from '@services/keshlessPayment.service';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';
import { normalizePhone } from '@utils/phone.util';

const MOMO_TTL_MS = 5 * 60 * 1000;

function generateOrderId(): string {
  return `MENU-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

interface RequestedLine {
  menuItemId: string;
  quantity: number;
}

export class MenuOrderService {
  private static momoClient = new MtnMomoClient();

  // Prices are ALWAYS re-read from the DB, never trusted from the client —
  // mirrors TicketService reading ticketType.price server-side.
  private static async buildLineItems(
    eventId: string,
    requested: RequestedLine[],
  ): Promise<{ items: IMenuOrderItem[]; subtotal: number }> {
    const ids = requested.map(r => r.menuItemId);
    const menuItems = await MenuItem.find({ _id: { $in: ids }, eventId, active: true });
    const byId = new Map(menuItems.map(m => [String(m._id), m]));

    const items: IMenuOrderItem[] = [];
    let subtotal = 0;
    for (const r of requested) {
      const mi = byId.get(String(r.menuItemId));
      if (!mi) throw new Error('One or more menu items are no longer available');
      const lineTotal = mi.price * r.quantity;
      items.push({ menuItemId: mi._id, name: mi.name, unitPrice: mi.price, quantity: r.quantity, lineTotal });
      subtotal += lineTotal;
    }
    return { items, subtotal };
  }

  /** Synchronous Keshless wallet checkout — mirrors TicketService.purchaseForCustomer. */
  static async createKeshlessOrder(p: {
    eventId: string;
    buyerId: string;
    buyerName?: string;
    buyerPhone?: string;
    items: RequestedLine[];
    keshlessCardNumber: string;
    keshlessPin?: string;
    notes?: string;
  }) {
    const event = await Event.findById(p.eventId);
    if (!event) throw new Error('Event not found');

    const { items, subtotal } = await this.buildLineItems(p.eventId, p.items);

    // PIN threshold keys off the face subtotal — same rule as ticket purchase.
    if (subtotal >= 50 && !p.keshlessPin) {
      throw new Error('PIN required for orders of E50 or more');
    }

    const cfg = await PaymentConfigService.get();
    const { serviceFeeAmount, amountCharged } = computeMenuServiceFee(subtotal, cfg.menuServiceFeePercent);

    const order = new MenuOrder({
      orderId: generateOrderId(),
      eventId: event._id,
      vendorId: event.vendorId,
      buyerId: p.buyerId,
      buyerName: p.buyerName,
      buyerPhone: p.buyerPhone,
      items,
      subtotal,
      serviceFeeAmount,
      amountCharged,
      paymentMethod: PaymentMethod.KESHLESS_WALLET,
      paymentStatus: PaymentStatus.PENDING,
      notes: p.notes,
    });

    const payment = await KeshlessPaymentService.acceptPayment({
      cardNumber: p.keshlessCardNumber,
      amount: amountCharged,
      pin: p.keshlessPin,
      description: `Carrot Tickets - Menu order ${order.orderId}`,
    });

    if (payment.status !== 'completed') {
      order.paymentStatus = PaymentStatus.FAILED;
      await order.save();
      throw new Error(payment.message || 'Payment failed');
    }

    order.paymentStatus = PaymentStatus.COMPLETED;
    order.walletTransactionId = payment.transactionId;
    order.paidAt = new Date();
    await order.save();
    return order;
  }

  /** Async MTN MoMo checkout — mirrors TicketService.initiateMomoPurchase. */
  static async initiateMomoOrder(p: {
    eventId: string;
    buyerId: string;
    buyerName?: string;
    buyerPhone?: string;
    items: RequestedLine[];
    momoPhone: string;
    notes?: string;
  }): Promise<{ referenceId: string; orderId: string; expiresAt: Date }> {
    if (!this.momoClient.isConfigured()) throw new Error('MTN MoMo is not available');

    const event = await Event.findById(p.eventId);
    if (!event) throw new Error('Event not found');

    const { items, subtotal } = await this.buildLineItems(p.eventId, p.items);
    const cfg = await PaymentConfigService.get();
    const { serviceFeeAmount, amountCharged } = computeMenuServiceFee(subtotal, cfg.menuServiceFeePercent);

    const order = new MenuOrder({
      orderId: generateOrderId(),
      eventId: event._id,
      vendorId: event.vendorId,
      buyerId: p.buyerId,
      buyerName: p.buyerName,
      buyerPhone: p.buyerPhone,
      items,
      subtotal,
      serviceFeeAmount,
      amountCharged,
      paymentMethod: PaymentMethod.MTN_MOMO,
      paymentStatus: PaymentStatus.PENDING,
      notes: p.notes,
    });
    await order.save();

    const expiresAt = new Date(Date.now() + MOMO_TTL_MS);
    try {
      const payerMsisdn = normalizePhone(p.momoPhone).replace(/^\+/, '');
      const { referenceId } = await this.momoClient.requestToPay({
        amount: amountCharged,
        currency: process.env['MTN_MOMO_CURRENCY'] || 'SZL',
        payerMsisdn,
        externalId: order.orderId,
        payerMessage: `Carrot Tickets - Menu order`,
      });
      order.momoReferenceId = referenceId;
      await order.save();
      return { referenceId, orderId: order._id.toString(), expiresAt };
    } catch (err) {
      order.paymentStatus = PaymentStatus.FAILED;
      await order.save();
      throw err;
    }
  }

  /** Mirrors TicketService.finalizeMomoSale exactly, for MenuOrder instead of TicketSale. */
  static async finalizeMomoOrder(referenceId: string): Promise<{ status: 'completed' | 'failed' | 'pending'; reason?: string }> {
    const order = await MenuOrder.findOne({ momoReferenceId: referenceId });
    if (!order) throw new Error('Order not found for reference');

    if (order.paymentStatus !== PaymentStatus.PENDING) {
      return order.paymentStatus === PaymentStatus.COMPLETED
        ? { status: 'completed' }
        : { status: 'failed', reason: order.momoFailureReason };
    }

    const { status, raw } = await this.momoClient.getStatus(referenceId);
    if (status === 'PENDING') return { status: 'pending' };

    if (status === 'FAILED') {
      const reason = typeof raw?.reason === 'string' ? raw.reason : undefined;
      order.paymentStatus = PaymentStatus.FAILED;
      if (reason) order.momoFailureReason = reason;
      await order.save();
      return { status: 'failed', reason };
    }

    // SUCCESSFUL — verify MTN confirms the EXACT amount + currency requested
    // before marking paid. Same amount-guard as ticket MoMo finalization.
    const expectedCurrency = process.env['MTN_MOMO_CURRENCY'] || 'SZL';
    const confirmedAmount = Number(raw?.amount);
    if (!Number.isFinite(confirmedAmount) || confirmedAmount !== order.amountCharged || raw?.currency !== expectedCurrency) {
      order.paymentStatus = PaymentStatus.FAILED;
      order.momoFailureReason = 'AMOUNT_MISMATCH';
      await order.save();
      return { status: 'failed', reason: 'AMOUNT_MISMATCH' };
    }

    // Atomically CLAIM so a concurrent poll can't double-finalize.
    const claimed = await MenuOrder.findOneAndUpdate(
      { _id: order._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED, paidAt: new Date() } },
      { new: true },
    );
    if (!claimed) return { status: 'completed' }; // already finalized by a concurrent poll
    return { status: 'completed' };
  }

  static async getMomoOrderByReference(referenceId: string) {
    return MenuOrder.findOne({ momoReferenceId: referenceId }).lean();
  }
}
