import { Request, Response } from 'express';
import { Ticket } from '@models/ticket.model';
import { ITicket } from '@interfaces/ticket.interface';
import { TicketPdfService } from '@services/ticketPdf.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { buyerTicketOr } from '@utils/ticketHolder.util';

const EVENT_POPULATE_FIELDS = 'name venue eventDate startTime endTime posterUrl';
// Guards a pathological request (e.g. a hand-crafted body) from asking for an
// unbounded number of pages in one PDF.
const MAX_BUNDLE_TICKETS = 100;

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'tickets';
}

function sendPdf(res: Response, buffer: Buffer, filename: string): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

/**
 * Ticket-PDF download endpoints behind My Profile > Tickets on the website.
 * Buyer-owned only: a ticket (or every ticket in a bundle request) must
 * belong to the signed-in buyer (matched by buyerId/phone/email, the same
 * `buyerTicketOr` used by /my-tickets) — otherwise one buyer could download
 * another's QR code.
 */
export class TicketPdfController {
  /** GET /api/public/tickets/:ticketId/pdf — one ticket as a downloadable PDF. */
  static async downloadTicketPdf(req: Request, res: Response): Promise<any> {
    try {
      const ticketId = req.params['ticketId'];
      if (!ticketId) {
        return ApiResponseUtil.badRequest(res, 'Ticket id is required');
      }

      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to download your ticket');
      }

      const ticket = await Ticket.findOne({ ticketId, $or: buyerTicketOr(buyer) })
        .populate('eventId', EVENT_POPULATE_FIELDS);
      if (!ticket) {
        return ApiResponseUtil.notFound(res, 'Ticket not found');
      }

      const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket);
      sendPdf(res, buffer, `${sanitizeFilenamePart(ticket.ticketId)}.pdf`);
    } catch (error: any) {
      console.error('Download ticket PDF error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to generate ticket PDF');
    }
  }

  /** POST /api/public/tickets/pdf-bundle — several tickets as ONE downloadable PDF. */
  static async downloadTicketsBundle(req: Request, res: Response): Promise<any> {
    try {
      const ticketIds: unknown = req.body?.ticketIds;
      if (!Array.isArray(ticketIds) || ticketIds.length === 0 || !ticketIds.every((id) => typeof id === 'string')) {
        return ApiResponseUtil.badRequest(res, 'ticketIds must be a non-empty array of ticket ids');
      }
      if (ticketIds.length > MAX_BUNDLE_TICKETS) {
        return ApiResponseUtil.badRequest(res, `Cannot bundle more than ${MAX_BUNDLE_TICKETS} tickets at once`);
      }

      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to download your tickets');
      }

      const tickets = await Ticket.find({ ticketId: { $in: ticketIds }, $or: buyerTicketOr(buyer) })
        .populate('eventId', EVENT_POPULATE_FIELDS);

      // Every requested id must resolve to a ticket the buyer owns — a
      // partial match likely means a stale list or another buyer's ticket
      // snuck into the request, so fail loudly rather than silently drop it.
      if (tickets.length !== ticketIds.length) {
        return ApiResponseUtil.notFound(res, 'One or more tickets were not found');
      }

      // Preserve the order the caller asked for.
      const byId = new Map(tickets.map((t) => [t.ticketId, t]));
      const ordered: ITicket[] = ticketIds.map((id) => byId.get(id)!);

      const buffer = await TicketPdfService.buildBundlePdfBuffer(ordered);
      const firstEvent: any = ordered[0]?.eventId;
      const sameEvent = ordered.every((t: any) => t.eventId?._id?.toString?.() === firstEvent?._id?.toString?.());
      const filenameBase = sameEvent && firstEvent?.name ? firstEvent.name : 'carrot-tickets';
      sendPdf(res, buffer, `${sanitizeFilenamePart(filenameBase)}-tickets.pdf`);
    } catch (error: any) {
      console.error('Download tickets bundle error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to generate tickets PDF');
    }
  }
}
