// api/src/services/gateOperatorActivity.service.ts
import mongoose from 'mongoose';
import { TicketScan } from '@models/ticketScan.model';
import { BandBinding } from '@models/bandBinding.model';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { Wallet } from '@models/wallet.model';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

export interface OperatorScanRow {
  id: string;
  at: Date;
  eventId: string;
  eventName: string;
  result: string;
  isValid: boolean;
  ticketCode: string | null;
  holderName: string | null;
}

export interface OperatorEventBreakdown {
  eventId: string;
  eventName: string;
  scans: number;
  admitted: number;
  refused: number;
  lastScanAt: Date | null;
}

/**
 * What one gate operator actually DID — the scans they took and the tags they
 * registered, so an organizer can tell a hard-working gate from an idle one
 * rather than guessing from a headcount at the end of the night.
 *
 * Read-only and derived: TicketScan is the durable record of every scan
 * (including the refused ones, which is precisely the interesting half), and
 * BandBinding records who bound each tag. Nothing here is stored or cached.
 */
export class GateOperatorActivityService {
  static async forOperator(params: { operatorId: string; eventId?: string; limit?: number }) {
    const operatorId = oid(params.operatorId);
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const scanMatch: Record<string, unknown> = {
      scannedBy: operatorId,
      scannedByType: 'GateOperator',
      ...(params.eventId ? { eventId: oid(params.eventId) } : {}),
    };

    const [totals, byEvent, recent, tagsRegistered] = await Promise.all([
      TicketScan.aggregate([
        { $match: scanMatch },
        {
          $group: {
            _id: null,
            scans: { $sum: 1 },
            admitted: { $sum: { $cond: ['$isValid', 1, 0] } },
            firstScanAt: { $min: '$scannedAt' },
            lastScanAt: { $max: '$scannedAt' },
          },
        },
      ]),
      TicketScan.aggregate([
        { $match: scanMatch },
        {
          $group: {
            _id: '$eventId',
            scans: { $sum: 1 },
            admitted: { $sum: { $cond: ['$isValid', 1, 0] } },
            lastScanAt: { $max: '$scannedAt' },
          },
        },
        { $sort: { lastScanAt: -1 } },
      ]),
      TicketScan.find(scanMatch).sort({ scannedAt: -1 }).limit(limit).lean(),
      // boundBy is the operator id as a STRING (the token's userId), not an
      // ObjectId — matching on the ObjectId would silently count zero.
      BandBinding.countDocuments({
        boundBy: String(params.operatorId),
        ...(params.eventId ? { eventId: oid(params.eventId) } : {}),
      }),
    ]);

    // Names for just the events and tickets on this page — one look-up each,
    // regardless of row count.
    const eventIds = [
      ...new Set([
        ...byEvent.map((e: any) => String(e._id)),
        ...recent.map((s: any) => String(s.eventId)),
      ]),
    ].filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
    const [events, tickets] = await Promise.all([
      Event.find({ _id: { $in: eventIds.map(oid) } }).select('name').lean(),
      Ticket.find({ _id: { $in: recent.map((s: any) => s.ticketId).filter(Boolean) } })
        .select('ticketId customerName')
        .lean(),
    ]);
    const eventName = new Map(events.map((e: any) => [String(e._id), e.name as string]));
    const ticketById = new Map(tickets.map((t: any) => [String(t._id), t]));

    const t = totals[0];
    const scans: number = t?.scans ?? 0;
    const admitted: number = t?.admitted ?? 0;

    return {
      summary: {
        scans,
        admitted,
        // Everything the scanner turned away — duplicates, wrong event,
        // cancelled. Counted as the complement of admitted so the two always
        // add up to the total, whatever new scanResult values appear later.
        refused: scans - admitted,
        tagsRegistered,
        firstScanAt: (t?.firstScanAt ?? null) as Date | null,
        lastScanAt: (t?.lastScanAt ?? null) as Date | null,
      },
      byEvent: byEvent.map((e: any): OperatorEventBreakdown => ({
        eventId: String(e._id),
        eventName: eventName.get(String(e._id)) || 'Unknown event',
        scans: e.scans,
        admitted: e.admitted,
        refused: e.scans - e.admitted,
        lastScanAt: e.lastScanAt ?? null,
      })),
      recent: recent.map((s: any): OperatorScanRow => {
        const ticket = ticketById.get(String(s.ticketId));
        return {
          id: String(s._id),
          at: s.scannedAt,
          eventId: String(s.eventId),
          eventName: eventName.get(String(s.eventId)) || 'Unknown event',
          result: s.scanResult,
          isValid: !!s.isValid,
          ticketCode: ticket?.ticketId ?? null,
          holderName: ticket?.customerName ?? null,
        };
      }),
    };
  }

  /**
   * The tags an operator registered, newest first — the register desk's own
   * work log. Joined to the wallet so the organizer can see what is on each
   * tag now, not just that it was handed out.
   */
  static async registrationsBy(params: { operatorId: string; eventId?: string; limit?: number }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const bindings = await BandBinding.find({
      boundBy: String(params.operatorId),
      ...(params.eventId ? { eventId: oid(params.eventId) } : {}),
    })
      .sort({ boundAt: -1 })
      .limit(limit)
      .lean();

    const wallets = await Wallet.find({ _id: { $in: bindings.map((b: any) => b.walletId) } })
      .select('balance ticketId')
      .lean();
    const walletById = new Map(wallets.map((w: any) => [String(w._id), w]));
    const tickets = await Ticket.find({ _id: { $in: wallets.map((w: any) => w.ticketId) } })
      .select('ticketId customerName')
      .lean();
    const ticketById = new Map(tickets.map((t: any) => [String(t._id), t]));

    return bindings.map((b: any) => {
      const wallet = walletById.get(String(b.walletId));
      const ticket = wallet ? ticketById.get(String(wallet.ticketId)) : undefined;
      return {
        bandUid: b.bandUid,
        walletId: String(b.walletId),
        at: b.boundAt,
        releasedAt: b.unboundAt ?? null,
        balance: wallet?.balance ?? 0,
        holderName: ticket?.customerName ?? null,
        ticketCode: ticket?.ticketId ?? null,
      };
    });
  }
}
