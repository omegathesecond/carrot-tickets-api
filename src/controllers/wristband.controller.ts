import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { WristbandDesign } from '@models/wristbandDesign.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { TicketService } from '@services/ticket.service';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { SalesChannel, TicketStatus } from '@interfaces/ticket.interface';

/**
 * Wristband printing admin API — saved designs for the dashboard's Tyvek
 * wristband editor. Platform-staff-only; every route is gated by
 * requireSuperAdminOrPermission(PRINT_WRISTBANDS) in tickets.route.ts, and
 * intentionally NOT vendor-scoped (it's the Carrot office printer + stock).
 */
export class WristbandController {
  /** GET /api/tickets/wristband-designs?eventId= */
  static async listDesigns(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.query['eventId'] ?? '');
      if (!mongoose.isValidObjectId(eventId)) {
        return ApiResponseUtil.validationError(res, 'eventId is required');
      }
      const designs = await WristbandDesign.find({ eventId }).sort({ updatedAt: -1 }).lean();
      return ApiResponseUtil.success(res, designs);
    } catch (error: any) {
      return ApiResponseUtil.serverError(res, error.message);
    }
  }

  /** POST /api/tickets/wristband-designs */
  static async createDesign(req: Request, res: Response): Promise<any> {
    try {
      const { eventId, name, sheetTemplate, designJson } = req.body;
      if (!mongoose.isValidObjectId(eventId)) {
        return ApiResponseUtil.validationError(res, 'eventId is required');
      }
      if (!name || typeof name !== 'string') {
        return ApiResponseUtil.validationError(res, 'name is required');
      }
      if (!sheetTemplate || typeof sheetTemplate !== 'object') {
        return ApiResponseUtil.validationError(res, 'sheetTemplate is required');
      }
      if (!designJson || typeof designJson !== 'object') {
        return ApiResponseUtil.validationError(res, 'designJson is required');
      }
      const ticketsUser = (req as any).ticketsUser;
      const design = await WristbandDesign.create({
        eventId, name, sheetTemplate, designJson,
        ...(ticketsUser?.vendorId ? { createdBy: ticketsUser.vendorId } : {}),
      });
      return ApiResponseUtil.created(res, design);
    } catch (error: any) {
      return ApiResponseUtil.serverError(res, error.message);
    }
  }

  /** PUT /api/tickets/wristband-designs/:id — partial update of name/template/scene. */
  static async updateDesign(req: Request, res: Response): Promise<any> {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) return ApiResponseUtil.notFound(res, 'Design not found');
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'sheetTemplate', 'designJson'] as const) {
        if (req.body[k] !== undefined) patch[k] = req.body[k];
      }
      const design = await WristbandDesign.findByIdAndUpdate(id, patch, { new: true, runValidators: true });
      if (!design) return ApiResponseUtil.notFound(res, 'Design not found');
      return ApiResponseUtil.success(res, design);
    } catch (error: any) {
      return ApiResponseUtil.serverError(res, error.message);
    }
  }

  /** DELETE /api/tickets/wristband-designs/:id — never touches tickets. */
  static async deleteDesign(req: Request, res: Response): Promise<any> {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) return ApiResponseUtil.notFound(res, 'Design not found');
      const design = await WristbandDesign.findByIdAndDelete(id);
      if (!design) return ApiResponseUtil.notFound(res, 'Design not found');
      return ApiResponseUtil.success(res, { deleted: true });
    } catch (error: any) {
      return ApiResponseUtil.serverError(res, error.message);
    }
  }

  /** POST /api/tickets/wristbands/batch-issue { eventId, ticketTypeId, quantity } */
  static async batchIssue(req: Request, res: Response): Promise<any> {
    try {
      const { eventId, ticketTypeId, quantity } = req.body;
      if (!mongoose.isValidObjectId(eventId)) {
        return ApiResponseUtil.validationError(res, 'eventId is required');
      }
      if (!ticketTypeId) {
        return ApiResponseUtil.validationError(res, 'ticketTypeId is required');
      }
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 500) {
        return ApiResponseUtil.validationError(res, 'quantity must be an integer between 1 and 500');
      }
      const ticketsUser = (req as any).ticketsUser;
      const { sale, tickets } = await TicketService.issueWristbandBatch({
        eventId, ticketTypeId, quantity: qty,
        ...(ticketsUser?.vendorId ? { issuedBy: ticketsUser.vendorId } : {}),
      });
      return ApiResponseUtil.created(res, {
        sale,
        tickets: tickets.map((t) => ({ ticketId: t.ticketId, ticketType: t.ticketType })),
      });
    } catch (error: any) {
      // Availability/oversell and validation problems are caller errors, not 500s.
      return ApiResponseUtil.badRequest(res, error.message);
    }
  }

  /** GET /api/tickets/wristbands/batches?eventId= — recent batches, reprintable. */
  static async listBatches(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.query['eventId'] ?? '');
      if (!mongoose.isValidObjectId(eventId)) {
        return ApiResponseUtil.validationError(res, 'eventId is required');
      }
      const sales = await TicketSale.find({ eventId, channel: SalesChannel.WRISTBAND })
        .sort({ soldAt: -1 })
        .limit(50)
        .populate('ticketIds', 'ticketId status ticketType')
        .lean();
      const data = sales.map((s: any) => ({
        _id: s._id,
        saleId: s.saleId,
        quantity: s.quantity,
        soldAt: s.soldAt,
        ticketType: s.ticketIds?.[0]?.ticketType ?? '',
        tickets: (s.ticketIds ?? []).map((t: any) => ({ ticketId: t.ticketId, status: t.status })),
      }));
      return ApiResponseUtil.success(res, data);
    } catch (error: any) {
      return ApiResponseUtil.serverError(res, error.message);
    }
  }

  /**
   * GET /api/tickets/wristbands/tickets?eventId=&search=
   * Existing-ticket picker for "print QRs of sold tickets" mode. Only tickets
   * that can still be worn matter: sold + checked_in (the UI warns on the
   * latter). Excludes refunded/cancelled.
   */
  static async searchTickets(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.query['eventId'] ?? '');
      if (!mongoose.isValidObjectId(eventId)) {
        return ApiResponseUtil.validationError(res, 'eventId is required');
      }
      const search = String(req.query['search'] ?? '').trim();
      const filter: Record<string, unknown> = {
        eventId,
        status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] },
      };
      if (search) {
        const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter['$or'] = [{ ticketId: rx }, { customerName: rx }, { customerPhone: rx }];
      }
      const tickets = await Ticket.find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .select('ticketId ticketType customerName customerPhone status')
        .lean();
      return ApiResponseUtil.success(res, tickets);
    } catch (error: any) {
      return ApiResponseUtil.serverError(res, error.message);
    }
  }
}
