// api/src/controllers/operatorAuth.controller.ts
import { Request, Response, NextFunction } from 'express';
import { ResellerOperator } from '@models/resellerOperator.model';
import { GateOperator } from '@models/gateOperator.model';
import { Merchant } from '@models/merchant.model';
import { Cashier } from '@models/cashier.model';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';
import { MerchantAuthService } from '@services/merchantAuth.service';
import { CashierAuthService } from '@services/cashierAuth.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';

export class OperatorAuthController {
  /** Resolve a login code across all operator populations and route accordingly. */
  static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { loginCode, pin } = req.body || {};
      if (typeof loginCode !== 'string' || typeof pin !== 'string') {
        ApiResponseUtil.badRequest(res, 'loginCode and pin must be strings');
        return;
      }
      if (!loginCode || !pin) { ApiResponseUtil.badRequest(res, 'loginCode and pin are required'); return; }

      // Normalize ONCE, here, and reuse the canonical code for both the
      // routing probes below AND the service calls — otherwise a
      // lowercase/misread-glyph code fails these raw .exists() checks and
      // never reaches the (already-normalizing) service at all.
      const code = normalizeLoginCode(loginCode);

      const [reseller, gate, merchant, cashier] = await Promise.all([
        ResellerOperator.exists({ loginCode: code, isActive: true }),
        GateOperator.exists({ loginCode: code, isActive: true }),
        Merchant.exists({ loginCode: code, status: 'active' }),
        Cashier.exists({ loginCode: code, isActive: true }),
      ]);

      try {
        if (gate) {
          const result = await GateOperatorAuthService.login(code, pin);
          ApiResponseUtil.success(res, { type: 'gate', ...result });
          return;
        }
        if (cashier) {
          const result = await CashierAuthService.login(code, pin);
          ApiResponseUtil.success(res, { type: 'cashier', ...result });
          return;
        }
        if (reseller) {
          const result = await ResellerAuthService.login(code, pin);
          ApiResponseUtil.success(res, { type: 'reseller', ...result });
          return;
        }
        if (merchant) {
          const result = await MerchantAuthService.login(code, pin);
          ApiResponseUtil.success(res, { type: 'merchant', ...result });
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
