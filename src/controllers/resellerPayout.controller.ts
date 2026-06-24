import { NextFunction, Request, Response } from 'express';
import { WithdrawalService } from '@services/withdrawal.service';
import { ResellerCommissionWithdrawal } from '@models/resellerCommissionWithdrawal.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';

export class ResellerPayoutController {
  static async overview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const [available, withdrawals] = await Promise.all([
        WithdrawalService.availableCommission(actor.resellerId),
        ResellerCommissionWithdrawal.find({ resellerId: actor.resellerId }).sort({ createdAt: -1 }),
      ]);
      ApiResponseUtil.success(res, { available, withdrawals });
    } catch (err) { next(err); }
  }

  static async request(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const w = await WithdrawalService.requestWithdrawal(actor.resellerId, actor.operatorId);
      ApiResponseUtil.created(res, w);
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      if (msg.includes('already open') || msg.includes('No commission available')) {
        ApiResponseUtil.badRequest(res, msg); return;
      }
      next(err);
    }
  }
}
