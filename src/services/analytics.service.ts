import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketSale } from '@models/ticketSale.model';
import { TicketScan } from '@models/ticketScan.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketStatus, PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

export interface AnalyticsQuery {
  vendorId: string;
  startDate?: Date;
  endDate?: Date;
  eventId?: string;
  isSuperAdmin?: boolean;
}

export interface DashboardStats {
  events: {
    total: number;
    draft: number;
    published: number;
    completed: number;
    cancelled: number;
  };
  tickets: {
    totalSold: number;
    totalRevenue: number;
    totalCheckedIn: number;
    checkInRate: number;
  };
  sales: {
    totalSales: number;
    cashSales: number;
    walletSales: number;
    cashRevenue: number;
    walletRevenue: number;
  };
  recentActivity: {
    recentSales: any[];
    recentScans: any[];
    upcomingEvents: any[];
  };
}

export interface SalesStats {
  period: string;
  totalSales: number;
  totalRevenue: number;
  ticketsSold: number;
  averageOrderValue: number;
  salesByPaymentMethod: {
    cash: { count: number; revenue: number };
    wallet: { count: number; revenue: number };
  };
  salesByEvent: Array<{
    eventId: string;
    eventName: string;
    ticketsSold: number;
    revenue: number;
  }>;
}

export interface RevenueStats {
  period: string;
  totalRevenue: number;
  ticketsSold: number;
  averageTicketPrice: number;
  revenueByEvent: Array<{
    eventId: string;
    eventName: string;
    revenue: number;
    ticketsSold: number;
  }>;
  revenueByPaymentMethod: Array<{
    method: 'cash' | 'keshless_wallet';
    amount: number;
    count: number;
  }>;
  dailyRevenue?: Array<{
    date: string;
    revenue: number;
    ticketsSold: number;
  }>;
}

export class AnalyticsService {
  /**
   * Get dashboard statistics
   */
  static async getDashboardStats(query: AnalyticsQuery): Promise<any> {
    try {
      const { vendorId, startDate, endDate, isSuperAdmin = false } = query;

      // Build date filter
      const dateFilter: any = {};
      if (startDate || endDate) {
        dateFilter.createdAt = {};
        if (startDate) dateFilter.createdAt.$gte = startDate;
        if (endDate) dateFilter.createdAt.$lte = endDate;
      }

      // Build vendor filter - skip for superadmin
      const vendorFilter: any = {};
      if (!isSuperAdmin) {
        vendorFilter.vendorId = new mongoose.Types.ObjectId(vendorId);
      }

      // Get event stats
      const eventStats = await Event.aggregate([
        { $match: { ...vendorFilter, ...dateFilter } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);

      const events = {
        total: 0,
        draft: 0,
        published: 0,
        completed: 0,
        cancelled: 0
      };

      eventStats.forEach(stat => {
        events.total += stat.count;
        if (stat._id === EventStatus.DRAFT) events.draft = stat.count;
        if (stat._id === EventStatus.PUBLISHED) events.published = stat.count;
        if (stat._id === EventStatus.COMPLETED) events.completed = stat.count;
        if (stat._id === EventStatus.CANCELLED) events.cancelled = stat.count;
      });

      // Get ticket stats
      const salesFilter: any = { ...vendorFilter, paymentStatus: PaymentStatus.COMPLETED };
      if (startDate || endDate) {
        salesFilter.soldAt = {};
        if (startDate) salesFilter.soldAt.$gte = startDate;
        if (endDate) salesFilter.soldAt.$lte = endDate;
      }

      // Build ticket filter for count
      const ticketFilter: any = { status: TicketStatus.CHECKED_IN, ...dateFilter };
      if (!isSuperAdmin) {
        ticketFilter.vendorId = vendorId;
      }

      const [ticketsSoldResult, totalRevenueResult, checkedInCount] = await Promise.all([
        TicketSale.aggregate([
          { $match: salesFilter },
          { $group: { _id: null, total: { $sum: '$quantity' } } }
        ]),
        TicketSale.aggregate([
          { $match: salesFilter },
          { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]),
        Ticket.countDocuments(ticketFilter)
      ]);

      const totalSold = ticketsSoldResult[0]?.total || 0;
      const totalRevenue = totalRevenueResult[0]?.total || 0;
      const checkInRate = totalSold > 0 ? (checkedInCount / totalSold) * 100 : 0;

      const tickets = {
        totalSold,
        totalRevenue,
        totalCheckedIn: checkedInCount,
        checkInRate: Math.round(checkInRate * 100) / 100
      };

      // Get sales stats by payment method
      const salesByMethod = await TicketSale.aggregate([
        { $match: salesFilter },
        {
          $group: {
            _id: '$paymentMethod',
            count: { $sum: 1 },
            revenue: { $sum: '$totalAmount' }
          }
        }
      ]);

      const sales = {
        totalSales: 0,
        cashSales: 0,
        walletSales: 0,
        cashRevenue: 0,
        walletRevenue: 0
      };

      salesByMethod.forEach(stat => {
        sales.totalSales += stat.count;
        if (stat._id === PaymentMethod.CASH) {
          sales.cashSales = stat.count;
          sales.cashRevenue = stat.revenue;
        } else if (stat._id === PaymentMethod.KESHLESS_WALLET) {
          sales.walletSales = stat.count;
          sales.walletRevenue = stat.revenue;
        }
      });

      // Get recent activity
      const recentActivityFilter: any = isSuperAdmin ? {} : { vendorId: new mongoose.Types.ObjectId(vendorId) };
      const upcomingEventsFilter: any = {
        status: EventStatus.PUBLISHED,
        eventDate: { $gte: new Date() }
      };
      if (!isSuperAdmin) {
        upcomingEventsFilter.vendorId = new mongoose.Types.ObjectId(vendorId);
      }

      const [recentSales, recentScans, upcomingEvents] = await Promise.all([
        TicketSale.find(recentActivityFilter)
          .populate('eventId', 'name venue')
          .sort({ soldAt: -1 })
          .limit(5)
          .lean(),
        TicketScan.find(recentActivityFilter)
          .populate('ticketId')
          .populate('eventId', 'name venue')
          .sort({ scannedAt: -1 })
          .limit(5)
          .lean(),
        Event.find(upcomingEventsFilter)
          .sort({ eventDate: 1 })
          .limit(5)
          .lean()
      ]);

      return {
        // Flat structure for frontend compatibility
        totalRevenue: tickets.totalRevenue,
        ticketsSold: tickets.totalSold,
        activeEvents: events.published, // Active = published events
        todayScans: tickets.totalCheckedIn, // Using total checked in as proxy for scans
        revenueChange: 0, // TODO: Calculate based on previous period
        salesChange: 0, // TODO: Calculate based on previous period
        eventsChange: 0, // TODO: Calculate based on previous period
        scansChange: 0, // TODO: Calculate based on previous period
        // Nested structure for detailed views
        events,
        tickets,
        sales,
        recentActivity: {
          recentSales,
          recentScans,
          upcomingEvents
        }
      };
    } catch (error: any) {
      console.error('Get dashboard stats error:', error);
      throw new Error(error.message || 'Failed to fetch dashboard statistics');
    }
  }

  /**
   * Get sales statistics
   */
  static async getSalesStats(query: AnalyticsQuery): Promise<SalesStats> {
    try {
      const { vendorId, startDate, endDate, eventId, isSuperAdmin = false } = query;

      // Build filter - skip vendorId for superadmin
      const filter: any = {
        paymentStatus: PaymentStatus.COMPLETED
      };
      if (!isSuperAdmin) {
        filter.vendorId = new mongoose.Types.ObjectId(vendorId);
      }

      if (eventId) filter.eventId = new mongoose.Types.ObjectId(eventId);

      if (startDate || endDate) {
        filter.soldAt = {};
        if (startDate) filter.soldAt.$gte = startDate;
        if (endDate) filter.soldAt.$lte = endDate;
      }

      // Get overall stats
      const overallStats = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalSales: { $sum: 1 },
            totalRevenue: { $sum: '$totalAmount' },
            ticketsSold: { $sum: '$quantity' }
          }
        }
      ]);

      const stats = overallStats[0] || { totalSales: 0, totalRevenue: 0, ticketsSold: 0 };
      const averageOrderValue = stats.totalSales > 0 ? stats.totalRevenue / stats.totalSales : 0;

      // Sales by payment method
      const methodStats = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$paymentMethod',
            count: { $sum: 1 },
            revenue: { $sum: '$totalAmount' }
          }
        }
      ]);

      const salesByPaymentMethod = {
        cash: { count: 0, revenue: 0 },
        wallet: { count: 0, revenue: 0 }
      };

      methodStats.forEach(stat => {
        if (stat._id === PaymentMethod.CASH) {
          salesByPaymentMethod.cash = { count: stat.count, revenue: stat.revenue };
        } else if (stat._id === PaymentMethod.KESHLESS_WALLET) {
          salesByPaymentMethod.wallet = { count: stat.count, revenue: stat.revenue };
        }
      });

      // Sales by event
      const eventStats = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$eventId',
            ticketsSold: { $sum: '$quantity' },
            revenue: { $sum: '$totalAmount' }
          }
        },
        { $sort: { revenue: -1 } },
        {
          $lookup: {
            from: 'events',
            localField: '_id',
            foreignField: '_id',
            as: 'event'
          }
        },
        { $unwind: '$event' }
      ]);

      const salesByEvent = eventStats.map(stat => ({
        eventId: stat._id.toString(),
        eventName: stat.event.name,
        ticketsSold: stat.ticketsSold,
        revenue: stat.revenue
      }));

      const period = this.getPeriodString(startDate, endDate);

      return {
        period,
        totalSales: stats.totalSales,
        totalRevenue: stats.totalRevenue,
        ticketsSold: stats.ticketsSold,
        averageOrderValue: Math.round(averageOrderValue * 100) / 100,
        salesByPaymentMethod,
        salesByEvent
      };
    } catch (error: any) {
      console.error('Get sales stats error:', error);
      throw new Error(error.message || 'Failed to fetch sales statistics');
    }
  }

  /**
   * Get revenue statistics with time series data
   */
  static async getRevenueStats(
    query: AnalyticsQuery & { groupBy?: 'daily' | 'weekly' | 'monthly' }
  ): Promise<RevenueStats> {
    try {
      const { vendorId, startDate, endDate, eventId, groupBy = 'daily', isSuperAdmin = false } = query;

      // Build filter - skip vendorId for superadmin
      const filter: any = {
        paymentStatus: PaymentStatus.COMPLETED
      };
      if (!isSuperAdmin) {
        filter.vendorId = new mongoose.Types.ObjectId(vendorId);
      }

      if (eventId) filter.eventId = new mongoose.Types.ObjectId(eventId);

      if (startDate || endDate) {
        filter.soldAt = {};
        if (startDate) filter.soldAt.$gte = startDate;
        if (endDate) filter.soldAt.$lte = endDate;
      }

      // Get total revenue by payment method
      const methodStats = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$paymentMethod',
            revenue: { $sum: '$totalAmount' }
          }
        }
      ]);

      let totalRevenue = 0;
      let cashRevenue = 0;
      let walletRevenue = 0;

      methodStats.forEach(stat => {
        totalRevenue += stat.revenue;
        if (stat._id === PaymentMethod.CASH) cashRevenue = stat.revenue;
        if (stat._id === PaymentMethod.KESHLESS_WALLET) walletRevenue = stat.revenue;
      });

      // Revenue by day/week/month
      const dateGrouping = this.getDateGrouping(groupBy);
      const revenueByTime = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: dateGrouping,
            revenue: { $sum: '$totalAmount' },
            ticketsSold: { $sum: '$quantity' }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      const dailyRevenue = revenueByTime.map(stat => ({
        date: this.formatDate(stat._id, groupBy),
        revenue: stat.revenue,
        ticketsSold: stat.ticketsSold
      }));

      // Revenue by event
      const eventStats = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$eventId',
            revenue: { $sum: '$totalAmount' },
            ticketsSold: { $sum: '$quantity' }
          }
        },
        { $sort: { revenue: -1 } },
        {
          $lookup: {
            from: 'events',
            localField: '_id',
            foreignField: '_id',
            as: 'event'
          }
        },
        { $unwind: '$event' }
      ]);

      const revenueByEvent = eventStats.map(stat => ({
        eventId: stat._id.toString(),
        eventName: stat.event.name,
        revenue: stat.revenue,
        ticketsSold: stat.ticketsSold
      }));

      // Calculate total tickets sold
      const totalTicketsSold = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            total: { $sum: '$quantity' }
          }
        }
      ]);
      const ticketsSold = totalTicketsSold[0]?.total || 0;

      // Calculate average ticket price
      const averageTicketPrice = ticketsSold > 0 ? totalRevenue / ticketsSold : 0;

      // Build payment method breakdown array
      const paymentMethodStats = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$paymentMethod',
            amount: { $sum: '$totalAmount' },
            count: { $sum: 1 }
          }
        }
      ]);

      const revenueByPaymentMethod = paymentMethodStats.map(stat => ({
        method: stat._id as 'cash' | 'keshless_wallet',
        amount: stat.amount,
        count: stat.count
      }));

      const period = this.getPeriodString(startDate, endDate);

      return {
        period,
        totalRevenue,
        ticketsSold,
        averageTicketPrice,
        revenueByEvent,
        revenueByPaymentMethod,
        dailyRevenue
      };
    } catch (error: any) {
      console.error('Get revenue stats error:', error);
      throw new Error(error.message || 'Failed to fetch revenue statistics');
    }
  }

  /**
   * Get event-specific analytics
   */
  static async getEventAnalytics(eventId: string, vendorId: string, isSuperAdmin: boolean = false) {
    try {
      // Build event query - skip vendorId for superadmin
      const eventQuery: any = { _id: new mongoose.Types.ObjectId(eventId) };
      if (!isSuperAdmin) {
        eventQuery.vendorId = new mongoose.Types.ObjectId(vendorId);
      }

      const event = await Event.findOne(eventQuery);
      if (!event) {
        throw new Error('Event not found');
      }

      // Build filter for queries - skip vendorId for superadmin
      const eventIdFilter: any = { eventId: new mongoose.Types.ObjectId(eventId) };
      if (!isSuperAdmin) {
        eventIdFilter.vendorId = new mongoose.Types.ObjectId(vendorId);
      }

      // Get sales data
      const [
        totalSales,
        totalRevenue,
        ticketsSold,
        checkedInCount,
        salesByType
      ] = await Promise.all([
        TicketSale.countDocuments({
          ...eventIdFilter,
          paymentStatus: PaymentStatus.COMPLETED
        }),
        TicketSale.aggregate([
          {
            $match: {
              ...eventIdFilter,
              paymentStatus: PaymentStatus.COMPLETED
            }
          },
          { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]),
        Ticket.countDocuments({ ...eventIdFilter, status: TicketStatus.SOLD }),
        Ticket.countDocuments({ ...eventIdFilter, status: TicketStatus.CHECKED_IN }),
        Ticket.aggregate([
          { $match: eventIdFilter },
          {
            $group: {
              _id: '$ticketType',
              sold: { $sum: 1 },
              revenue: { $sum: '$price' }
            }
          }
        ])
      ]);

      const revenue = totalRevenue[0]?.total || 0;
      const checkInRate = ticketsSold > 0 ? (checkedInCount / ticketsSold) * 100 : 0;

      return {
        event: {
          id: event._id,
          name: event.name,
          venue: event.venue,
          eventDate: event.eventDate,
          status: event.status
        },
        sales: {
          totalSales,
          totalRevenue: revenue,
          ticketsSold,
          checkedIn: checkedInCount,
          checkInRate: Math.round(checkInRate * 100) / 100
        },
        ticketTypes: event.ticketTypes.map(tt => {
          const typeStats = salesByType.find(s => s._id === tt.name);
          return {
            name: tt.name,
            price: tt.price,
            quantity: tt.quantity,
            sold: tt.sold,
            available: tt.available,
            revenue: typeStats?.revenue || 0
          };
        })
      };
    } catch (error: any) {
      console.error('Get event analytics error:', error);
      throw new Error(error.message || 'Failed to fetch event analytics');
    }
  }

  /**
   * Helper: Get date grouping for aggregation
   */
  private static getDateGrouping(groupBy: 'daily' | 'weekly' | 'monthly') {
    switch (groupBy) {
      case 'daily':
        return {
          year: { $year: '$soldAt' },
          month: { $month: '$soldAt' },
          day: { $dayOfMonth: '$soldAt' }
        };
      case 'weekly':
        return {
          year: { $year: '$soldAt' },
          week: { $week: '$soldAt' }
        };
      case 'monthly':
        return {
          year: { $year: '$soldAt' },
          month: { $month: '$soldAt' }
        };
      default:
        return {
          year: { $year: '$soldAt' },
          month: { $month: '$soldAt' },
          day: { $dayOfMonth: '$soldAt' }
        };
    }
  }

  /**
   * Helper: Format date based on grouping
   */
  private static formatDate(dateObj: any, groupBy: 'daily' | 'weekly' | 'monthly'): string {
    if (groupBy === 'daily') {
      return `${dateObj.year}-${String(dateObj.month).padStart(2, '0')}-${String(dateObj.day).padStart(2, '0')}`;
    } else if (groupBy === 'weekly') {
      return `${dateObj.year}-W${String(dateObj.week).padStart(2, '0')}`;
    } else {
      return `${dateObj.year}-${String(dateObj.month).padStart(2, '0')}`;
    }
  }

  /**
   * Helper: Get period string
   */
  private static getPeriodString(startDate?: Date, endDate?: Date): string {
    if (!startDate && !endDate) return 'All time';
    if (startDate && !endDate) return `From ${startDate.toLocaleDateString()}`;
    if (!startDate && endDate) return `Until ${endDate.toLocaleDateString()}`;
    return `${startDate!.toLocaleDateString()} - ${endDate!.toLocaleDateString()}`;
  }
}
