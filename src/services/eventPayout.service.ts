import { randomUUID } from 'crypto';
import mongoose, { ClientSession } from 'mongoose';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { TicketSale } from '@models/ticketSale.model';
import { OrganizerPayout } from '@models/organizerPayout.model';
import {
  EventPayout,
  PayoutBank,
  PayoutStatus,
} from '@models/eventPayout.model';
import { NotificationService } from './notification.service';
import { HttpError } from '@utils/httpError.util';
import { round2 } from '@utils/serviceFee.util';
import {
  validatePayoutBank,
  maskPayoutBank,
  encryptPayoutBank,
  decryptPayoutBank,
} from '@utils/payoutBank.util';

function oid(value: string) {
  if (!mongoose.isValidObjectId(value))
    throw new HttpError(400, 'Invalid identifier');
  return new mongoose.Types.ObjectId(value);
}

/** Original sale fees are retained on refund: the refund code changes only
 * refundedAmount/Quantity, never the frozen fee/proceeds fields. Subtract the
 * entire refund from organizer proceeds, once. Never pay unremitted cash or
 * money already held by the organizer. */
export function payoutBreakdown(sales: any[], paid: number) {
  let gross = 0,
    refunds = 0,
    platformFees = 0,
    commissions = 0,
    absorbedFees = 0;
  let available = 0,
    unremitted = 0,
    vendorHeld = 0,
    vendorFees = 0,
    proceeds = 0;
  for (const s of sales) {
    for (const k of [
      'totalAmount',
      'organizerProceeds',
      'platformFeeAmount',
      'resellerCommissionAmount',
    ]) {
      if (!Number.isFinite(s[k]))
        throw new HttpError(
          409,
          'Sale financial snapshot is incomplete; reconcile before requesting payout',
        );
    }
    if (!['carrot', 'vendor', 'reseller'].includes(s.fundsCustody))
      throw new HttpError(
        409,
        'Sale custody is missing; reconcile before requesting payout',
      );
    const refund =
      s.paymentStatus === 'refunded' ? s.totalAmount : (s.refundedAmount ?? 0);
    if (!Number.isFinite(refund) || refund < 0 || refund > s.totalAmount)
      throw new HttpError(409, 'Invalid sale refund balance');
    const net = s.organizerProceeds - refund;
    gross += s.totalAmount;
    refunds += refund;
    platformFees += s.platformFeeAmount;
    commissions += s.resellerCommissionAmount;
    absorbedFees += s.absorbedServiceFeeAmount ?? 0;
    proceeds += net;
    if (s.fundsCustody === 'vendor') {
      vendorHeld += net;
      vendorFees += s.platformFeeAmount;
    } else if (s.fundsCustody === 'carrot' || s.resellerRemitted === true)
      available += net;
    else unremitted += net;
  }
  return {
    sales: sales.length,
    gross: round2(gross),
    refunds: round2(refunds),
    platformFees: round2(platformFees),
    resellerCommission: round2(commissions),
    absorbedFees: round2(absorbedFees),
    organizerProceeds: round2(proceeds),
    vendorHeld: round2(vendorHeld),
    unremitted: round2(unremitted),
    vendorFees: round2(vendorFees),
    adjustments: round2(
      proceeds - (gross - refunds - platformFees - commissions - absorbedFees),
    ),
    previouslyPaid: round2(paid),
    availableBalance: round2(available - vendorFees - paid),
  };
}

export class EventPayoutService {
  static async overview(
    eventId: string,
    vendorId: string,
    admin = false,
    session?: ClientSession,
  ) {
    const event = await Event.findOne({
      _id: oid(eventId),
      ...(!admin ? { vendorId: oid(vendorId) } : {}),
    }).session(session ?? null);
    if (!event || !event.vendorId) throw new HttpError(404, 'Event not found');
    const owner = String(event.vendorId);
    const sales = await TicketSale.find({
      eventId: event._id,
      isAllocation: { $ne: true },
      paymentStatus: { $in: ['completed', 'refunded'] },
    })
      .select(
        'totalAmount organizerProceeds platformFeeAmount resellerCommissionAmount absorbedServiceFeeAmount refundedAmount fundsCustody resellerRemitted soldAt paymentStatus',
      )
      .session(session ?? null)
      .lean();
    // Old administrator-created period payouts cover sales, not events. Refuse
    // to pay those same sales again through the new request workflow.
    const legacy = sales.length
      ? await OrganizerPayout.exists({
          vendorId: event.vendorId,
          status: { $in: ['open', 'pending_payment', 'settled'] },
          $or: sales.map((s) => ({
            periodStart: { $lte: s.soldAt },
            periodEnd: { $gte: s.soldAt },
          })),
        }).session(session ?? null)
      : null;
    const requests = await EventPayout.find({ eventId: event._id })
      .sort({ createdAt: -1 })
      .session(session ?? null);
    const paid = requests
      .filter((r) => r.status === 'paid')
      .reduce((sum, r) => sum + r.amount, 0);
    const breakdown = payoutBreakdown(sales, paid);
    const active = requests.some((r) => r.active);
    const ended = new Date(event.endTime).getTime() < Date.now();
    const reason = !ended
      ? 'Payouts open after the event ends'
      : legacy
        ? 'Sales are covered by an existing payout period; contact Carrot'
        : active
          ? 'A payout request is already pending or approved'
          : breakdown.availableBalance <= 0
            ? 'No eligible balance available'
            : null;
    return {
      eventId,
      eventName: event.name,
      eventDate: event.eventDate,
      currency: event.currency,
      vendorId: owner,
      eligible: !reason,
      ended,
      legacyCovered: !!legacy,
      reason,
      breakdown,
      requests,
    };
  }

  static async request(eventId: string, vendorId: string, input: any) {
    await Promise.all([EventPayout.init(), PayoutBank.init()]);
    const session = await mongoose.startSession();
    let result: any;
    try {
      await session.withTransaction(async () => {
        const overview = await this.overview(eventId, vendorId, false, session);
        if (!overview.eligible) throw new HttpError(409, overview.reason!);
        if (input.expectedAmount !== overview.breakdown.availableBalance)
          throw new HttpError(
            409,
            'Available balance changed; review the updated amount and submit again',
          );
        const saved =
          input.useSaved === true
            ? await PayoutBank.findOne({ vendorId: oid(vendorId) })
                .select('+encrypted')
                .session(session)
            : null;
        if (input.useSaved === true && !saved)
          throw new HttpError(400, 'No saved bank details');
        if (saved && input.bankVersion !== saved.version)
          throw new HttpError(
            409,
            'Saved bank details changed; review them again',
          );
        const bank = saved
          ? decryptPayoutBank(saved.encrypted, vendorId)
          : validatePayoutBank(input.bank);
        const encrypted = encryptPayoutBank(bank, vendorId);
        const vendor = await Vendor.findById(vendorId)
          .select('businessName')
          .session(session);
        if (!vendor) throw new HttpError(404, 'Organizer not found');
        const [request] = await EventPayout.create(
          [
            {
              eventId: oid(eventId),
              vendorId: oid(vendorId),
              eventName: overview.eventName,
              eventDate: overview.eventDate,
              organizerName: vendor.businessName,
              currency: overview.currency,
              amount: overview.breakdown.availableBalance,
              breakdown: overview.breakdown,
              bankEncrypted: encrypted,
              bank: maskPayoutBank(bank),
              status: 'pending',
              active: true,
              history: [{ status: 'pending', at: new Date(), by: vendorId }],
            },
          ],
          { session },
        );
        if (input.saveBank === true && !saved)
          await PayoutBank.findOneAndUpdate(
            { vendorId: oid(vendorId) },
            {
              $set: {
                encrypted,
                masked: maskPayoutBank(bank),
                version: randomUUID(),
              },
            },
            { upsert: true, session },
          );
        // Never serialize an inserted document containing the ciphertext.
        result = request!._id;
      });
    } catch (e: any) {
      if (e.code === 11000)
        throw new HttpError(
          409,
          'A payout request is already pending or approved',
        );
      throw e;
    } finally {
      await session.endSession();
    }
    return EventPayout.findById(result);
  }

  static async transition(
    id: string,
    status: PayoutStatus,
    actor: string,
    input: any,
  ) {
    if (!['approved', 'declined', 'paid'].includes(status))
      throw new HttpError(400, 'Invalid payout status');
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > 1000)
      throw new HttpError(400, 'Note must be at most 1000 characters');
    let paidAt: Date | undefined;
    let reference: string | undefined;
    if (status === 'paid') {
      paidAt = new Date(input.paidAt);
      reference =
        typeof input.paymentReference === 'string'
          ? input.paymentReference.trim()
          : '';
      if (
        input.paymentCompleted !== true ||
        !reference ||
        reference.length > 120 ||
        !Number.isFinite(paidAt.getTime()) ||
        paidAt > new Date()
      ) {
        throw new HttpError(
          400,
          'Confirm completed payment and enter its date and reference',
        );
      }
    }
    const session = await mongoose.startSession();
    let result: any;
    try {
      await session.withTransaction(async () => {
        const request = await EventPayout.findById(oid(id)).session(session);
        if (!request) throw new HttpError(404, 'Payout request not found');
        const expected = request.status;
        const allowed =
          status === 'paid'
            ? expected === 'approved'
            : status === 'approved'
              ? expected === 'pending'
              : ['pending', 'approved'].includes(expected);
        if (!allowed)
          throw new HttpError(
            409,
            `Cannot change a ${expected} payout to ${status}`,
          );
        if (status !== 'declined') {
          const current = await this.overview(
            String(request.eventId),
            String(request.vendorId),
            true,
            session,
          );
          if (
            current.breakdown.availableBalance < request.amount ||
            current.legacyCovered ||
            !current.ended
          ) {
            throw new HttpError(
              409,
              'Available balance has changed; decline this request and ask the organizer to submit again',
            );
          }
        }
        if (paidAt && paidAt < request.createdAt)
          throw new HttpError(400, 'Payment date cannot precede the request');
        result = await EventPayout.findOneAndUpdate(
          { _id: request._id, status: expected },
          {
            $set: {
              status,
              active: status === 'approved',
              ...(status === 'paid'
                ? { paidAt, paymentReference: reference }
                : {}),
            },
            $push: { history: { status, at: new Date(), by: actor, note } },
          },
          { new: true, session },
        );
        if (!result)
          throw new HttpError(
            409,
            'Request was changed by another administrator',
          );
        await NotificationService.create(
          'vendor',
          String(request.vendorId),
          'payout_status',
          `Payout ${status}`,
          `Your payout for ${request.eventName} was ${status}.${note ? ` ${note}` : ''}`,
          { eventId: String(request.eventId), payoutId: id, status },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return result;
  }
}
