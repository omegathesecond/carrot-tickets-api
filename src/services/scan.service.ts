import { Ticket } from '@models/ticket.model';
import { TicketScan } from '@models/ticketScan.model';
import { Event } from '@models/event.model';
import { ITicket, ITicketScan, TicketStatus } from '@interfaces/ticket.interface';
import mongoose from 'mongoose';

export interface ValidateTicketParams {
  ticketId: string;
  vendorId: string;
  scannedBy: string;
  scannedByType: 'vendor' | 'sub-user';
}

export interface CheckInTicketParams {
  ticketId: string;
  vendorId: string;
  scannedBy: string;
  scannedByType: 'vendor' | 'sub-user';
  notes?: string;
}

export interface GetScansQuery {
  vendorId: string;
  eventId?: string;
  status?: 'success' | 'failed' | 'already_scanned';
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
  isSuperAdmin?: boolean;
}

export interface ScanResult {
  valid: boolean;
  ticket?: ITicket;
  event?: any;
  ticketType?: any;
  // Present only for check-ins, which persist an audit record. Validation is a
  // read-only preview and writes nothing, so it returns no scan.
  scan?: ITicketScan;
  message: string;
}

export class ScanService {
  /**
   * Validate a ticket WITHOUT checking it in.
   *
   * This is a read-only preview shown before the operator confirms entry — it
   * does NOT persist a scan record. (It used to write one on every call, so a
   * single entry produced two rows in "Recent Scans": one for the validate and
   * one for the subsequent check-in. Only check-in persists now.)
   */
  static async validateTicket(params: ValidateTicketParams): Promise<ScanResult> {
    try {
      const { ticketId, vendorId } = params;

      const ticket = await Ticket.findOne({ ticketId }).populate('eventId');

      if (!ticket) {
        return { valid: false, message: 'Ticket not found' };
      }

      // Resolve the populated event + the matching ticket-type so the UI can
      // show "Event" and "Type" on the validation preview.
      const event = ticket.eventId && typeof ticket.eventId === 'object' ? ticket.eventId : undefined;
      const ticketType = (event as any)?.ticketTypes?.find?.(
        (tt: any) => tt.name === ticket.ticketType
      );

      if (ticket.vendorId.toString() !== vendorId) {
        return { valid: false, ticket, event, ticketType, message: 'Ticket belongs to different vendor' };
      }

      if (ticket.status === TicketStatus.REFUNDED) {
        return { valid: false, ticket, event, ticketType, message: 'Ticket has been refunded' };
      }

      if (ticket.status === TicketStatus.CHECKED_IN) {
        return {
          valid: false,
          ticket,
          event,
          ticketType,
          message: `Ticket already checked in at ${ticket.checkedInAt?.toLocaleString()}`
        };
      }

      if (ticket.status !== TicketStatus.SOLD) {
        return { valid: false, ticket, event, ticketType, message: `Ticket status is ${ticket.status}` };
      }

      return {
        valid: true,
        ticket,
        event,
        ticketType,
        message: 'Ticket is valid for check-in'
      };
    } catch (error: any) {
      console.error('Validate ticket error:', error);
      throw new Error(error.message || 'Failed to validate ticket');
    }
  }

  /**
   * Check-in ticket (mark as used)
   */
  static async checkInTicket(params: CheckInTicketParams): Promise<ScanResult> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { ticketId, vendorId, scannedBy, scannedByType, notes } = params;

      // Find ticket
      const ticket = await Ticket.findOne({ ticketId })
        .populate('eventId')
        .session(session);

      // Validate ticket existence
      if (!ticket) {
        await session.abortTransaction();
        session.endSession();

        const scan = await this.createScanRecord({
          ticketId: undefined,
          eventId: undefined,
          vendorId,
          scannedBy,
          scannedByType,
          isValid: false,
          scanResult: 'invalid_ticket',
          notes
        });

        return {
          valid: false,
          scan,
          message: 'Ticket not found'
        };
      }

      // Check vendor ownership
      if (ticket.vendorId.toString() !== vendorId) {
        await session.abortTransaction();
        session.endSession();

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId,
          scannedBy,
          scannedByType,
          isValid: false,
          scanResult: 'wrong_event',
          notes
        });

        return {
          valid: false,
          ticket,
          scan,
          message: 'Ticket belongs to different vendor'
        };
      }

      // Check if ticket is cancelled/refunded
      if (ticket.status === TicketStatus.REFUNDED) {
        await session.abortTransaction();
        session.endSession();

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId,
          scannedBy,
          scannedByType,
          isValid: false,
          scanResult: 'cancelled',
          notes
        });

        return {
          valid: false,
          ticket,
          scan,
          message: 'Ticket has been refunded'
        };
      }

      // Check if already checked in
      if (ticket.status === TicketStatus.CHECKED_IN) {
        await session.abortTransaction();
        session.endSession();

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId,
          scannedBy,
          scannedByType,
          isValid: false,
          scanResult: 'already_scanned',
          notes
        });

        return {
          valid: false,
          ticket,
          scan,
          message: `Ticket already checked in at ${ticket.checkedInAt?.toLocaleString()}`
        };
      }

      // Check if ticket is sold
      if (ticket.status !== TicketStatus.SOLD) {
        await session.abortTransaction();
        session.endSession();

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId,
          scannedBy,
          scannedByType,
          isValid: false,
          scanResult: 'invalid_ticket',
          notes
        });

        return {
          valid: false,
          ticket,
          scan,
          message: `Ticket status is ${ticket.status}`
        };
      }

      // Check-in ticket
      ticket.status = TicketStatus.CHECKED_IN;
      ticket.checkedInAt = new Date();
      ticket.checkedInBy = scannedBy as any;
      ticket.checkedInByModel = scannedByType === 'vendor' ? 'Vendor' : 'VendorSubUser';
      await ticket.save({ session });

      // Create success scan record
      const scan = await this.createScanRecord({
        ticketId: ticket._id,
        eventId: ticket.eventId,
        vendorId,
        scannedBy,
        scannedByType,
        isValid: true,
        scanResult: 'success',
        notes
      });

      await session.commitTransaction();
      session.endSession();

      return {
        valid: true,
        ticket,
        scan,
        message: 'Ticket checked in successfully'
      };
    } catch (error: any) {
      await session.abortTransaction();
      session.endSession();
      console.error('Check-in ticket error:', error);
      throw new Error(error.message || 'Failed to check in ticket');
    }
  }

  /**
   * Get scans with filters and pagination
   */
  static async getScans(query: GetScansQuery) {
    try {
      const {
        vendorId,
        eventId,
        status,
        startDate,
        endDate,
        page = 1,
        limit = 20,
        isSuperAdmin = false
      } = query;

      // Build query — superadmins see scans across every vendor's events.
      const filter: any = {};
      if (!isSuperAdmin) filter.vendorId = vendorId;

      if (eventId) filter.eventId = eventId;
      if (status) filter.scanResult = status;

      if (startDate || endDate) {
        filter.scannedAt = {};
        if (startDate) filter.scannedAt.$gte = startDate;
        if (endDate) filter.scannedAt.$lte = endDate;
      }

      // Execute query with pagination
      const skip = (page - 1) * limit;
      const [scans, total] = await Promise.all([
        TicketScan.find(filter)
          .populate('ticketId')
          .populate('eventId', 'name venue eventDate')
          .populate('scannedBy')
          .sort({ scannedAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        TicketScan.countDocuments(filter)
      ]);

      return {
        // Reshape for the dashboard: expose the populated event as `event` (so
        // "Event: N/A" stops showing), keep `eventId` a plain id, and map the
        // internal `scanResult` onto the `status` the table renders.
        data: scans.map((scan: any) => {
          const populated = scan.eventId;
          const hasEvent = populated && typeof populated === 'object' && populated._id;
          return {
            ...scan,
            event: hasEvent ? populated : undefined,
            eventId: hasEvent ? populated._id : scan.eventId,
            status: scan.scanResult
          };
        }),
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      };
    } catch (error: any) {
      console.error('Get scans error:', error);
      throw new Error(error.message || 'Failed to fetch scans');
    }
  }

  /**
   * Get scan statistics for an event
   */
  static async getEventScanStats(eventId: string, vendorId: string): Promise<{
    totalScans: number;
    successfulScans: number;
    failedScans: number;
    alreadyScannedCount: number;
    invalidTicketCount: number;
    totalTicketsSold: number;
    totalCheckedIn: number;
    checkInPercentage: number;
  }> {
    try {
      // Get event
      const event = await Event.findOne({ _id: eventId, vendorId });
      if (!event) {
        throw new Error('Event not found');
      }

      // Get scan stats
      const [
        totalScans,
        successfulScans,
        alreadyScannedCount,
        invalidTicketCount,
        totalCheckedIn
      ] = await Promise.all([
        TicketScan.countDocuments({ eventId, vendorId }),
        TicketScan.countDocuments({ eventId, vendorId, scanResult: 'success' }),
        TicketScan.countDocuments({ eventId, vendorId, scanResult: 'already_scanned' }),
        TicketScan.countDocuments({ eventId, vendorId, scanResult: 'invalid_ticket' }),
        Ticket.countDocuments({ eventId, vendorId, status: TicketStatus.CHECKED_IN })
      ]);

      const failedScans = totalScans - successfulScans;
      const checkInPercentage = event.totalTicketsSold > 0
        ? (totalCheckedIn / event.totalTicketsSold) * 100
        : 0;

      return {
        totalScans,
        successfulScans,
        failedScans,
        alreadyScannedCount,
        invalidTicketCount,
        totalTicketsSold: event.totalTicketsSold,
        totalCheckedIn,
        checkInPercentage
      };
    } catch (error: any) {
      console.error('Get event scan stats error:', error);
      throw new Error(error.message || 'Failed to fetch scan statistics');
    }
  }

  /**
   * Create scan record
   */
  private static async createScanRecord(params: {
    ticketId: any;
    eventId: any;
    vendorId: string;
    scannedBy: string;
    scannedByType: 'vendor' | 'sub-user';
    isValid: boolean;
    scanResult: 'success' | 'already_scanned' | 'invalid_ticket' | 'wrong_event' | 'cancelled';
    notes?: string;
  }): Promise<ITicketScan> {
    const scanData: any = {
      vendorId: params.vendorId,
      scannedBy: params.scannedBy,
      scannedByType: params.scannedByType === 'vendor' ? 'Vendor' : 'VendorSubUser',
      isValid: params.isValid,
      scanResult: params.scanResult,
      notes: params.notes,
      scannedAt: new Date()
    };

    // Only add ticketId and eventId if they exist
    if (params.ticketId) scanData.ticketId = params.ticketId;
    if (params.eventId) scanData.eventId = params.eventId;

    const scan = new TicketScan(scanData);

    await scan.save();
    return scan;
  }
}
