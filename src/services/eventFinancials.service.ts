import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { HttpError } from '@utils/httpError.util';
import { round2 } from '@utils/serviceFee.util';
import type { EventCurrency } from '@utils/currency.util';

/**
 * One payment method's slice of an event's money.
 *
 * The three amounts are deliberately all present rather than derived by the
 * caller, because they answer three different questions and collapsing them is
 * how the old event tab ended up misreporting: `face` is the ticket price the
 * organizer sells at, `charged` is what left the buyer's wallet, and
 * `organizerProceeds` is what the organizer actually keeps.
 */
export interface FinancialsMethodRow {
  method: string;
  sales: number;
  tickets: number;
  face: number;               // Σ totalAmount — ticket face value
  platformFee: number;        // Σ platformFeeAmount — Carrot's commission
  resellerCommission: number; // Σ resellerCommissionAmount
  organizerProceeds: number;  // Σ organizerProceeds — what the organizer keeps

  // SUPER-ADMIN ONLY — absent entirely for an organizer. Optional in the type
  // rather than zeroed, so a reader can't mistake "withheld" for "no fee".
  bookingFee?: number;        // Σ serviceFeeAmount — buyer-paid, on top of face
  absorbedFee?: number;       // Σ absorbedServiceFeeAmount — organizer covered it instead
  charged?: number;           // face + bookingFee — what the buyer actually paid
}

/** Tickets that changed hands for money, and what they averaged. */
export interface FinancialsPaidSummary {
  sales: number;
  tickets: number;
  averageTicketPrice: number;
}

/** Tickets that got someone through the gate for nothing — platform-printed
 *  wristband batches and price-0 tiers alike. Counted apart from paid tickets
 *  because averaging free entries into paid revenue understates the real
 *  ticket price by an order of magnitude on a wristband-heavy event. */
export interface FinancialsCompSummary {
  sales: number;
  tickets: number;
}

/**
 * Where the organizer's proceeds physically are right now. An event total says
 * how much was earned; this says how much can actually be paid out, which on a
 * reseller-heavy event is a very different number — reseller cash sits in the
 * reseller's pocket until a settlement is closed and marked paid.
 */
export interface FinancialsCustody {
  withCarrot: number;
  withResellersUnremitted: number;
  withResellersRemitted: number;
  withVendor: number;
  /** withCarrot + withResellersRemitted — payable today. */
  availableNow: number;
}

/** Same money, cut by where the ticket was bought rather than how it was paid for. */
export interface FinancialsChannelRow extends Omit<FinancialsMethodRow, 'method'> {
  channel: string;
}

export interface FinancialsTotals {
  face: number;
  platformFees: number;
  resellerCommission: number;
  organizerProceeds: number;

  // SUPER-ADMIN ONLY — see FinancialsMethodRow.
  bookingFees?: number;
  absorbedFees?: number;
  charged?: number;
  /** bookingFees + absorbedFees + platformFees — Carrot's take on this event. */
  carrotEarned?: number;
}

/** Attempted sales that never completed — money the event tried and failed to take. */
export interface FinancialsFailed {
  sales: number;
  tickets: number;
  face: number;
}

export interface EventFinancials {
  currency: EventCurrency;
  byMethod: FinancialsMethodRow[];
  byChannel: FinancialsChannelRow[];
  totals: FinancialsTotals;
  paid: FinancialsPaidSummary;
  comps: FinancialsCompSummary;
  custody: FinancialsCustody;
  failed: FinancialsFailed;
}

/** Shared per-bucket money sums, so method and channel rows can never drift apart. */
const MONEY_SUMS = {
  sales: { $sum: 1 },
  tickets: { $sum: '$quantity' },
  face: { $sum: { $ifNull: ['$totalAmount', 0] } },
  bookingFee: { $sum: { $ifNull: ['$serviceFeeAmount', 0] } },
  absorbedFee: { $sum: { $ifNull: ['$absorbedServiceFeeAmount', 0] } },
  platformFee: { $sum: { $ifNull: ['$platformFeeAmount', 0] } },
  resellerCommission: { $sum: { $ifNull: ['$resellerCommissionAmount', 0] } },
  organizerProceeds: { $sum: { $ifNull: ['$organizerProceeds', 0] } },
} as const;

/**
 * `showFees` false OMITS the fee keys rather than zeroing them. Zeroes would be
 * a lie an organizer could act on ("no booking fee was charged"); absence is
 * merely silence. It also means the client can decide what to render purely
 * from the payload's shape, with no second permission check to keep in sync.
 */
function toRow(raw: any, showFees: boolean): Omit<FinancialsMethodRow, 'method'> {
  const face = round2(raw.face ?? 0);
  const bookingFee = round2(raw.bookingFee ?? 0);
  return {
    sales: raw.sales ?? 0,
    tickets: raw.tickets ?? 0,
    face,
    platformFee: round2(raw.platformFee ?? 0),
    resellerCommission: round2(raw.resellerCommission ?? 0),
    organizerProceeds: round2(raw.organizerProceeds ?? 0),
    ...(showFees
      ? {
          bookingFee,
          absorbedFee: round2(raw.absorbedFee ?? 0),
          // face + bookingFee. Withheld alongside the fee itself — publishing
          // it would hand the fee back by simple subtraction.
          charged: round2(face + bookingFee),
        }
      : {}),
  };
}

export class EventFinancialsService {
  /**
   * Full money picture for a single event. Vendor-scoped exactly like
   * AnalyticsService.getEventAnalytics — a super-admin reads any event, an
   * organizer only their own, and a miss is a 404 either way so the endpoint
   * never confirms that someone else's event exists.
   */
  static async getEventFinancials(
    eventId: string,
    vendorId: string,
    isSuperAdmin = false
  ): Promise<EventFinancials> {
    const eventOid = new mongoose.Types.ObjectId(eventId);

    // Booking fees are Carrot's margin on the buyer, not the organizer's money.
    // Withheld at the API, not merely hidden in the dashboard — a UI-only hide
    // still ships the number to anyone who opens the network tab.
    const showFees = isSuperAdmin;

    const eventQuery: Record<string, unknown> = { _id: eventOid };
    if (!isSuperAdmin) eventQuery['vendorId'] = new mongoose.Types.ObjectId(vendorId);

    const event = await Event.findOne(eventQuery).select('currency');
    if (!event) throw new HttpError(404, 'Event not found');

    // One round trip. $facet runs every sub-pipeline over the same matched set,
    // so the method rows, the channel rows and the paid/free split can never
    // disagree about which sales they counted.
    //
    // The $match is by event ONLY — the completed-vs-failed filter lives inside
    // each sub-pipeline, because `failed` is the one facet that needs the sales
    // all the others must exclude.
    const COMPLETED_ONLY = { $match: { paymentStatus: PaymentStatus.COMPLETED } };
    const [facet] = await TicketSale.aggregate([
      { $match: { eventId: eventOid } },
      {
        $facet: {
          byMethod: [COMPLETED_ONLY, { $group: { _id: '$paymentMethod', ...MONEY_SUMS } }],
          byChannel: [COMPLETED_ONLY, { $group: { _id: '$channel', ...MONEY_SUMS } }],
          totals: [COMPLETED_ONLY, { $group: { _id: null, ...MONEY_SUMS } }],
          // A sale is "free" by its face value, not by its channel — that
          // catches a price-0 tier bought online as well as a wristband batch.
          entry: [
            COMPLETED_ONLY,
            {
              $group: {
                _id: { $eq: [{ $ifNull: ['$totalAmount', 0] }, 0] },
                sales: { $sum: 1 },
                tickets: { $sum: '$quantity' },
                face: { $sum: { $ifNull: ['$totalAmount', 0] } },
              },
            },
          ],
          // Custody buckets mirror SettlementService.previewOrganizerPayout's
          // rule exactly — reseller money only counts as available once the
          // covering settlement has been closed AND marked paid.
          custody: [
            COMPLETED_ONLY,
            {
              $group: {
                _id: { custody: '$fundsCustody', remitted: { $eq: ['$resellerRemitted', true] } },
                proceeds: { $sum: { $ifNull: ['$organizerProceeds', 0] } },
              },
            },
          ],
          failed: [
            { $match: { paymentStatus: PaymentStatus.FAILED } },
            {
              $group: {
                _id: null,
                sales: { $sum: 1 },
                tickets: { $sum: '$quantity' },
                face: { $sum: { $ifNull: ['$totalAmount', 0] } },
              },
            },
          ],
        },
      },
    ]);

    const byMethod: FinancialsMethodRow[] = (facet?.byMethod ?? [])
      .map((r: any) => ({ method: r._id as string, ...toRow(r, showFees) }))
      .sort((a: FinancialsMethodRow, b: FinancialsMethodRow) => b.face - a.face);

    const byChannel: FinancialsChannelRow[] = (facet?.byChannel ?? [])
      .map((r: any) => ({ channel: r._id as string, ...toRow(r, showFees) }))
      .sort((a: FinancialsChannelRow, b: FinancialsChannelRow) => b.face - a.face);

    // Built with showFees ALWAYS true so the fee sums exist locally, then
    // dropped below — keeping the arithmetic in one place regardless of who asks.
    const totalsRow = toRow(facet?.totals?.[0] ?? {}, true);
    const totals: FinancialsTotals = {
      face: totalsRow.face,
      platformFees: totalsRow.platformFee,
      resellerCommission: totalsRow.resellerCommission,
      organizerProceeds: totalsRow.organizerProceeds,
      ...(showFees
        ? {
            bookingFees: totalsRow.bookingFee,
            absorbedFees: totalsRow.absorbedFee,
            // Absorbed fees deliberately excluded — the organizer covered them,
            // so they were never added on top of what the buyer handed over.
            charged: totalsRow.charged,
            carrotEarned: round2(
              (totalsRow.bookingFee ?? 0) + (totalsRow.absorbedFee ?? 0) + totalsRow.platformFee
            ),
          }
        : {}),
    };

    const failedRow = facet?.failed?.[0];
    const failed: FinancialsFailed = {
      sales: failedRow?.sales ?? 0,
      tickets: failedRow?.tickets ?? 0,
      face: round2(failedRow?.face ?? 0),
    };

    const entry = (facet?.entry ?? []) as Array<{ _id: boolean; sales: number; tickets: number; face: number }>;
    const paidBucket = entry.find((e) => e._id === false);
    const compBucket = entry.find((e) => e._id === true);

    const paidTickets = paidBucket?.tickets ?? 0;
    const paidFace = paidBucket?.face ?? 0;

    const custodyRaw = (facet?.custody ?? []) as Array<{
      _id: { custody: string | null; remitted: boolean };
      proceeds: number;
    }>;
    const custodySum = (predicate: (row: (typeof custodyRaw)[number]) => boolean): number =>
      round2(custodyRaw.filter(predicate).reduce((acc, r) => acc + (r.proceeds ?? 0), 0));

    const withCarrot = custodySum((r) => r._id.custody === 'carrot');
    const withResellersUnremitted = custodySum((r) => r._id.custody === 'reseller' && !r._id.remitted);
    const withResellersRemitted = custodySum((r) => r._id.custody === 'reseller' && r._id.remitted);
    const withVendor = custodySum((r) => r._id.custody === 'vendor');

    return {
      currency: (event.currency ?? 'SZL') as EventCurrency,
      byMethod,
      byChannel,
      totals,
      failed,
      paid: {
        sales: paidBucket?.sales ?? 0,
        tickets: paidTickets,
        averageTicketPrice: paidTickets > 0 ? round2(paidFace / paidTickets) : 0,
      },
      comps: {
        sales: compBucket?.sales ?? 0,
        tickets: compBucket?.tickets ?? 0,
      },
      custody: {
        withCarrot,
        withResellersUnremitted,
        withResellersRemitted,
        withVendor,
        availableNow: round2(withCarrot + withResellersRemitted),
      },
    };
  }
}
