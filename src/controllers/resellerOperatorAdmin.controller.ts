import { NextFunction, Request, Response } from 'express';
import { ResellerOperator } from '@models/resellerOperator.model';
import { ResellerHub } from '@models/resellerHub.model';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';

const ROLE_RANK: Record<string, number> = {
  reseller_operator: 0,
  reseller_hub_manager: 1,
  reseller_admin: 2,
};

/** Build the Mongo scope filter from the actor's token. */
function scopeFilter(actor: any): Record<string, unknown> {
  if (actor.role === 'reseller_hub_manager') return { hubId: actor.hubId };
  return { resellerId: actor.resellerId };
}

export class ResellerOperatorAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const operators = await ResellerOperator.find(scopeFilter(actor)).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, operators);
    } catch (err: any) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const requestedRole = req.body.role ?? 'reseller_operator';

      // An actor may only assign roles strictly below their own rank.
      if ((ROLE_RANK[requestedRole] ?? 99) >= (ROLE_RANK[actor.role] ?? 0)) {
        ApiResponseUtil.forbidden(res, 'Cannot assign a role at or above your own');
        return;
      }

      // Resolve the target hub within the actor's scope.
      let hubId = actor.role === 'reseller_hub_manager' ? actor.hubId : req.body.hubId;
      if (!hubId) {
        ApiResponseUtil.badRequest(res, 'hubId is required');
        return;
      }
      const hub = await ResellerHub.findById(hubId);
      if (!hub || hub.resellerId.toString() !== actor.resellerId) {
        ApiResponseUtil.forbidden(res, 'Hub is not in your reseller');
        return;
      }

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      const operator = await ResellerOperator.create({
        fullName: req.body.fullName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        role: requestedRole,
        hubId: hub._id,
        resellerId: hub.resellerId,
        loginCode,
        pin,
      });
      ApiResponseUtil.created(res, { operator, loginCode, pin });
    } catch (err: any) {
      next(err);
    }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const operator = await ResellerOperator.findOne({
        _id: req.params['id'],
        ...scopeFilter(actor),
      }).select('+pin');
      if (!operator) {
        ApiResponseUtil.notFound(res, 'Operator not found');
        return;
      }
      if ((ROLE_RANK[operator.role] ?? 99) >= (ROLE_RANK[actor.role] ?? 0)) {
        ApiResponseUtil.forbidden(res, 'Cannot manage an operator at or above your own role');
        return;
      }
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      operator.pin = pin;
      operator.failedPinAttempts = 0;
      operator.lockedUntil = null;
      await operator.save();
      ApiResponseUtil.success(res, { operatorId: (operator._id as any).toString(), pin });
    } catch (err: any) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const operator = await ResellerOperator.findOne({
        _id: req.params['id'],
        ...scopeFilter(actor),
      });
      if (!operator) {
        ApiResponseUtil.notFound(res, 'Operator not found');
        return;
      }
      if ((ROLE_RANK[operator.role] ?? 99) >= (ROLE_RANK[actor.role] ?? 0)) {
        ApiResponseUtil.forbidden(res, 'Cannot manage an operator at or above your own role');
        return;
      }
      if ('fullName' in req.body) operator.fullName = req.body.fullName;
      if ('isActive' in req.body) operator.isActive = !!req.body.isActive;
      if ('role' in req.body) {
        if ((ROLE_RANK[req.body.role] ?? 99) >= (ROLE_RANK[actor.role] ?? 0)) {
          ApiResponseUtil.forbidden(res, 'Cannot assign a role at or above your own');
          return;
        }
        operator.role = req.body.role;
      }
      await operator.save();
      ApiResponseUtil.success(res, operator);
    } catch (err: any) {
      next(err);
    }
  }
}
