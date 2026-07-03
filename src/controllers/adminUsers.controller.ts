import { Request, Response } from 'express';
import { Buyer } from '@models/buyer.model';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Platform Users admin API — the registered-buyer directory + signup analytics
 * behind the dashboard "Users" tab. Buyers are platform-wide (they sign up on
 * carrottickets.com and can buy from any event), so this is Carrot-staff-only;
 * access is gated in the route by requireSuperAdminOrPermission(VIEW_USERS).
 *
 * Per-buyer purchase stats are aggregated from completed TicketSale rows keyed
 * on customerPhone (normalised on both sides — see buyer phone normalization).
 */
export class AdminUsersController {
  /**
   * GET /api/tickets/admin/users?search=&page=&limit=
   * Paginated buyer list, each with tickets bought / total spent / last purchase.
   */
  static async listUsers(req: Request, res: Response): Promise<any> {
    try {
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '25'), 10) || 25));
      const search = String(req.query['search'] ?? '').trim();

      const filter: Record<string, unknown> = {};
      if (search) {
        const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter['$or'] = [{ name: rx }, { phone: rx }];
      }

      const [buyers, total] = await Promise.all([
        Buyer.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select('name phone createdAt lastLoginAt')
          .lean(),
        Buyer.countDocuments(filter),
      ]);

      // Aggregate purchase stats for just the phones on this page.
      const phones = buyers.map((b) => b.phone);
      const statsRows = phones.length
        ? await TicketSale.aggregate<{ _id: string; ticketsBought: number; totalSpent: number; lastPurchaseAt: Date }>([
            { $match: { customerPhone: { $in: phones }, paymentStatus: PaymentStatus.COMPLETED } },
            {
              $group: {
                _id: '$customerPhone',
                ticketsBought: { $sum: '$quantity' },
                totalSpent: { $sum: '$totalAmount' },
                lastPurchaseAt: { $max: '$createdAt' },
              },
            },
          ])
        : [];

      const statsByPhone = new Map(statsRows.map((s) => [s._id, s]));

      const users = buyers.map((b) => {
        const s = statsByPhone.get(b.phone);
        return {
          id: String(b._id),
          name: b.name ?? null,
          phone: b.phone,
          createdAt: b.createdAt,
          lastLoginAt: b.lastLoginAt ?? null,
          ticketsBought: s?.ticketsBought ?? 0,
          totalSpent: s?.totalSpent ?? 0,
          lastPurchaseAt: s?.lastPurchaseAt ?? null,
        };
      });

      return ApiResponseUtil.success(res, {
        users,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      console.error('List users error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load users', 500);
    }
  }

  /**
   * GET /api/tickets/admin/users/analytics
   * Signup KPIs + a trailing-30-day signups-per-day series.
   */
  static async analytics(_req: Request, res: Response): Promise<any> {
    try {
      const now = Date.now();
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

      const [totalUsers, newThisWeek, newThisMonth, purchasingPhones, signupRows] = await Promise.all([
        Buyer.countDocuments({}),
        Buyer.countDocuments({ createdAt: { $gte: weekAgo } }),
        Buyer.countDocuments({ createdAt: { $gte: monthAgo } }),
        TicketSale.distinct('customerPhone', { paymentStatus: PaymentStatus.COMPLETED }),
        Buyer.aggregate<{ _id: string; count: number }>([
          { $match: { createdAt: { $gte: monthAgo } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]),
      ]);

      // "Active buyers" = registered buyers who have completed at least one
      // purchase (excludes walk-in POS phones that never signed up).
      const activeBuyers = purchasingPhones.length
        ? await Buyer.countDocuments({ phone: { $in: purchasingPhones } })
        : 0;

      return ApiResponseUtil.success(res, {
        totalUsers,
        newThisWeek,
        newThisMonth,
        activeBuyers,
        signups: signupRows.map((r) => ({ date: r._id, count: r.count })),
      });
    } catch (error: any) {
      console.error('Users analytics error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load user analytics', 500);
    }
  }
}
