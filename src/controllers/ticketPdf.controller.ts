import { Request, Response } from 'express';
import { TicketPdfService } from '@services/ticketPdf.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { TicketPdfStatus } from '@interfaces/ticket.interface';
import { normalizePhone } from '@utils/phone.util';

/**
 * Shareable ticket-PDF endpoint, used by every Keshless surface:
 *  - user-app  : proxied with a Keshless user JWT → service auth attaches
 *                req.ticketsUser.userPhone (must match the ticket's phone)
 *  - website   : buyer token → req.ticketsUser.userPhone
 *  - dashboard : vendor JWT → req.ticketsUser.vendorId (must own the ticket,
 *                or be a super-admin)
 *
 * Response envelope (data):
 *   { status: 'ready',      pdfUrl }  (200) — share/download this URL
 *   { status: 'generating' }          (202) — poll again shortly
 */
export class TicketPdfController {
  static async getTicketPdf(req: Request, res: Response): Promise<any> {
    try {
      const idOrCode = req.params['ticketId'];
      if (!idOrCode) {
        return ApiResponseUtil.badRequest(res, 'Ticket id is required');
      }

      const ticket = await TicketPdfService.resolveTicket(idOrCode);
      if (!ticket) {
        return ApiResponseUtil.notFound(res, 'Ticket not found');
      }

      const tu = (req as any).ticketsUser || {};
      const requesterPhone = tu.userPhone as string | undefined;
      const vendorId = tu.vendorId as string | undefined;
      const isSuperAdmin = Boolean(tu.isSuperAdmin);

      const ownsByPhone = Boolean(
        requesterPhone &&
          ticket.customerPhone &&
          normalizePhone(requesterPhone) === normalizePhone(ticket.customerPhone)
      );
      const ownsByVendor = Boolean(
        isSuperAdmin || (vendorId && ticket.vendorId?.toString() === vendorId)
      );

      if (!ownsByPhone && !ownsByVendor) {
        return ApiResponseUtil.forbidden(res, 'You are not allowed to access this ticket');
      }

      const result = await TicketPdfService.ensureTicketPdf(ticket);

      if (result.status === TicketPdfStatus.READY) {
        return ApiResponseUtil.success(res, result, 'Ticket PDF ready');
      }
      // Still rendering (a concurrent request claimed generation) — tell the
      // client to poll.
      return ApiResponseUtil.success(res, result, 'Ticket PDF is being generated', 202);
    } catch (error: any) {
      console.error('Get ticket PDF error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to generate ticket PDF');
    }
  }
}
