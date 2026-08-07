import { Reseller } from '@models/reseller.model';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { Wallet } from '@models/wallet.model';
import { ResellerBandSale } from '@models/resellerBandSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { TicketService } from '@services/ticket.service';
import { SmsService } from '@services/sms.service';
import { WalletService } from '@services/wallet.service';
import { assertValidBandUid } from '@utils/bandUid.util';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

type ResellerPaymentMethod = 'cash' | 'mtn_momo' | 'keshless_wallet';

interface CreateSaleParams {
  operatorId: string;
  resellerId: string;
  hubId: string;
  eventId: string;
  ticketTypeId: string;
  quantity: number;
  paymentMethod: ResellerPaymentMethod;
  customerName?: string;
  customerPhone?: string;
  // Buyer's MoMo number for the mtn_momo lane (the till collects it). Falls back
  // to customerPhone when omitted.
  momoPhone?: string;
  keshlessCardNumber?: string;
  keshlessPin?: string;
}

// Synchronous (cash / keshless_wallet) result: tickets minted immediately.
interface CompletedSaleResult {
  saleId: string;
  status: 'completed' | 'failed';
  tickets: any[];
  message?: string;
}

// Asynchronous (mtn_momo) result: PENDING sale awaiting MTN confirmation. No
// tickets yet — the caller polls/finalizes via the referenceId.
interface PendingSaleResult {
  saleId: string;
  status: 'pending';
  referenceId: string;
  expiresAt: Date;
}

type CreateSaleResult = CompletedSaleResult | PendingSaleResult;

// Maps the ResellerPaymentMethod to the PaymentConfig toggle key.
const METHOD_TOGGLE: Record<ResellerPaymentMethod, keyof Awaited<ReturnType<typeof PaymentConfigService.get>>> = {
  cash: 'cashEnabled',
  mtn_momo: 'mtnMomoEnabled',
  keshless_wallet: 'keshlessWalletEnabled',
};

// Maps the string method to the PaymentMethod enum used by TicketService.
const METHOD_ENUM: Record<ResellerPaymentMethod, PaymentMethod> = {
  cash: PaymentMethod.CASH,
  mtn_momo: PaymentMethod.MTN_MOMO,
  keshless_wallet: PaymentMethod.KESHLESS_WALLET,
};

export class ResellerSaleService {
  /**
   * Reseller POS sale path.
   *
   * Guards:
   * 1. Payment method must be enabled in PaymentConfig.
   * 2. Reseller must exist and not be suspended.
   * 3. Event must exist and be published (to resolve vendorId).
   *
   * All capacity, payment processing, ticket minting, and economic snapshot
   * work is delegated to TicketService.sellTickets — do NOT duplicate it here.
   */
  static async createSale(params: CreateSaleParams): Promise<CreateSaleResult> {
    const cfg = await PaymentConfigService.get();

    // Guard 1: payment method toggle
    const toggleKey = METHOD_TOGGLE[params.paymentMethod];
    if (!cfg[toggleKey]) {
      throw new Error('Payment method not available');
    }

    // Guard 2: reseller must exist and be active
    const reseller = await Reseller.findById(params.resellerId);
    if (!reseller) {
      throw new Error(`Reseller not found: ${params.resellerId}`);
    }
    if (reseller.status === 'suspended') {
      throw new Error(`Reseller is suspended: ${params.resellerId}`);
    }

    // Resolve commission: reseller-specific takes precedence over platform default.
    const resellerCommissionPercent =
      reseller.commissionPercent ?? cfg.defaultResellerCommissionPercent;

    // Guard 3: event must exist and be published (gives us vendorId)
    const event = await Event.findOne({ _id: params.eventId, status: EventStatus.PUBLISHED });
    if (!event) {
      throw new Error(`Event not found or not published: ${params.eventId}`);
    }

    // MTN MoMo is ASYNC: route to the initiate path (PENDING sale + requestToPay),
    // NOT the synchronous sellTickets charge path (which throws for MoMo). The
    // till finalizes later via finalizeSale(referenceId).
    if (params.paymentMethod === 'mtn_momo') {
      // Require a buyer phone — momoPhone preferred, customerPhone as fallback.
      // No silent fallback: a missing number is a hard 4xx-worthy error.
      const momoPhone = params.momoPhone ?? params.customerPhone;
      if (!momoPhone) {
        throw new Error('A buyer MoMo phone number is required for MTN MoMo sales');
      }

      const { saleId, referenceId, expiresAt } = await TicketService.initiateMomoPurchase({
        eventId: params.eventId,
        ticketTypeId: params.ticketTypeId,
        quantity: params.quantity,
        customerName: params.customerName,
        customerPhone: params.customerPhone ?? momoPhone,
        momoPhone,
        vendorId: event.vendorId!.toString(),
        soldBy: params.operatorId,
        soldByType: 'reseller-operator',
        resellerId: params.resellerId,
        hubId: params.hubId,
        resellerCommissionPercent,
      });

      return { saleId, status: 'pending', referenceId, expiresAt };
    }

    const { sale, tickets, paymentMessage } = await TicketService.sellTickets({
      eventId: params.eventId,
      vendorId: event.vendorId!.toString(),
      ticketTypeId: params.ticketTypeId,
      quantity: params.quantity,
      paymentMethod: METHOD_ENUM[params.paymentMethod],
      customerName: params.customerName,
      customerPhone: params.customerPhone,
      keshlessCardNumber: params.keshlessCardNumber,
      keshlessPin: params.keshlessPin,
      soldBy: params.operatorId,
      soldByType: 'reseller-operator',
      resellerId: params.resellerId,
      hubId: params.hubId,
      resellerCommissionPercent,
    });

    // cash / keshless_wallet are synchronous — only completed or failed here
    // (the async pending lane is handled in the mtn_momo branch above).
    const status: 'completed' | 'failed' =
      sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed' : 'failed';

    return {
      saleId: sale._id.toString(),
      status,
      tickets,
      ...(paymentMessage ? { message: paymentMessage } : {}),
    };
  }

  /**
   * Sell a blank NFC band as a ticket at the door (Task 7, cashless spec §5.1):
   * mints one cash ticket via the proven `createSale` path, mints+binds its
   * wallet to the band, and optionally loads cash — one idempotent call.
   *
   * Idempotency: `createSale`/`TicketSale` have no `clientTxnId` field (see
   * resellerBandSale.model.ts for why), so a naive retry would mint a second
   * ticket. `ResellerBandSale` is a small, sell-band-local collection keyed
   * uniquely on `clientTxnId`, consulted first and written only after the full
   * orchestration succeeds. It is NOT keyed on bandUid alone, so a genuinely
   * DIFFERENT request reusing an already-claimed band is never silently
   * treated as a success — it falls through to WalletService.bindBand, whose
   * own {eventId,bandUid} uniqueness guard rejects it loudly.
   *
   * Partial failure (spec §5.1): if bindBand fails AFTER the ticket+wallet
   * exist (e.g. the uid is already bound), the error is left to propagate —
   * the resulting SOLD-but-bandless ticket is acceptable/recoverable, so it is
   * deliberately NOT rolled back.
   */
  static async createBandSale(params: {
    operatorId: string; resellerId: string; hubId: string | null;
    eventId: string; ticketTypeId: string; bandUid: string; cashAmount: number;
    customerName?: string; customerPhone?: string; clientTxnId: string;
  }): Promise<{ sale: CreateSaleResult; ticket: any; wallet: any; binding: { bandUid: string; walletId: string } }> {
    const uid = assertValidBandUid(params.bandUid);

    // Idempotent retry: this exact clientTxnId already completed — reconstruct
    // and return the original result instead of minting again.
    const existing = await ResellerBandSale.findOne({ clientTxnId: params.clientTxnId });
    if (existing) {
      const [wallet, ticket] = await Promise.all([
        Wallet.findById(existing.walletId),
        Ticket.findById(existing.ticketId),
      ]);
      if (!wallet || !ticket) {
        throw new Error(
          `sell-band idempotency record found for clientTxnId ${params.clientTxnId} but its wallet/ticket is missing`,
        );
      }
      return {
        sale: { saleId: String(existing.saleId), status: 'completed', tickets: [ticket] },
        ticket,
        wallet,
        binding: { bandUid: existing.bandUid, walletId: String(existing.walletId) },
      };
    }

    // 1. Sell one cash ticket via the proven path.
    const sale = await ResellerSaleService.createSale({
      operatorId: params.operatorId, resellerId: params.resellerId, hubId: params.hubId ?? '',
      eventId: params.eventId, ticketTypeId: params.ticketTypeId, quantity: 1,
      paymentMethod: 'cash', customerName: params.customerName, customerPhone: params.customerPhone,
    });
    if (sale.status !== 'completed' || !('tickets' in sale) || !sale.tickets?.length) {
      throw new Error((sale as { message?: string }).message || 'ticket sale did not complete');
    }
    const ticket: any = sale.tickets[0];

    // 2. Wallet + band (mirrors ScanService.bindBandToTicket).
    const wallet = await WalletService.ensureWalletForTicket({
      ticketId: String(ticket._id), eventId: params.eventId,
      ...(ticket.purchasedBy ? { buyerId: String(ticket.purchasedBy) } : {}),
    });
    const bound = await WalletService.bindBand(String(wallet._id), uid, params.operatorId);

    // 3. Optional initial cash load.
    let finalWallet = bound;
    if (params.cashAmount > 0) {
      const { wallet: w } = await WalletService.topUpCash({
        walletId: String(bound._id), eventId: params.eventId, amount: params.cashAmount,
        recordedBy: params.operatorId, clientTxnId: `${params.clientTxnId}:topup`,
      });
      finalWallet = w;
    }

    // Persist the idempotency record only now that everything above succeeded
    // — a thrown error (e.g. bindBand's "already bound") never reaches this
    // line, so a failed attempt never poisons the collection with a false hit.
    try {
      await ResellerBandSale.create({
        clientTxnId: params.clientTxnId, eventId: params.eventId, bandUid: uid,
        resellerId: params.resellerId, operatorId: params.operatorId,
        saleId: sale.saleId, ticketId: ticket._id, walletId: bound._id,
      });
    } catch (e: any) {
      // Concurrent duplicate: unique clientTxnId lost the race. The ticket and
      // band we just created still stand as issued (§5.1 — not rolled back);
      // surface this loudly rather than silently swallow it, same as every
      // other idempotency-record write in this codebase (WalletService.topUpCash).
      if (e?.code !== 11000) throw e;
    }

    return { sale, ticket, wallet: finalWallet, binding: { bandUid: uid, walletId: String(bound._id) } };
  }

  /**
   * Finalize a reseller MoMo sale by its MTN referenceId.
   *
   * Ownership isolation: a reseller may ONLY finalize a sale it owns. If the
   * sale's resellerId does not match the caller's resellerId we throw an
   * authorization error BEFORE consulting MTN — preventing one reseller from
   * driving another reseller's PENDING sale to completion.
   *
   * Delegates the actual status check + mint to TicketService.finalizeMomoSale
   * (idempotent). Throws not-found when the referenceId is unknown.
   */
  static async finalizeSale(
    referenceId: string,
    resellerId: string
  ): Promise<{ status: 'completed' | 'failed' | 'pending'; saleId: string; reason?: string }> {
    const sale = await TicketService.getMomoSaleByReference(referenceId);
    if (!sale) {
      throw new Error(`Sale not found for reference: ${referenceId}`);
    }

    // Security: ownership guard (scope isolation)
    if (sale.resellerId?.toString() !== resellerId) {
      throw new Error('Not authorized to finalize this sale');
    }

    const { status, reason } = await TicketService.finalizeMomoSale(referenceId);
    return { status, saleId: sale._id.toString(), reason };
  }

  /**
   * Manually (re)send the ticket confirmation SMS for a reseller sale.
   *
   * Reseller-INITIATED, so unlike the best-effort auto-send on the wallet/MoMo
   * paths this is NOT fire-and-forget: we return whether the gateway accepted
   * the message so the till can surface a failure (no silent success).
   *
   * Scope isolation: the sale must belong to the calling reseller.
   */
  static async sendSaleSms(
    saleId: string,
    resellerId: string,
  ): Promise<{ sent: boolean }> {
    const sale = await TicketSale.findById(saleId);
    if (!sale) {
      throw new Error(`Sale not found: ${saleId}`);
    }
    if (sale.resellerId?.toString() !== resellerId) {
      throw new Error('Not authorized to send SMS for this sale');
    }
    if (!sale.customerPhone) {
      throw new Error('This sale has no customer phone number');
    }

    const event = await Event.findById(sale.eventId);
    if (!event) {
      throw new Error(`Event not found for sale: ${saleId}`);
    }

    const tickets = await Ticket.find({ _id: { $in: sale.ticketIds } });
    if (tickets.length === 0) {
      throw new Error('This sale has no issued tickets to send');
    }

    const sent = await SmsService.sendTicketConfirmation(
      sale.customerPhone,
      tickets.map((t) => ({
        ticketId: t.ticketId,
        eventName: event.name,
        eventDate: event.eventDate.toISOString(),
        venue: event.venue,
      })),
    );

    return { sent };
  }

  static async getOperatorSales(params: {
    operatorId: string;
    resellerId: string;
    page?: number;
    limit?: number;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{ sales: any[]; total: number; page: number; limit: number }> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;

    const filter: any = {
      soldBy: params.operatorId,
      soldByType: 'ResellerOperator',
      resellerId: params.resellerId,
    };

    if (params.startDate || params.endDate) {
      filter.soldAt = {};
      if (params.startDate) filter.soldAt.$gte = params.startDate;
      if (params.endDate) filter.soldAt.$lte = params.endDate;
    }

    const [sales, total] = await Promise.all([
      TicketSale.find(filter)
        .populate('eventId', 'name venue eventDate')
        .sort({ soldAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TicketSale.countDocuments(filter),
    ]);

    return { sales, total, page, limit };
  }
}
