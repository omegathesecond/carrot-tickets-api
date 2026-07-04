import { Request, Response } from 'express';
import Joi from 'joi';
import mongoose from 'mongoose';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { VerificationStatus } from '@interfaces/vendor.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

const verificationSchema = Joi.object({
  status: Joi.string()
    .valid(...Object.values(VerificationStatus))
    .required(),
  rejectionReason: Joi.string().max(500).allow('').optional(),
});

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
   * GET /api/tickets/admin/organizers?search=&status=&page=&limit=
   * Paginated organizer list, each with event count + tickets sold + revenue.
   */
  static async listOrganizers(req: Request, res: Response): Promise<any> {
    try {
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '25'), 10) || 25));
      const search = String(req.query['search'] ?? '').trim();
      const status = String(req.query['status'] ?? '').trim();

      const filter: Record<string, unknown> = { isSuperAdmin: { $ne: true } };
      if (search) {
        const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter['$or'] = [{ businessName: rx }, { email: rx }, { phoneNumber: rx }, { primaryContact: rx }];
      }
      if (status && (Object.values(VerificationStatus) as string[]).includes(status)) {
        filter['verificationStatus'] = status;
      }

      const [vendors, total, statusRows] = await Promise.all([
        Vendor.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select('businessName email phoneNumber primaryContact businessType verificationStatus verifiedAt rejectionReason isActive createdAt')
          .lean(),
        Vendor.countDocuments(filter),
        // Status breakdown across ALL organizers (ignores search/status filter)
        // so the tab header chips stay stable while filtering.
        Vendor.aggregate<{ _id: string; count: number }>([
          { $match: { isSuperAdmin: { $ne: true } } },
          { $group: { _id: '$verificationStatus', count: { $sum: 1 } } },
        ]),
      ]);

      // Per-organizer activity for just the vendors on this page.
      const vendorIds = vendors.map((v) => new mongoose.Types.ObjectId(String(v._id)));
      const [eventRows, saleRows] = vendorIds.length
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
          ])
        : [[], []];

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
          verificationStatus: v.verificationStatus,
          verifiedAt: v.verifiedAt ?? null,
          rejectionReason: v.rejectionReason ?? null,
          isActive: v.isActive,
          createdAt: v.createdAt,
          eventCount: eventsByVendor.get(id) ?? 0,
          ticketsSold: s?.ticketsSold ?? 0,
          revenue: s?.revenue ?? 0,
        };
      });

      const statusCounts: Record<string, number> = {};
      for (const row of statusRows) statusCounts[row._id] = row.count;

      return ApiResponseUtil.success(res, {
        organizers,
        statusCounts,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      console.error('List organizers error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load organizers', 500);
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
