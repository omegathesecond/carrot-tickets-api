import { NextFunction, Request, Response } from 'express';
import { WithdrawalService } from '@services/withdrawal.service';
import { ResellerCommissionWithdrawal } from '@models/resellerCommissionWithdrawal.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';

const adminId = (req: Request) => (req as any).ticketsUser.vendorId as string;

export class ResellerWithdrawalAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const filter: Record<string, unknown> = {};
      if (typeof req.query['status'] === 'string') filter['status'] = req.query['status'];
      const items = await ResellerCommissionWithdrawal.find(filter).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, items);
    } catch (err) { next(err); }
  }

  static async listForReseller(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const items = await ResellerCommissionWithdrawal
        .find({ resellerId: req.params['id'] }).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, items);
    } catch (err) { next(err); }
  }

  static async approve(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      ApiResponseUtil.success(res, await WithdrawalService.approve(req.params['id']!, adminId(req)));
    } catch (err: any) { ResellerWithdrawalAdminController.guard(res, err, next); }
  }

  static async markPaid(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      ApiResponseUtil.success(res,
        await WithdrawalService.markPaid(req.params['id']!, adminId(req), req.body.paymentReference));
    } catch (err: any) { ResellerWithdrawalAdminController.guard(res, err, next); }
  }

  static async reject(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      ApiResponseUtil.success(res,
        await WithdrawalService.reject(req.params['id']!, adminId(req), req.body.notes));
    } catch (err: any) { ResellerWithdrawalAdminController.guard(res, err, next); }
  }

  private static guard(res: Response, err: any, next: NextFunction): void {
    const msg: string = err?.message ?? '';
    if (msg.includes('not found') || msg.includes('already paid') ||
        msg.includes('not in requested') || msg.includes('not pending') || msg.includes('was rejected')) {
      ApiResponseUtil.notFound(res, msg); return;
    }
    next(err);
  }
}
