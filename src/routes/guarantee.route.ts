import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import Joi from 'joi';
import { authenticateTickets, requireTicketsOwner, requireSuperAdmin } from '@middleware/ticketsAuth.middleware';
import { Guarantee } from '@models/guarantee.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { EventFinancialsService } from '@services/eventFinancials.service';
import { NotificationService } from '@services/notification.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { HttpError } from '@utils/httpError.util';

const router = Router();
router.use(authenticateTickets);
const actor = (req: Request) => (req as any).ticketsUser;
const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  try { await fn(req, res); } catch (e) {
    if (e instanceof HttpError) { ApiResponseUtil.error(res, e.message, e.statusCode); return; }
    if (e instanceof mongoose.Error.VersionError) { ApiResponseUtil.error(res, 'Request changed; refresh and try again', 409); return; }
    next(e);
  }
};
function id(value: unknown) {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) throw new HttpError(400, 'Invalid identifier');
  return value;
}
async function eventFor(req: Request) {
  const event = await Event.findOne({ _id: id(req.params.eventId), vendorId: actor(req).vendorId });
  if (!event) throw new HttpError(404, 'Event not found');
  return event;
}
async function requestFor(req: Request, admin = false, agreement = false) {
  const user = actor(req);
  const query: any = { _id: id(req.params.id) };
  if (!admin) query.$or = [{ organizerId: user.vendorId }, { providerId: user.vendorId }];
  const request = await Guarantee.findOne(query).select(agreement ? '+agreement' : '');
  if (!request) throw new HttpError(404, 'Guarantee request not found');
  return request;
}
const inputSchema = Joi.object({
  providerId: Joi.string().hex().length(24).required(),
  amount: Joi.number().positive().precision(2).strict().required(),
  description: Joi.string().trim().min(1).max(4000).required(),
  expectedPaymentDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).isoDate().required(),
}).unknown(false);
async function validateInput(req: Request, organizerId: string) {
  const { error, value } = inputSchema.validate(req.body, { convert: false });
  if (error) throw new HttpError(400, error.message);
  const provider = await Vendor.findOne({ _id: value.providerId, operatorType: 'services', isActive: true });
  if (!provider) throw new HttpError(400, 'Select an active service provider');
  const financials = await EventFinancialsService.getEventFinancials(id(req.params.eventId), organizerId);
  const available = financials.custody.availableNow;
  if (!Number.isFinite(available)) throw new HttpError(409, 'Financials balance is unavailable; submission is blocked');
  if (value.amount > available) throw new HttpError(400, 'Amount exceeds the currently available ticket-sales balance in Financials');
  return { ...value, expectedPaymentDate: new Date(value.expectedPaymentDate), providerName: provider.businessName };
}
// Status and both durable inbox notifications commit together. No ledger or payment calls.
async function save(request: InstanceType<typeof Guarantee>, by: string, note: string, previousProvider?: string) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      request.history.push({ status: request.status, at: new Date(), by, note });
      await request.save({ session });
      for (const recipient of new Set([String(request.organizerId), String(request.providerId), ...(previousProvider ? [previousProvider] : [])])) {
        await NotificationService.create('vendor', String(recipient), 'guarantee_status', 'Guarantee request updated', `${request.eventName}: ${request.status.replace(/_/g, ' ')}`, { guaranteeId: String(request._id), eventId: String(request.eventId), status: request.status, dashboardPath: recipient === String(request.organizerId) ? `/events/${request.eventId}?tab=guarantee` : '/provider/guarantees' }, session);
      }
    });
  } finally { await session.endSession(); }
}
router.get('/providers', requireTicketsOwner, handle(async (_req, res) => {
  ApiResponseUtil.success(res, await Vendor.find({ operatorType: 'services', isActive: true }).select('businessName').sort({ businessName: 1 }).lean());
}));
router.get('/events/:eventId', requireTicketsOwner, handle(async (req, res) => {
  await eventFor(req);
  ApiResponseUtil.success(res, await Guarantee.find({ eventId: req.params.eventId, organizerId: actor(req).vendorId }).sort({ createdAt: -1 }));
}));
router.post('/events/:eventId', requireTicketsOwner, handle(async (req, res) => {
  const event = await eventFor(req);
  const owner = await Vendor.findById(actor(req).vendorId);
  if (!owner) throw new HttpError(404, 'Organizer not found');
  const input = await validateInput(req, String(event.vendorId));
  const request = new Guarantee({ ...input, eventId: event._id, organizerId: event.vendorId, organizerName: owner.businessName, eventName: event.name, currency: event.currency });
  await save(request, String(actor(req).vendorId), 'Request submitted');
  ApiResponseUtil.created(res, request);
}));
router.put('/events/:eventId/:id', requireTicketsOwner, handle(async (req, res) => {
  await eventFor(req);
  const request = await requestFor(req);
  if (String(request.eventId) !== req.params.eventId || String(request.organizerId) !== actor(req).vendorId) throw new HttpError(404, 'Guarantee request not found');
  if (request.status !== 'requested') throw new HttpError(409, 'Provider has responded; editing is closed');
  const previousProvider = String(request.providerId);
  const input = await validateInput(req, String(request.organizerId));
  const changedProvider = input.providerId !== previousProvider;
  request.set(input);
  if (changedProvider) {
    // An agreement signed for the old recipient is not shared with a new one.
    request.agreement = undefined;
    request.agreementName = undefined;
  }
  await save(request, String(actor(req).vendorId), changedProvider ? 'Provider changed; previous agreement removed. Attach an agreement for the selected provider.' : 'Request edited', changedProvider ? previousProvider : undefined);
  ApiResponseUtil.success(res, request);
}));
router.get('/provider', requireTicketsOwner, handle(async (req, res) => {
  ApiResponseUtil.success(res, await Guarantee.find({ providerId: actor(req).vendorId }).sort({ createdAt: -1 }));
}));
router.get('/admin', requireSuperAdmin, handle(async (_req, res) => {
  ApiResponseUtil.success(res, await Guarantee.find({ status: { $in: ['accepted', 'pending', 'paid', 'rejected'] } }).sort({ updatedAt: -1 }));
}));
router.post('/:id/response', requireTicketsOwner, handle(async (req, res) => {
  const { error, value } = Joi.object({ status: Joi.string().valid('accepted', 'provider_rejected', 'withdrawn').required(), note: Joi.string().trim().max(1000).allow('') }).unknown(false).validate(req.body);
  if (error) throw new HttpError(400, 'Invalid response');
  const request = await requestFor(req);
  const authorized = value.status === 'withdrawn' ? request.organizerId : request.providerId;
  if (String(authorized) !== actor(req).vendorId) throw new HttpError(403, 'This action is not available to your account');
  if (request.status !== 'requested') throw new HttpError(409, 'Provider has already responded or request was withdrawn');
  request.status = value.status;
  await save(request, String(actor(req).vendorId), value.note ?? '');
  ApiResponseUtil.success(res, request);
}));
router.post('/:id/status', requireSuperAdmin, handle(async (req, res) => {
  const { error, value } = Joi.object({ status: Joi.string().valid('pending', 'paid', 'rejected').required(), note: Joi.string().trim().max(1000).allow('') }).unknown(false).validate(req.body);
  if (error) throw new HttpError(400, 'Invalid admin decision');
  const request = await requestFor(req, true);
  if (!['accepted', 'pending'].includes(request.status)) throw new HttpError(409, 'Only provider-accepted requests can be reviewed');
  request.status = value.status;
  await save(request, String(actor(req).userId ?? actor(req).vendorId), value.note ?? '');
  ApiResponseUtil.success(res, request);
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('agreement');
router.post('/:id/agreement', requireTicketsOwner, handle(async (req, res) => {
  const request = await requestFor(req);
  if (String(request.organizerId) !== actor(req).vendorId) throw new HttpError(403, 'Only the organizer can attach an agreement');
  if (request.status !== 'requested') throw new HttpError(409, 'Provider has responded; editing is closed');
  await new Promise<void>((resolve, reject) => upload(req, res, e => e ? reject(new HttpError(400, e.message)) : resolve()));
  if (!req.file || req.file.mimetype !== 'application/pdf' || !req.file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new HttpError(400, 'Upload a PDF agreement (maximum 5 MB)');
  request.agreement = req.file.buffer;
  request.agreementName = req.file.originalname.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
  await save(request, String(actor(req).vendorId), 'Signed agreement attached');
  ApiResponseUtil.success(res, { attached: true });
}));
router.get('/:id/agreement', (req, res, next) => {
  if (actor(req).isSuperAdmin) { void requireSuperAdmin(req, res, next); } else { requireTicketsOwner(req, res, next); }
}, handle(async (req, res) => {
  // Sub-users cannot read private agreements, even with event permissions.
  if (actor(req).userType !== 'vendor' && !actor(req).isSuperAdmin) throw new HttpError(403, 'Owner access required');
  const request = await requestFor(req, !!actor(req).isSuperAdmin, true);
  if (!request.agreement) throw new HttpError(404, 'No agreement attached');
  res.setHeader('Content-Disposition', 'attachment; filename="agreement.pdf"');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(request.agreement);
}));
export default router;
