import { Ticket } from '@models/ticket.model';
import { TicketScan } from '@models/ticketScan.model';
import { Event } from '@models/event.model';
import { ITicket, ITicketScan, TicketStatus } from '@interfaces/ticket.interface';
import { findTicketByCode } from '@utils/ticketLookup.util';
import { WalletService } from '@services/wallet.service';
import { Wallet, IWallet } from '@models/wallet.model';
import mongoose from 'mongoose';

export interface ValidateTicketParams {
  ticketId: string;
  vendorId: string;
  scannedBy: string;
  scannedByType: 'vendor' | 'sub-user' | 'gate-operator';
  isSuperAdmin?: boolean;
  // When set, the ticket must belong to this event or it is rejected as
  // "wrong event". Lets a gate operator lock scanning to a single show.
  expectedEventId?: string;
  // The operator's back-office event assignment. Unset (or empty) means
  // unrestricted. Unlike expectedEventId — which the DEVICE chooses and can
  // therefore change at will — this is resolved server-side from the operator
  // row, so it is the authoritative check.
  allowedEventIds?: string[];
}

export interface CheckInTicketParams {
  ticketId: string;
  vendorId: string;
  scannedBy: string;
  scannedByType: 'vendor' | 'sub-user' | 'gate-operator';
  isSuperAdmin?: boolean;
  notes?: string;
  expectedEventId?: string;
  /** See ValidateTicketParams.allowedEventIds. */
  allowedEventIds?: string[];
}

/** Extract a ticket's event id as a string, whether eventId is populated or raw. */
const eventIdOf = (ticket: any): string | undefined => {
  const e = ticket?.eventId;
  if (!e) return undefined;
  return (e._id ? e._id.toString() : e.toString());
};

/**
 * Whether an operator assigned to `allowedEventIds` may scan this ticket.
 *
 * Deliberately keyed off the TICKET's own event rather than the device's
 * expectedEventId: the device picks that value, so checking it would let any
 * operator work any of their organizer's shows just by choosing a different
 * one in the app.
 */
const isOutsideAssignment = (ticket: any, allowedEventIds?: string[]): boolean => {
  if (!allowedEventIds?.length) return false;
  const ticketEventId = eventIdOf(ticket);
  return !ticketEventId || !allowedEventIds.includes(ticketEventId);
};

const NOT_ASSIGNED_MESSAGE = 'You are not assigned to this event';

export interface GetScansQuery {
  vendorId: string;
  eventId?: string;
  status?: 'success' | 'failed' | 'already_scanned';
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
  isSuperAdmin?: boolean;
  /** The operator's event assignment; unset means unrestricted. */
  allowedEventIds?: string[];
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

const SCANNER_MODEL: Record<'vendor' | 'sub-user' | 'gate-operator', string> = {
  vendor: 'Vendor',
  'sub-user': 'VendorSubUser',
  'gate-operator': 'GateOperator',
};

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
      const { ticketId, vendorId, expectedEventId, allowedEventIds } = params;

      const ticket = await findTicketByCode(ticketId);
      if (ticket) await ticket.populate('eventId');

      if (!ticket) {
        return { valid: false, message: 'Ticket not found' };
      }

      // Resolve the populated event + the matching ticket-type so the UI can
      // show "Event" and "Type" on the validation preview.
      const event = ticket.eventId && typeof ticket.eventId === 'object' ? ticket.eventId : undefined;
      const ticketType = (event as any)?.ticketTypes?.find?.(
        (tt: any) => tt.name === ticket.ticketType
      );

      if (!params.isSuperAdmin && ticket.vendorId.toString() !== vendorId) {
        return { valid: false, ticket, event, ticketType, message: 'Ticket belongs to different vendor' };
      }

      // Assignment guard, checked BEFORE the device-selected show: an operator
      // restricted to specific events cannot preview a ticket outside them.
      if (isOutsideAssignment(ticket, allowedEventIds)) {
        return { valid: false, ticket, event, ticketType, message: NOT_ASSIGNED_MESSAGE };
      }

      // Gate guard: reject tickets for a different show than the one selected.
      if (expectedEventId && eventIdOf(ticket) !== expectedEventId) {
        return {
          valid: false,
          ticket,
          event,
          ticketType,
          message: `Wrong event — this ticket is for ${(event as any)?.name || 'another event'}`
        };
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
    return this._checkInTicketWithSession(params, true);
  }

  private static async _checkInTicketWithSession(
    params: CheckInTicketParams,
    useTransaction: boolean
  ): Promise<ScanResult> {
    let session: mongoose.ClientSession | null = null;

    if (useTransaction) {
      try {
        session = await mongoose.startSession();
        session.startTransaction();
      } catch {
        session = null;
      }
    }

    try {
      const { ticketId, vendorId, scannedBy, scannedByType, notes, expectedEventId, allowedEventIds } = params;

      // Find ticket
      const ticket = await findTicketByCode(ticketId, session ?? undefined);
      if (ticket) await ticket.populate('eventId');

      // Validate ticket existence
      if (!ticket) {
        if (session) { await session.abortTransaction(); session.endSession(); }

        let scan;
        if (vendorId) {
          scan = await this.createScanRecord({
            ticketId: undefined,
            eventId: undefined,
            vendorId,
            scannedBy,
            scannedByType,
            isValid: false,
            scanResult: 'invalid_ticket',
            notes
          });
        }

        return {
          valid: false,
          scan,
          message: 'Ticket not found'
        };
      }

      // Resolve the effective vendorId for scan attribution: super-admins have no
      // single vendor, so stamp from the ticket's organizer for history/stats.
      const scanVendorId = params.isSuperAdmin && ticket ? ticket.vendorId.toString() : vendorId;

      // Check vendor ownership
      if (!params.isSuperAdmin && ticket.vendorId.toString() !== vendorId) {
        if (session) { await session.abortTransaction(); session.endSession(); }

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

      // Assignment guard, checked BEFORE the device-selected show. Recorded
      // like any other wrong_event refusal so the gate keeps an audit trail of
      // someone trying to work a show they are not on.
      if (isOutsideAssignment(ticket, allowedEventIds)) {
        if (session) { await session.abortTransaction(); session.endSession(); }

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId: scanVendorId,
          scannedBy,
          scannedByType,
          isValid: false,
          scanResult: 'wrong_event',
          notes
        });

        return { valid: false, ticket, scan, message: NOT_ASSIGNED_MESSAGE };
      }

      // Gate guard: reject (and record) tickets for a different show.
      if (expectedEventId && eventIdOf(ticket) !== expectedEventId) {
        if (session) { await session.abortTransaction(); session.endSession(); }

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId: scanVendorId,
          scannedBy,
          scannedByType,
          isValid: false,
          scanResult: 'wrong_event',
          notes
        });

        const evName = (ticket.eventId as any)?.name;
        return {
          valid: false,
          ticket,
          scan,
          message: `Wrong event — this ticket is for ${evName || 'another event'}`
        };
      }

      // Check if ticket is cancelled/refunded
      if (ticket.status === TicketStatus.REFUNDED) {
        if (session) { await session.abortTransaction(); session.endSession(); }

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId: scanVendorId,
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
        if (session) { await session.abortTransaction(); session.endSession(); }

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId: scanVendorId,
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
        if (session) { await session.abortTransaction(); session.endSession(); }

        const scan = await this.createScanRecord({
          ticketId: ticket._id,
          eventId: ticket.eventId,
          vendorId: scanVendorId,
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
      ticket.checkedInByModel = SCANNER_MODEL[scannedByType];
      await ticket.save(session ? { session } : undefined);

      // Create success scan record
      const scan = await this.createScanRecord({
        ticketId: ticket._id,
        eventId: ticket.eventId,
        vendorId: scanVendorId,
        scannedBy,
        scannedByType,
        isValid: true,
        scanResult: 'success',
        notes
      });

      if (session) { await session.commitTransaction(); session.endSession(); }

      return {
        valid: true,
        ticket,
        scan,
        message: 'Ticket checked in successfully'
      };
    } catch (error: any) {
      // On standalone MongoDB (test env) transactions aren't supported — retry without one.
      if (
        useTransaction &&
        (error.message?.includes('Transaction numbers are only allowed on a replica set') ||
          error.message?.includes('transactions are not supported'))
      ) {
        if (session) { try { await session.abortTransaction(); } catch { /* ignore */ } session.endSession(); }
        return this._checkInTicketWithSession(params, false);
      }
      if (session) { await session.abortTransaction(); session.endSession(); }
      console.error('Check-in ticket error:', error);
      throw new Error(error.message || 'Failed to check in ticket');
    }
  }

  // A band may be bound only to a ticket that is SOLD or already CHECKED_IN.
  // AVAILABLE (not sold), REFUNDED, CANCELLED must never get a spendable band.
  private static readonly BAND_ELIGIBLE = new Set<TicketStatus>([
    TicketStatus.SOLD,
    TicketStatus.CHECKED_IN,
  ]);

  /**
   * Bind a blank NFC band to the wallet of a scanned ticket (cashless spec
   * §5.1). This is a DEDICATED band-desk action, independent of turnstile
   * check-in: it never flips `ticket.status`, so binding a band cannot throw
   * an "already checked in" error, and a re-tap to fix a mis-scan is safe.
   */
  static async bindBandToTicket(params: {
    ticketId: string;
    bandUid: string;
    vendorId: string;
    isSuperAdmin?: boolean;
    expectedEventId?: string;
    /** The operator's event assignment; unset means unrestricted. */
    allowedEventIds?: string[];
    boundBy?: string;
  }): Promise<{ ticket: ITicket; wallet: IWallet }> {
    const ticket = await findTicketByCode(params.ticketId);
    if (!ticket) throw new Error('Ticket not found');

    if (!params.isSuperAdmin && ticket.vendorId.toString() !== params.vendorId) {
      throw new Error('Ticket belongs to a different vendor');
    }

    if (isOutsideAssignment(ticket, params.allowedEventIds)) {
      throw new Error(NOT_ASSIGNED_MESSAGE);
    }

    if (params.expectedEventId && String(ticket.eventId) !== String(params.expectedEventId)) {
      throw new Error('This ticket is for a different event');
    }

    if (!ScanService.BAND_ELIGIBLE.has(ticket.status)) {
      throw new Error(`Ticket is ${ticket.status}, cannot bind a band`);
    }

    const wallet = await WalletService.ensureWalletForTicket({
      ticketId: String(ticket._id),
      eventId: String(ticket.eventId),
      ...(ticket.purchasedBy ? { buyerId: String(ticket.purchasedBy) } : {}),
    });

    const bound = await WalletService.bindBand(String(wallet._id), params.bandUid, params.boundBy);

    return { ticket, wallet: bound };
  }

  /**
   * Reissue a band for a ticket that lost its physical band (cashless spec
   * §5.1). Unbinds the old uid and binds the new one on the SAME wallet, so
   * the balance is untouched — that's the whole payoff of keeping the balance
   * on the wallet rather than the band. Mirrors bindBandToTicket's vendor
   * ownership + event-lock checks exactly.
   */
  static async reissueBandForTicket(params: {
    ticketId: string;
    newBandUid: string;
    reason: string;
    vendorId: string;
    isSuperAdmin?: boolean;
    expectedEventId?: string;
    /** The operator's event assignment; unset means unrestricted. */
    allowedEventIds?: string[];
    boundBy?: string;
  }): Promise<{ wallet: IWallet }> {
    const ticket = await findTicketByCode(params.ticketId);
    if (!ticket) throw new Error('Ticket not found');

    if (!params.isSuperAdmin && ticket.vendorId.toString() !== params.vendorId) {
      throw new Error('Ticket belongs to a different vendor');
    }

    if (isOutsideAssignment(ticket, params.allowedEventIds)) {
      throw new Error(NOT_ASSIGNED_MESSAGE);
    }

    if (params.expectedEventId && String(ticket.eventId) !== String(params.expectedEventId)) {
      throw new Error('This ticket is for a different event');
    }

    if (!ScanService.BAND_ELIGIBLE.has(ticket.status)) {
      throw new Error(`Ticket is ${ticket.status}, cannot bind a band`);
    }

    const wallet = await Wallet.findOne({ ticketId: ticket._id });
    if (!wallet) throw new Error('No wallet for this ticket');

    await WalletService.unbindBand(String(wallet._id), params.reason); // throws if no band bound
    const rebound = await WalletService.bindBand(String(wallet._id), params.newBandUid, params.boundBy);

    return { wallet: rebound };
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
        isSuperAdmin = false,
        allowedEventIds
      } = query;

      // Build query — superadmins see scans across every vendor's events.
      const filter: any = {};
      if (!isSuperAdmin) filter.vendorId = vendorId;

      // A restricted operator sees only their own shows' scans. Applied before
      // the eventId filter so an explicit ?eventId= outside the assignment
      // narrows to nothing rather than widening access.
      if (allowedEventIds?.length) filter.eventId = { $in: allowedEventIds };

      if (eventId) {
        if (allowedEventIds?.length && !allowedEventIds.includes(String(eventId))) {
          return { data: [], pagination: { total: 0, page, limit, pages: 0, hasNext: false, hasPrev: false } };
        }
        filter.eventId = eventId;
      }
      // A scan is "successful" only when scanResult === 'success' (isValid).
      // Everything else (invalid_ticket, wrong_event, cancelled, …) is a
      // "failed" scan. 'already_scanned' is a distinct, explicit bucket.
      if (status === 'success') filter.isValid = true;
      else if (status === 'failed') filter.isValid = false;
      else if (status === 'already_scanned') filter.scanResult = 'already_scanned';

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
        // "Event: N/A" stops showing), keep `eventId` a plain id, and surface a
        // normalized `status` (success | failed) the status filter/badge render.
        data: scans.map((scan: any) => {
          const populated = scan.eventId;
          const hasEvent = populated && typeof populated === 'object' && populated._id;
          return {
            ...scan,
            event: hasEvent ? populated : undefined,
            eventId: hasEvent ? populated._id : scan.eventId,
            status: scan.isValid ? 'success' : 'failed'
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
   * Get aggregate scan statistics for a vendor (optionally filtered by event
   * and/or date range). Powers the Entry Scan page analytics cards.
   */
  static async getScanStats(query: {
    vendorId: string;
    eventId?: string;
    startDate?: Date;
    endDate?: Date;
    isSuperAdmin?: boolean;
    /** The operator's event assignment; unset means unrestricted. */
    allowedEventIds?: string[];
  }): Promise<{
    totalScans: number;
    successfulScans: number;
    failedScans: number;
    alreadyScannedCount: number;
  }> {
    try {
      const { vendorId, eventId, startDate, endDate, isSuperAdmin = false, allowedEventIds } = query;

      // Match getScans: platform-scope (super-admin) operators have no single
      // vendor, so don't filter by vendorId — otherwise every count is 0 even
      // though their scans succeed and show up in history.
      const filter: any = {};
      if (!isSuperAdmin) filter.vendorId = vendorId;

      // A restricted operator's counts cover only their own shows.
      if (allowedEventIds?.length) filter.eventId = { $in: allowedEventIds };

      if (eventId) {
        if (allowedEventIds?.length && !allowedEventIds.includes(String(eventId))) {
          return { totalScans: 0, successfulScans: 0, failedScans: 0, alreadyScannedCount: 0 };
        }
        filter.eventId = eventId;
      }
      if (startDate || endDate) {
        filter.scannedAt = {};
        if (startDate) filter.scannedAt.$gte = startDate;
        if (endDate) filter.scannedAt.$lte = endDate;
      }

      const [totalScans, successfulScans, alreadyScannedCount] = await Promise.all([
        TicketScan.countDocuments(filter),
        TicketScan.countDocuments({ ...filter, scanResult: 'success' }),
        TicketScan.countDocuments({ ...filter, scanResult: 'already_scanned' })
      ]);

      return {
        totalScans,
        successfulScans,
        failedScans: totalScans - successfulScans,
        alreadyScannedCount
      };
    } catch (error: any) {
      console.error('Get scan stats error:', error);
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
    scannedByType: 'vendor' | 'sub-user' | 'gate-operator';
    isValid: boolean;
    scanResult: 'success' | 'already_scanned' | 'invalid_ticket' | 'wrong_event' | 'cancelled';
    notes?: string;
  }): Promise<ITicketScan> {
    const scanData: any = {
      vendorId: params.vendorId,
      scannedBy: params.scannedBy,
      scannedByType: SCANNER_MODEL[params.scannedByType],
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
