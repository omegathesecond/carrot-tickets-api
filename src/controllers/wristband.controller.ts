import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { WristbandDesign } from '@models/wristbandDesign.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';

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
}
