import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { MenuItem } from '@models/menuItem.model';
import { MenuOrder, IMenuOrderItem } from '@models/menuOrder.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { computeMenuServiceFee, centsToMajorUnits } from '@utils/menuServiceFee.util';
import { KeshlessPaymentService } from '@services/keshlessPayment.service';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';
import { normalizePhone } from '@utils/phone.util';
import { HttpError } from '@utils/httpError.util';
import { MAX_QTY_PER_LINE, MenuOrderLine, mergeMenuOrderLines } from '@validators/menu.validator';

const MOMO_TTL_MS = 5 * 60 * 1000;

function generateOrderId(): string {
  return `MENU-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Every refusal a preorder can hit is thrown as an HttpError so the public
 * controller maps it straight onto a status — no string-matching on messages.
 */
export class MenuOrderService {
  private static momoClient = new MtnMomoClient();

  /**
   * Only a PUBLISHED event takes preorders — the same gate as the public menu
   * read (MenuPublicController.getEventMenu), so checkout is never a way
   * around it for a draft, pending-approval or finished event.
   */
  private static async loadOpenEvent(eventId: string) {
    const event = await Event.findOne({ _id: eventId, status: EventStatus.PUBLISHED });
    if (!event) throw new HttpError(404, 'Event not found or not open for orders');
    return event;
  }

  // Prices are ALWAYS re-read from the DB, never trusted from the client —
  // mirrors TicketService reading ticketType.price server-side. Duplicate
  // lines of one item are merged first so the per-line cap applies to the
  // real quantity, not to each fragment.
  private static async buildLineItems(
    eventId: string,
    lines: MenuOrderLine[],
  ): Promise<{ items: IMenuOrderItem[]; subtotal: number }> {
    const requested = mergeMenuOrderLines(lines);
    const over = requested.find(r => r.quantity > MAX_QTY_PER_LINE);
    if (over) throw new HttpError(400, `Quantity for a single item cannot exceed ${MAX_QTY_PER_LINE}`);

    const ids = requested.map(r => r.menuItemId);
    const menuItems = await MenuItem.find({ _id: { $in: ids }, eventId, active: true });
    const byId = new Map(menuItems.map(m => [String(m._id), m]));

    const items: IMenuOrderItem[] = [];
    let subtotal = 0;
    for (const r of requested) {
      const mi = byId.get(String(r.menuItemId));
      if (!mi) throw new HttpError(409, 'One or more menu items are no longer available');
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
    items: MenuOrderLine[];
    keshlessCardNumber: string;
    keshlessPin?: string;
    notes?: string;
  }) {
    const event = await this.loadOpenEvent(p.eventId);

    const { items, subtotal } = await this.buildLineItems(p.eventId, p.items);

    // PIN threshold keys off the face subtotal, same rule as ticket purchase —
    // but subtotal here is integer cents, so convert to major units (E) before
    // comparing against the E50 Keshless PIN threshold.
    if (centsToMajorUnits(subtotal) >= 50 && !p.keshlessPin) {
      throw new HttpError(400, 'PIN required for orders of E50 or more');
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

    // Keshless wallet expects major units (E) — amountCharged is stored in cents.
    const payment = await KeshlessPaymentService.acceptPayment({
      cardNumber: p.keshlessCardNumber,
      amount: centsToMajorUnits(amountCharged),
      pin: p.keshlessPin,
      description: `Carrot Tickets - Menu order ${order.orderId}`,
    });

    if (payment.status !== 'completed') {
      order.paymentStatus = PaymentStatus.FAILED;
      await order.save();
      throw new HttpError(402, payment.message || 'Payment failed');
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
    items: MenuOrderLine[];
    momoPhone: string;
    notes?: string;
  }): Promise<{ referenceId: string; orderId: string; expiresAt: Date }> {
    if (!this.momoClient.isConfigured()) throw new HttpError(503, 'MTN MoMo is not available');

    const event = await this.loadOpenEvent(p.eventId);

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
      // MTN MoMo expects major units (E) — amountCharged is stored in cents.
      // externalId is what MTN echoes back in its callback — see
      // getMomoOrderByExternalId and MomoController.callback.
      const { referenceId } = await this.momoClient.requestToPay({
        amount: centsToMajorUnits(amountCharged),
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
    if (!order) throw new HttpError(404, 'Order not found for reference');

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
    // MTN reports major units; order.amountCharged is stored in cents.
    const expectedCurrency = process.env['MTN_MOMO_CURRENCY'] || 'SZL';
    const confirmedAmount = Number(raw?.amount);
    if (!Number.isFinite(confirmedAmount) || confirmedAmount !== centsToMajorUnits(order.amountCharged) || raw?.currency !== expectedCurrency) {
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

  /**
   * Look up a MoMo order by the externalId we sent to MTN (= order.orderId).
   * MTN's requesttopay callback carries `externalId`, NOT our X-Reference-Id,
   * so this is how MomoController.callback correlates an inbound callback
   * back to its order. Mirrors TicketService.getMomoSaleByExternalId.
   */
  static async getMomoOrderByExternalId(externalId: string) {
    return MenuOrder.findOne({ orderId: externalId }).lean();
  }

  /**
   * Reconciliation backstop for a lost MTN callback: the buyer approved on
   * the handset and closed the tab, so the status poll stopped too, and the
   * order would otherwise sit PENDING forever while MTN has taken the money.
   * Asks MTN through finalizeMomoOrder — the same idempotent, amount-guarded
   * finaliser the poll and the callback use — so a paid order completes, a
   * declined one fails, and a still-pending one is left untouched.
   *
   * `olderThanMs` skips brand-new orders where the buyer is still looking at
   * the MoMo prompt (avoids hammering MTN). Mirrors
   * TicketService.reconcilePendingCardSales / reconcilePendingYeboPaySales.
   */
  static async reconcilePendingMomoOrders(olderThanMs = 90_000): Promise<{ completed: number; failed: number; pending: number }> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = await MenuOrder.find({
      paymentMethod: PaymentMethod.MTN_MOMO,
      paymentStatus: PaymentStatus.PENDING,
      momoReferenceId: { $exists: true, $nin: [null, ''] },
      createdAt: { $lt: cutoff },
    }).limit(100);

    let completed = 0, failed = 0, pending = 0;
    for (const order of stuck) {
      // One order MTN cannot answer for must not stop the batch — the next may
      // be a paid one waiting to complete. Never swallowed silently.
      try {
        const r = await this.finalizeMomoOrder(order.momoReferenceId!);
        if (r.status === 'completed') completed += 1;
        else if (r.status === 'failed') failed += 1;
        else pending += 1;
      } catch (err) {
        console.error('[menu momo-reconcile] could not resolve order', {
          orderId: order.orderId,
          referenceId: order.momoReferenceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (completed || failed) {
      console.log('[menu momo-reconcile] resolved', { completed, failed, pending, scanned: stuck.length });
    }
    return { completed, failed, pending };
  }
}
