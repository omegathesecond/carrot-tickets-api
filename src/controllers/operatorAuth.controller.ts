// api/src/controllers/operatorAuth.controller.ts
import { Request, Response, NextFunction } from 'express';
import { ResellerOperator } from '@models/resellerOperator.model';
import { GateOperator } from '@models/gateOperator.model';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

export class OperatorAuthController {
  /** Resolve a login code across both operator populations and route accordingly. */
  static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { loginCode, pin } = req.body || {};
      if (typeof loginCode !== 'string' || typeof pin !== 'string') {
        ApiResponseUtil.badRequest(res, 'loginCode and pin must be strings');
        return;
      }
      if (!loginCode || !pin) { ApiResponseUtil.badRequest(res, 'loginCode and pin are required'); return; }

      const [reseller, gate] = await Promise.all([
        ResellerOperator.exists({ loginCode, isActive: true }),
        GateOperator.exists({ loginCode, isActive: true }),
      ]);

      try {
        if (gate) {
          const result = await GateOperatorAuthService.login(loginCode, pin);
          ApiResponseUtil.success(res, { type: 'gate', ...result });
          return;
        }
        if (reseller) {
          const result = await ResellerAuthService.login(loginCode, pin);
          ApiResponseUtil.success(res, { type: 'reseller', ...result });
          return;
        }
      } catch (e: any) {
        ApiResponseUtil.unauthorized(res, e.message || 'Invalid credentials');
        return;
      }
      ApiResponseUtil.unauthorized(res, 'Invalid credentials');
    } catch (err) {
      next(err);
    }
  }
}
