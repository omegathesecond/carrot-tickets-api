import { Request, Response } from 'express';
import Joi from 'joi';
import mongoose from 'mongoose';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { VerificationStatus } from '@interfaces/vendor.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { createOrganizerSchema } from '@validators/tickets.validator';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { VenueService } from '@services/venue.service';
import { IVenue, VenueSummary } from '@interfaces/venue.interface';
import { Venue } from '@models/venue.model';
import { ORGANIZER_TYPES, OrganizerType, VenueVendorIds, organizerTypeFilter, organizerTypeOf } from '@utils/organizerType.util';

const verificationSchema = Joi.object({
  status: Joi.string()
    .valid(...Object.values(VerificationStatus))
    .required(),
  rejectionReason: Joi.string().max(500).allow('').optional(),
});

const NOT_SUPER_ADMIN = { isSuperAdmin: { $ne: true } };

/**
 * `sort` values. Name is A-Z regardless of case, which needs a collation; the
 * `_id` tiebreak keeps pages stable when several accounts share a createdAt.
 */
const SORTS = {
  newest: { sort: { createdAt: -1, _id: -1 } },
  oldest: { sort: { createdAt: 1, _id: 1 } },
  name: { sort: { businessName: 1, _id: 1 }, collation: { locale: 'en', strength: 2 } },
} as const;
type OrganizerSort = keyof typeof SORTS;
const SORT_NAMES = Object.keys(SORTS) as OrganizerSort[];

/** `venueTrading` filter values -> the Venue status they select (none = no Venue record). */
const VENUE_TRADING_STATUS = { on: 'active', suspended: 'suspended' } as const;
const VENUE_TRADING_FILTERS = ['on', 'suspended', 'none'] as const;
type VenueTradingFilter = (typeof VENUE_TRADING_FILTERS)[number];

interface ListQuery {
  page: number;
  limit: number;
  search: string;
  status: VerificationStatus | undefined;
  type: OrganizerType | undefined;
  venueTrading: VenueTradingFilter | undefined;
  category: string;
  sort: OrganizerSort;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** An absent/empty param is "not sent"; a value outside `allowed` is null (the caller 400s). */
function enumParam<T extends string>(raw: string, allowed: readonly T[]): { value: T | undefined } | null {
  if (!raw) return { value: undefined };
  const match = allowed.find((a) => a === raw);
  return match ? { value: match } : null;
}

/** Validates the list query, or says which param is wrong. Messages are part of the API contract. */
function parseListQuery(q: Request['query']): ListQuery | { error: string } {
  // String() so a repeated or bracketed param (`type=a&type=b`) fails validation instead of slipping through.
  const str = (key: string) => String(q[key] ?? '').trim();

  const type = enumParam(str('type'), ORGANIZER_TYPES);
  if (!type) return { error: 'Unknown organizer type' };
  const status = enumParam(str('status'), Object.values(VerificationStatus));
  if (!status) return { error: 'Unknown verification status' };
  const sort = enumParam(str('sort'), SORT_NAMES);
  if (!sort) return { error: 'Unknown sort' };
  const venueTrading = enumParam(str('venueTrading'), VENUE_TRADING_FILTERS);
  if (!venueTrading) return { error: 'Unknown venue trading filter' };

  const category = str('category');
  if (venueTrading.value && type.value !== 'venues') return { error: 'venueTrading needs type=venues' };
  if (category && type.value !== 'services') return { error: 'category needs type=services' };

  return {
    page: Math.max(1, parseInt(String(q['page'] ?? '1'), 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(String(q['limit'] ?? '25'), 10) || 25)),
    search: str('search'),
    status: status.value,
    type: type.value,
    venueTrading: venueTrading.value,
    category,
    sort: sort.value ?? 'newest',
  };
}

/** on/suspended = the Venue record's status; none = no Venue record at all. */
function venueTradingClause(
  mode: VenueTradingFilter,
  venues: Array<Pick<IVenue, 'vendorId' | 'status'>>,
): Record<string, unknown> {
  if (mode === 'none') return { _id: { $nin: venues.map((v) => v.vendorId) } };
  const status = VENUE_TRADING_STATUS[mode];
  return { _id: { $in: venues.filter((v) => v.status === status).map((v) => v.vendorId) } };
}

/**
 * Organizers admin API — the vendor (event-organizer) directory behind the
 * dashboard "Organizers" tab. Super-admin only (gated in the route). The
 * super-admin's own platform account is excluded — it isn't an organizer.
 *
 * Verification drives the organizer lifecycle: self-signup lands PENDING,
 * publishEvent queues events until an admin flips the account to VERIFIED.
 */
export class AdminOrganizersController {
  /**
   * GET /api/tickets/admin/organizers
   *   ?type=&status=&search=&venueTrading=&category=&sort=&page=&limit=
   *
   * Paginated organizer list, each with event count + tickets sold + revenue +
   * venue summary + its account `type`. Every filter runs in the database, so
   * pages are full and `pagination.total` is the filtered count.
   *
   *   type          events|venues|services|transport — one account type (rules in
   *                 organizerType.util). Absent/empty = all.
   *   status        pending|verified|rejected|suspended. Absent/empty = all.
   *   search        case-insensitive match on name, email, phone, primary contact.
   *   venueTrading  on|suspended|none — ONLY with type=venues. on/suspended = the
   *                 Venue record's status; none = a venue account with no Venue yet.
   *   category      exact serviceCategory — ONLY with type=services.
   *   sort          newest (default) | oldest | name (A-Z, case-insensitive).
   *
   * An unknown or misplaced param is a 400, not a silent no-op.
   *
   * Besides the page it returns `statusCounts` (within the requested type, ignoring
   * every other filter), `typeCounts` (per type, ignoring every filter) and
   * `serviceCategories` (distinct categories in use) so the dashboard's chips and
   * dropdown stay stable while filtering.
   */
  static async listOrganizers(req: Request, res: Response): Promise<any> {
    const query = parseListQuery(req.query);
    if ('error' in query) return ApiResponseUtil.badRequest(res, query.error);

    try {
      const { page, limit, search, status, type, venueTrading, category, sort } = query;

      // One small read feeds the type filters, venueTrading and per-row classification.
      const venues = await Venue.find().select('vendorId status').lean<Array<Pick<IVenue, 'vendorId' | 'status'>>>();
      const venueVendorIds: VenueVendorIds = new Set(venues.map((v) => String(v.vendorId)));
      const scope = (t?: OrganizerType): Record<string, unknown> => ({
        $and: [NOT_SUPER_ADMIN, ...(t ? [organizerTypeFilter(t, venueVendorIds)] : [])],
      });

      const clauses: Array<Record<string, unknown>> = [scope(type)];
      if (status) clauses.push({ verificationStatus: status });
      if (search) {
        const rx = new RegExp(escapeRegex(search), 'i');
        clauses.push({ $or: [{ businessName: rx }, { email: rx }, { phoneNumber: rx }, { primaryContact: rx }] });
      }
      if (venueTrading) clauses.push(venueTradingClause(venueTrading, venues));
      // An anchored regex, not `{ serviceCategory: category }`: the name sort's
      // collation is query-wide and would turn a plain equality case-insensitive,
      // while a regex ignores collation, so the match stays exact.
      if (category) clauses.push({ serviceCategory: { $regex: `^${escapeRegex(category)}$` } });
      const filter = { $and: clauses };

      const sortSpec = SORTS[sort];
      const [vendors, total, statusRows, typeCountRows, serviceCategoryRows] = await Promise.all([
        Vendor.find(filter)
          // Collate ONLY the sort: a query-wide collation would make the exact
          // `category` match case-insensitive too.
          .setOptions('collation' in sortSpec ? { collation: sortSpec.collation } : {})
          .sort(sortSpec.sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .select('businessName email phoneNumber primaryContact businessType operatorType serviceCategory verificationStatus verifiedAt rejectionReason isActive createdAt')
          .lean(),
        Vendor.countDocuments(filter),
        // Status breakdown within the requested type, ignoring status/search/
        // venueTrading/category so the tab header chips stay stable while filtering.
        Vendor.aggregate<{ _id: string; count: number }>([
          { $match: scope(type) },
          { $group: { _id: '$verificationStatus', count: { $sum: 1 } } },
        ]),
        // Accounts per type, ignoring every filter.
        Promise.all(ORGANIZER_TYPES.map(async (t) => [t, await Vendor.countDocuments(scope(t))] as const)),
        Vendor.distinct('serviceCategory', { ...scope('services'), serviceCategory: { $type: 'string', $ne: '' } }),
      ]);

      // Per-organizer activity for just the vendors on this page.
      const vendorIds = vendors.map((v) => new mongoose.Types.ObjectId(String(v._id)));
      const [eventRows, saleRows, venuesByVendor] = vendorIds.length
        ? await Promise.all([
            Event.aggregate<{ _id: mongoose.Types.ObjectId; eventCount: number }>([
              { $match: { vendorId: { $in: vendorIds } } },
              { $group: { _id: '$vendorId', eventCount: { $sum: 1 } } },
            ]),
            TicketSale.aggregate<{ _id: mongoose.Types.ObjectId; ticketsSold: number; revenue: number }>([
              { $match: { vendorId: { $in: vendorIds }, paymentStatus: PaymentStatus.COMPLETED } },
              {
                $group: {
                  _id: '$vendorId',
                  ticketsSold: { $sum: '$quantity' },
                  revenue: { $sum: '$totalAmount' },
                },
              },
            ]),
            VenueService.summariesFor(vendorIds),
          ])
        : [[], [], new Map<string, VenueSummary>()];

      const eventsByVendor = new Map(eventRows.map((r) => [String(r._id), r.eventCount]));
      const salesByVendor = new Map(saleRows.map((r) => [String(r._id), r]));

      const organizers = vendors.map((v) => {
        const id = String(v._id);
        const s = salesByVendor.get(id);
        return {
          id,
          businessName: v.businessName,
          email: v.email ?? null,
          phoneNumber: v.phoneNumber ?? null,
          primaryContact: v.primaryContact ?? null,
          businessType: v.businessType ?? null,
          operatorType: v.operatorType ?? null,
          serviceCategory: v.serviceCategory ?? null,
          verificationStatus: v.verificationStatus,
          verifiedAt: v.verifiedAt ?? null,
          rejectionReason: v.rejectionReason ?? null,
          isActive: v.isActive,
          createdAt: v.createdAt,
          eventCount: eventsByVendor.get(id) ?? 0,
          ticketsSold: s?.ticketsSold ?? 0,
          revenue: s?.revenue ?? 0,
          venue: venuesByVendor.get(id) ?? null,
          type: organizerTypeOf(v, venueVendorIds),
        };
      });

      const statusCounts: Record<string, number> = {};
      for (const row of statusRows) statusCounts[row._id] = row.count;

      const perType = Object.fromEntries(typeCountRows) as Record<OrganizerType, number>;
      const typeCounts = { all: typeCountRows.reduce((sum, [, count]) => sum + count, 0), ...perType };

      const serviceCategories = (serviceCategoryRows as string[]).sort((a, b) => a.localeCompare(b, 'en'));

      return ApiResponseUtil.success(res, {
        organizers,
        statusCounts,
        typeCounts,
        serviceCategories,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      console.error('List organizers error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load organizers', 500);
    }
  }

  /**
   * POST /api/tickets/admin/organizers — super-admin creates a (verified) operator.
   * The only path that can set operatorType to transport/both — self-signup
   * (TicketsAuthService.register) always lands events-only and PENDING.
   */
  static async createOrganizer(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = createOrganizerSchema.validate(req.body);
      if (error) return ApiResponseUtil.badRequest(res, error.message);
      const vendor = await TicketsAuthService.adminCreateOperator(value);
      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        operatorType: vendor.operatorType,
        email: vendor.email ?? null,
        phoneNumber: vendor.phoneNumber ?? null,
        verificationStatus: vendor.verificationStatus,
      }, 'Operator created', 201);
    } catch (error: any) {
      console.error('Create organizer error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to create operator', 400);
    }
  }

  /**
   * PATCH /api/tickets/admin/organizers/:id/verification { status, rejectionReason? }
   * Move an organizer through the verification lifecycle. Verifying stamps
   * verifiedAt; rejecting/suspending records the reason and clears verifiedAt.
   */
  static async updateVerification(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = verificationSchema.validate(req.body);
      if (error) return ApiResponseUtil.badRequest(res, error.message);

      const vendor = await Vendor.findOne({ _id: req.params['id'], isSuperAdmin: { $ne: true } });
      if (!vendor) return ApiResponseUtil.notFound(res, 'Organizer not found');

      vendor.verificationStatus = value.status;
      if (value.status === VerificationStatus.VERIFIED) {
        vendor.verifiedAt = new Date();
        vendor.rejectionReason = undefined;
      } else {
        vendor.verifiedAt = undefined;
        vendor.rejectionReason = value.rejectionReason || undefined;
      }
      await vendor.save();

      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        verificationStatus: vendor.verificationStatus,
        verifiedAt: vendor.verifiedAt ?? null,
        rejectionReason: vendor.rejectionReason ?? null,
      });
    } catch (error: any) {
      console.error('Update organizer verification error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to update organizer', 500);
    }
  }
}
