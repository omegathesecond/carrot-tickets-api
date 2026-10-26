import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import {
  authenticateTickets,
  requireTicketsOwner,
  requireSuperAdmin,
} from '@middleware/ticketsAuth.middleware';
import { EventPayoutService } from '@services/eventPayout.service';
import {
  EventPayout,
  PayoutBank,
  PAYOUT_STATUSES,
  PayoutStatus,
} from '@models/eventPayout.model';
import { decryptPayoutBank } from '@utils/payoutBank.util';
import { HttpError } from '@utils/httpError.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import mongoose from 'mongoose';

const router = Router();
router.use(authenticateTickets);
const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        ApiResponseUtil.error(res, e.message, e.statusCode);
        return;
      }
      next(e);
    }
  };
const actor = (req: Request) => (req as any).ticketsUser;

router.get(
  '/bank',
  requireTicketsOwner,
  handle(async (req, res) => {
    const bank = await PayoutBank.findOne({ vendorId: actor(req).vendorId });
    ApiResponseUtil.success(
      res,
      bank ? { ...bank.masked, version: bank.version } : null,
    );
  }),
);
router.delete(
  '/bank',
  requireTicketsOwner,
  handle(async (req, res) => {
    await PayoutBank.deleteOne({ vendorId: actor(req).vendorId });
    ApiResponseUtil.success(res, { deleted: true });
  }),
);
router.get(
  '/events/:eventId',
  requireTicketsOwner,
  handle(async (req, res) => {
    ApiResponseUtil.success(
      res,
      await EventPayoutService.overview(
        String(req.params['eventId']),
        actor(req).vendorId,
      ),
    );
  }),
);
router.post(
  '/events/:eventId',
  requireTicketsOwner,
  handle(async (req, res) => {
    const { error } = Joi.object({
      bank: Joi.object(),
      useSaved: Joi.boolean(),
      saveBank: Joi.boolean(),
      bankVersion: Joi.string(),
      expectedAmount: Joi.number().positive().required(),
    })
      .unknown(false)
      .validate(req.body);
    if (error) throw new HttpError(400, 'Invalid payout request');
    ApiResponseUtil.created(
      res,
      await EventPayoutService.request(
        String(req.params['eventId']),
        actor(req).vendorId,
        req.body,
      ),
    );
  }),
);
router.get(
  '/',
  requireSuperAdmin,
  handle(async (req, res) => {
    const { error, value } = Joi.object({
      search: Joi.string().allow('').max(120).default(''),
      status: Joi.string().valid(...PAYOUT_STATUSES),
      page: Joi.number().integer().min(1).default(1),
    }).validate(req.query);
    if (error) throw new HttpError(400, 'Invalid payout filters');
    const query: any = {};
    if (value.status) query.status = value.status;
    if (value.search) {
      const term = value.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = ['eventName', 'organizerName', 'paymentReference'].map(
        (key) => ({ [key]: { $regex: term, $options: 'i' } }),
      );
    }
    const [items, total] = await Promise.all([
      EventPayout.find(query)
        .sort({ createdAt: -1 })
        .skip((value.page - 1) * 25)
        .limit(25),
      EventPayout.countDocuments(query),
    ]);
    ApiResponseUtil.success(res, { items, total, page: value.page });
  }),
);
router.get(
  '/:id',
  requireSuperAdmin,
  handle(async (req, res) => {
    const id = String(req.params['id']);
    if (!mongoose.isValidObjectId(id))
      throw new HttpError(400, 'Invalid payout identifier');
    const request = await EventPayout.findById(id).select('+bankEncrypted');
    if (!request) throw new HttpError(404, 'Payout request not found');
    let currentBreakdown;
    let balanceError;
    try {
      const current = await EventPayoutService.overview(
        String(request.eventId),
        String(request.vendorId),
        true,
      );
      currentBreakdown = current.breakdown;
    } catch (error) {
      // Keep immutable history reviewable when its event was deleted or its
      // sales need repair. Surface the blocker explicitly; payment still fails
      // the service's live-balance check. Dependency failures remain errors.
      if (
        !(error instanceof HttpError) ||
        ![404, 409].includes(error.statusCode)
      )
        throw error;
      balanceError = error.message;
    }
    const { bankEncrypted, ...safe } = request.toObject();
    ApiResponseUtil.success(res, {
      ...safe,
      bank: decryptPayoutBank(bankEncrypted, String(request.vendorId)),
      currentBreakdown,
      balanceError,
    });
  }),
);
router.post(
  '/:id/status',
  requireSuperAdmin,
  handle(async (req, res) => {
    const { error } = Joi.object({
      status: Joi.string().valid('approved', 'declined', 'paid').required(),
      note: Joi.string().allow('').max(1000),
      paidAt: Joi.string().isoDate(),
      paymentReference: Joi.string().max(120),
      paymentCompleted: Joi.boolean(),
    })
      .unknown(false)
      .validate(req.body);
    if (error) throw new HttpError(400, 'Invalid payout decision');
    ApiResponseUtil.success(
      res,
      await EventPayoutService.transition(
        String(req.params['id']),
        req.body.status as PayoutStatus,
        String(actor(req).userId ?? actor(req).vendorId),
        req.body,
      ),
    );
  }),
);
export default router;
