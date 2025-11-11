import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { TicketScan } from '@models/ticketScan.model';
import { Event } from '@models/event.model';
import { PaymentStatus } from '@interfaces/ticket.interface';

export interface ExportQuery {
  vendorId: string;
  eventId?: string;
  startDate?: Date;
  endDate?: Date;
}

export class ExportService {
  /**
   * Export sales to CSV
   */
  static async exportSalesToCSV(query: ExportQuery): Promise<string> {
    try {
      const { vendorId, eventId, startDate, endDate } = query;

      // Build filter
      const filter: any = {
        vendorId,
        paymentStatus: PaymentStatus.COMPLETED
      };

      if (eventId) filter.eventId = eventId;

      if (startDate || endDate) {
        filter.soldAt = {};
        if (startDate) filter.soldAt.$gte = startDate;
        if (endDate) filter.soldAt.$lte = endDate;
      }

      // Get sales
      const sales = await TicketSale.find(filter)
        .populate('eventId', 'name venue eventDate')
        .populate('soldBy')
        .sort({ soldAt: -1 })
        .lean();

      // Generate CSV
      const headers = [
        'Sale ID',
        'Event',
        'Venue',
        'Event Date',
        'Quantity',
        'Total Amount',
        'Payment Method',
        'Customer Name',
        'Customer Phone',
        'Sold By',
        'Sold At'
      ];

      const rows = sales.map(sale => {
        const event: any = sale.eventId;
        const soldBy: any = sale.soldBy;

        return [
          sale.saleId,
          event?.name || 'N/A',
          event?.venue || 'N/A',
          event?.eventDate ? new Date(event.eventDate).toLocaleDateString() : 'N/A',
          sale.quantity,
          sale.totalAmount.toFixed(2),
          sale.paymentMethod,
          sale.customerName || 'N/A',
          sale.customerPhone || 'N/A',
          soldBy?.businessName || soldBy?.username || 'N/A',
          new Date(sale.soldAt).toLocaleString()
        ];
      });

      return this.arrayToCSV([headers, ...rows]);
    } catch (error: any) {
      console.error('Export sales to CSV error:', error);
      throw new Error(error.message || 'Failed to export sales');
    }
  }

  /**
   * Export tickets to CSV
   */
  static async exportTicketsToCSV(query: ExportQuery): Promise<string> {
    try {
      const { vendorId, eventId, startDate, endDate } = query;

      // Build filter
      const filter: any = { vendorId };

      if (eventId) filter.eventId = eventId;

      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = startDate;
        if (endDate) filter.createdAt.$lte = endDate;
      }

      // Get tickets
      const tickets = await Ticket.find(filter)
        .populate('eventId', 'name venue eventDate')
        .sort({ createdAt: -1 })
        .lean();

      // Generate CSV
      const headers = [
        'Ticket ID',
        'Event',
        'Venue',
        'Event Date',
        'Ticket Type',
        'Price',
        'Status',
        'Customer Name',
        'Customer Phone',
        'Checked In At',
        'Created At'
      ];

      const rows = tickets.map(ticket => {
        const event: any = ticket.eventId;

        return [
          ticket.ticketId,
          event?.name || 'N/A',
          event?.venue || 'N/A',
          event?.eventDate ? new Date(event.eventDate).toLocaleDateString() : 'N/A',
          ticket.ticketType,
          ticket.price.toFixed(2),
          ticket.status,
          ticket.customerName || 'N/A',
          ticket.customerPhone || 'N/A',
          ticket.checkedInAt ? new Date(ticket.checkedInAt).toLocaleString() : 'N/A',
          new Date(ticket.createdAt).toLocaleString()
        ];
      });

      return this.arrayToCSV([headers, ...rows]);
    } catch (error: any) {
      console.error('Export tickets to CSV error:', error);
      throw new Error(error.message || 'Failed to export tickets');
    }
  }

  /**
   * Export scans to CSV
   */
  static async exportScansToCSV(query: ExportQuery): Promise<string> {
    try {
      const { vendorId, eventId, startDate, endDate } = query;

      // Build filter
      const filter: any = { vendorId };

      if (eventId) filter.eventId = eventId;

      if (startDate || endDate) {
        filter.scannedAt = {};
        if (startDate) filter.scannedAt.$gte = startDate;
        if (endDate) filter.scannedAt.$lte = endDate;
      }

      // Get scans
      const scans = await TicketScan.find(filter)
        .populate('ticketId')
        .populate('eventId', 'name venue eventDate')
        .populate('scannedBy')
        .sort({ scannedAt: -1 })
        .lean();

      // Generate CSV
      const headers = [
        'Event',
        'Venue',
        'Ticket ID',
        'Scan Result',
        'Is Valid',
        'Scanned By',
        'Scanned At',
        'Notes'
      ];

      const rows = scans.map(scan => {
        const event: any = scan.eventId;
        const ticket: any = scan.ticketId;
        const scannedBy: any = scan.scannedBy;

        return [
          event?.name || 'N/A',
          event?.venue || 'N/A',
          ticket?.ticketId || 'N/A',
          scan.scanResult,
          scan.isValid ? 'Yes' : 'No',
          scannedBy?.businessName || scannedBy?.username || 'N/A',
          new Date(scan.scannedAt).toLocaleString(),
          scan.notes || ''
        ];
      });

      return this.arrayToCSV([headers, ...rows]);
    } catch (error: any) {
      console.error('Export scans to CSV error:', error);
      throw new Error(error.message || 'Failed to export scans');
    }
  }

  /**
   * Export revenue report to CSV
   */
  static async exportRevenueToCSV(query: ExportQuery): Promise<string> {
    try {
      const { vendorId, eventId, startDate, endDate } = query;

      // Build filter
      const filter: any = {
        vendorId,
        paymentStatus: PaymentStatus.COMPLETED
      };

      if (eventId) filter.eventId = eventId;

      if (startDate || endDate) {
        filter.soldAt = {};
        if (startDate) filter.soldAt.$gte = startDate;
        if (endDate) filter.soldAt.$lte = endDate;
      }

      // Get sales grouped by event
      const revenueByEvent = await TicketSale.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$eventId',
            totalSales: { $sum: 1 },
            totalRevenue: { $sum: '$totalAmount' },
            ticketsSold: { $sum: '$quantity' },
            cashRevenue: {
              $sum: {
                $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0]
              }
            },
            walletRevenue: {
              $sum: {
                $cond: [{ $eq: ['$paymentMethod', 'keshless_wallet'] }, '$totalAmount', 0]
              }
            }
          }
        },
        { $sort: { totalRevenue: -1 } },
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

      // Generate CSV
      const headers = [
        'Event',
        'Venue',
        'Event Date',
        'Total Sales',
        'Tickets Sold',
        'Total Revenue',
        'Cash Revenue',
        'Wallet Revenue'
      ];

      const rows = revenueByEvent.map(item => [
        item.event.name,
        item.event.venue,
        new Date(item.event.eventDate).toLocaleDateString(),
        item.totalSales,
        item.ticketsSold,
        item.totalRevenue.toFixed(2),
        item.cashRevenue.toFixed(2),
        item.walletRevenue.toFixed(2)
      ]);

      // Add totals row
      const totals = revenueByEvent.reduce(
        (acc, item) => {
          acc.totalSales += item.totalSales;
          acc.ticketsSold += item.ticketsSold;
          acc.totalRevenue += item.totalRevenue;
          acc.cashRevenue += item.cashRevenue;
          acc.walletRevenue += item.walletRevenue;
          return acc;
        },
        { totalSales: 0, ticketsSold: 0, totalRevenue: 0, cashRevenue: 0, walletRevenue: 0 }
      );

      rows.push([
        'TOTAL',
        '',
        '',
        totals.totalSales.toString(),
        totals.ticketsSold.toString(),
        totals.totalRevenue.toFixed(2),
        totals.cashRevenue.toFixed(2),
        totals.walletRevenue.toFixed(2)
      ]);

      return this.arrayToCSV([headers, ...rows]);
    } catch (error: any) {
      console.error('Export revenue to CSV error:', error);
      throw new Error(error.message || 'Failed to export revenue report');
    }
  }

  /**
   * Export event summary to CSV
   */
  static async exportEventSummaryToCSV(eventId: string, vendorId: string): Promise<string> {
    try {
      const event = await Event.findOne({ _id: eventId, vendorId });
      if (!event) {
        throw new Error('Event not found');
      }

      // Get event stats
      const [sales, tickets, scans] = await Promise.all([
        TicketSale.find({
          eventId,
          vendorId,
          paymentStatus: PaymentStatus.COMPLETED
        }).lean(),
        Ticket.find({ eventId, vendorId }).lean(),
        TicketScan.find({ eventId, vendorId }).lean()
      ]);

      // Calculate stats
      const totalRevenue = sales.reduce((sum, sale) => sum + sale.totalAmount, 0);
      const cashRevenue = sales
        .filter(s => s.paymentMethod === 'cash')
        .reduce((sum, sale) => sum + sale.totalAmount, 0);
      const walletRevenue = sales
        .filter(s => s.paymentMethod === 'keshless_wallet')
        .reduce((sum, sale) => sum + sale.totalAmount, 0);

      const soldTickets = tickets.filter(t => t.status === 'sold' || t.status === 'checked_in').length;
      const checkedInTickets = tickets.filter(t => t.status === 'checked_in').length;
      const refundedTickets = tickets.filter(t => t.status === 'refunded').length;

      const successfulScans = scans.filter(s => s.isValid).length;
      const failedScans = scans.filter(s => !s.isValid).length;

      // Generate summary CSV
      const data = [
        ['Event Summary'],
        [''],
        ['Event Name', event.name],
        ['Venue', event.venue],
        ['Event Date', new Date(event.eventDate).toLocaleDateString()],
        ['Status', event.status],
        [''],
        ['Revenue Summary'],
        ['Total Revenue', totalRevenue.toFixed(2)],
        ['Cash Revenue', cashRevenue.toFixed(2)],
        ['Wallet Revenue', walletRevenue.toFixed(2)],
        [''],
        ['Ticket Summary'],
        ['Total Tickets', event.capacity.toString()],
        ['Tickets Sold', soldTickets.toString()],
        ['Tickets Checked In', checkedInTickets.toString()],
        ['Tickets Refunded', refundedTickets.toString()],
        [''],
        ['Scan Summary'],
        ['Total Scans', scans.length.toString()],
        ['Successful Scans', successfulScans.toString()],
        ['Failed Scans', failedScans.toString()],
        [''],
        ['Ticket Types'],
        ['Type', 'Price', 'Quantity', 'Sold', 'Available', 'Revenue']
      ];

      // Add ticket type details
      event.ticketTypes.forEach(tt => {
        const revenue = tt.sold * tt.price;
        data.push([
          tt.name,
          tt.price.toFixed(2),
          tt.quantity.toString(),
          tt.sold.toString(),
          tt.available.toString(),
          revenue.toFixed(2)
        ]);
      });

      return this.arrayToCSV(data);
    } catch (error: any) {
      console.error('Export event summary to CSV error:', error);
      throw new Error(error.message || 'Failed to export event summary');
    }
  }

  /**
   * Helper: Convert 2D array to CSV string
   */
  private static arrayToCSV(data: any[][]): string {
    return data
      .map(row =>
        row
          .map(cell => {
            const cellStr = String(cell || '');
            // Escape quotes and wrap in quotes if contains comma, quote, or newline
            if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
              return `"${cellStr.replace(/"/g, '""')}"`;
            }
            return cellStr;
          })
          .join(',')
      )
      .join('\n');
  }

  /**
   * Helper: Get CSV filename
   */
  static getFilename(type: string, eventName?: string): string {
    const timestamp = new Date().toISOString().split('T')[0];
    const prefix = eventName ? `${eventName.replace(/[^a-z0-9]/gi, '_')}_` : '';
    return `${prefix}${type}_${timestamp}.csv`;
  }
}
