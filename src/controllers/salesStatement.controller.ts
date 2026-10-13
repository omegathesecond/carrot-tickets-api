import { NextFunction, Request, Response } from 'express';
import { Merchant } from '@models/merchant.model';
import { ExportService } from '@services/export.service';
import { loadOwnedEvent } from '@controllers/merchantAdmin.controller';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { HEX24 } from '@utils/controllerHelpers.util';

export class SalesStatementController {
  private static format(req: Request, res: Response): 'csv' | 'pdf' | null {
    if (req.query.format === undefined || req.query.format === 'csv') return 'csv';
    if (req.query.format === 'pdf') return 'pdf';
    ApiResponseUtil.badRequest(res, 'format must be csv or pdf');
    return null;
  }

  static async event(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const format = SalesStatementController.format(req, res);
      if (!format) return;
      const eventId = String(req.params.eventId);
      if (!HEX24.test(eventId)) { ApiResponseUtil.badRequest(res, 'Invalid event ID'); return; }
      const event = await loadOwnedEvent(req, res, eventId);
      if (!event) return;
      const statement = await (format === 'pdf' ? ExportService.exportSalesStatementPdf.bind(ExportService) : ExportService.exportSalesToCSV.bind(ExportService))(
        { vendorId: String(event.vendorId), eventId },
        { eventName: event.name, currency: event.currency },
      );
      res.type(format === 'pdf' ? 'application/pdf' : 'text/csv').attachment(ExportService.getFilename('ticket_sales_statement', event.name).replace(/\.csv$/, `.${format}`)).send(statement);
    } catch (error) { next(error); }
  }

  static async merchant(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const format = SalesStatementController.format(req, res);
      if (!format) return;
      const id = String(req.params.id);
      if (!HEX24.test(id)) { ApiResponseUtil.badRequest(res, 'Invalid vendor ID'); return; }
      const merchant = await Merchant.findById(id).lean();
      if (!merchant) { ApiResponseUtil.notFound(res, 'Vendor not found'); return; }
      const event = await loadOwnedEvent(req, res, String(merchant.eventId));
      if (!event) return;
      const statement = await (format === 'pdf' ? ExportService.exportMerchantStatementPdf.bind(ExportService) : ExportService.exportMerchantStatementToCSV.bind(ExportService))(id, merchant.name, event.name, event.currency);
      res.type(format === 'pdf' ? 'application/pdf' : 'text/csv').attachment(ExportService.getFilename('sales_statement', merchant.name).replace(/\.csv$/, `.${format}`)).send(statement);
    } catch (error) { next(error); }
  }
}
