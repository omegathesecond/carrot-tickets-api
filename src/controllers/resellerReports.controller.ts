import { NextFunction, Request, Response } from 'express';
import { ResellerReportsService } from '@services/resellerReports.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

export class ResellerReportsController {
  static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const from = req.query['from'] ? new Date(String(req.query['from'])) : new Date(0);
      const to = req.query['to'] ? new Date(String(req.query['to'])) : new Date();
      if (actor.role === 'reseller_hub_manager' && !actor.hubId) {
        res.status(400).json({ message: 'Hub manager token is missing hubId' });
        return;
      }
      const report =
        actor.role === 'reseller_hub_manager'
          ? await ResellerReportsService.forHub(actor.hubId, from, to)
          : await ResellerReportsService.forReseller(actor.resellerId, from, to);
      ApiResponseUtil.success(res, report);
    } catch (err) {
      next(err);
    }
  }
}
