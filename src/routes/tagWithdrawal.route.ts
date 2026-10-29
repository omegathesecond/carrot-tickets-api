import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { authenticateTickets, requireSuperAdmin, authenticateBuyerOrOrganizer } from '@middleware/ticketsAuth.middleware';
import { TagWithdrawalService } from '@services/tagWithdrawal.service';
import { TagWithdrawalRequest, TAG_WITHDRAWAL_STATUSES } from '@models/tagWithdrawalRequest.model';
import { SecurityRateLimitService, SecurityRateLimitError } from '@services/securityRateLimit.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { HttpError } from '@utils/httpError.util';

const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof SecurityRateLimitError) res.setHeader('Retry-After', error.retryAfterSeconds);
    if (error instanceof HttpError) { ApiResponseUtil.error(res, error.message, error.statusCode); return; }
    next(error);
  }
};
// Cloud Run appends the connection IP to X-Forwarded-For; use the last value,
// never a caller-prepended first value, for the same cross-instance quota.
const sourceIp = (req: Request) => req.get('x-forwarded-for')?.split(',').at(-1)?.trim() || req.ip || 'unknown';
async function limit(req: Request) {
  const user = (req as any).ticketsUser;
  await SecurityRateLimitService.consume('tag-withdrawal-user', String(user.buyerId ?? user.userId ?? user.vendorId), 100, 15 * 60_000);
  await SecurityRateLimitService.consume('tag-withdrawal-ip', sourceIp(req), 1000, 15 * 60_000);
}
export const publicTagWithdrawalRoutes = Router();
publicTagWithdrawalRoutes.use(authenticateBuyerOrOrganizer);
publicTagWithdrawalRoutes.post('/lookup', handle(async (req, res) => {
  await limit(req);
  const { error, value } = Joi.object({ bandUid: Joi.string().trim().max(64).required(), eventId: Joi.string().hex().length(24).required() }).unknown(false).validate(req.body);
  if (error) throw new HttpError(400, 'Enter the printed tag code');
  ApiResponseUtil.success(res, await TagWithdrawalService.lookup(value.bandUid, value.eventId));
}));
publicTagWithdrawalRoutes.post('/', handle(async (req, res) => {
  await limit(req);
  ApiResponseUtil.success(res, await TagWithdrawalService.request(req.body, String((req as any).ticketsUser.buyerId ?? (req as any).ticketsUser.userId ?? (req as any).ticketsUser.vendorId)), 'Withdrawal requested. Keep your tracking link.');
}));
publicTagWithdrawalRoutes.post('/:id/track', handle(async (req, res) => {
  await limit(req);
  const { error, value } = Joi.object({ token: Joi.string().max(100).required(), eventId: Joi.string().hex().length(24).required() }).unknown(false).validate(req.body);
  if (error) throw new HttpError(400, 'A tracking token is required');
  ApiResponseUtil.success(res, await TagWithdrawalService.track(String(req.params['id']), value.token, value.eventId));
}));

export const adminTagWithdrawalRoutes = Router();
adminTagWithdrawalRoutes.use(authenticateTickets, requireSuperAdmin, authenticateBuyerOrOrganizer);
adminTagWithdrawalRoutes.get('/', handle(async (req, res) => {
  const { error, value } = Joi.object({
    status: Joi.string().valid(...TAG_WITHDRAWAL_STATUSES),
    eventId: Joi.string().hex().length(24),
    search: Joi.string().trim().max(120).allow('').default(''),
    page: Joi.number().integer().min(1).default(1),
  }).unknown(false).validate(req.query);
  if (error) throw new HttpError(400, 'Invalid withdrawal filters');
  const query: any = {};
  if (value.status) query.status = value.status;
  if (value.eventId) query.eventId = value.eventId;
  if (value.search) {
    const text = value.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = ['eventName', 'bandUid', 'paymentReference'].map(key => ({ [key]: { $regex: text, $options: 'i' } }));
  }
  const [items, total] = await Promise.all([
    TagWithdrawalRequest.find(query).sort({ createdAt: -1 }).skip((value.page - 1) * 25).limit(25),
    TagWithdrawalRequest.countDocuments(query),
  ]);
  ApiResponseUtil.success(res, { items, total, page: value.page });
}));
adminTagWithdrawalRoutes.get('/:id', handle(async (req, res) => {
  ApiResponseUtil.success(res, await TagWithdrawalService.detail(String(req.params['id'])));
}));
adminTagWithdrawalRoutes.post('/:id/status', handle(async (req, res) => {
  const { error, value } = Joi.object({
    status: Joi.string().valid('processing', 'paid', 'rejected').required(),
    paymentReference: Joi.string().trim().max(120), paymentCompleted: Joi.boolean(),
    rejectionReason: Joi.string().trim().max(1000),
  }).unknown(false).validate(req.body);
  if (error) throw new HttpError(400, 'Invalid withdrawal decision');
  const actor = (req as any).ticketsUser;
  ApiResponseUtil.success(res, await TagWithdrawalService.transition(String(req.params['id']), value.status,
    String(actor.userId ?? actor.vendorId), value));
}));
