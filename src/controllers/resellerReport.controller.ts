import { Request, Response, NextFunction } from 'express';
import { ResellerReportService, ReportScope } from '@services/resellerReport.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

function parseDate(raw: unknown): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw as string);
  return isNaN(d.getTime()) ? undefined : d;
}

function scopeOf(req: Request): ReportScope {
  const actor = (req as any).reseller;
  return { resellerId: actor.resellerId, role: actor.role, hubId: actor.hubId };
}

export class ResellerReportController {
  /** GET /reseller/manager/sales — sale rows across the actor's scope. */
  static async listSales(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = parseInt(String(req.query['page'] ?? '1'), 10) || 1;
      const limit = parseInt(String(req.query['limit'] ?? '25'), 10) || 25;
      const { sales, total, page: p, limit: l } = await ResellerReportService.listSales({
        scope: scopeOf(req),
        page,
        limit,
        from: parseDate(req.query['from']),
        to: parseDate(req.query['to']),
        hubId: (req.query['hubId'] as string) || undefined,
        operatorId: (req.query['operatorId'] as string) || undefined,
        paymentMethod: (req.query['paymentMethod'] as string) || undefined,
      });
      ApiResponseUtil.success(res, {
        data: sales,
        pagination: {
          total,
          page: p,
          limit: l,
          pages: Math.ceil(total / l),
          hasNext: p * l < total,
          hasPrev: p > 1,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /** GET /reseller/reports/summary — aggregated metrics for the actor's scope. */
  static async summary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await ResellerReportService.summary({
        scope: scopeOf(req),
        from: parseDate(req.query['from']),
        to: parseDate(req.query['to']),
        hubId: (req.query['hubId'] as string) || undefined,
      });
      ApiResponseUtil.success(res, data);
    } catch (err) {
      next(err);
    }
  }
}
