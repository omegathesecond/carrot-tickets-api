import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import Joi from 'joi';
import {
  authenticateBuyerOrOrganizer,
  requireTicketsOwner,
} from '@middleware/ticketsAuth.middleware';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { HttpError } from '@utils/httpError.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { R2Service } from '@utils/r2.service';
import { posterUpload, handleMulterError } from '@middleware/media.middleware';
import { ServiceCategoryService } from '@services/serviceCategory.service';
import { ServiceCategory } from '@models/serviceCategory.model';
import { NotificationService } from '@services/notification.service';
import { publishApplicationPhotos } from '@services/applicationPhotoPosts.service';
import {
  MarketServiceListing,
  MarketApplication,
  MarketCertificate,
  MarketOpportunity,
  MarketPreference,
  MarketProfile,
  MarketExperiencePhoto,
  ensureMarketplaceIndexes,
} from './models';
import {
  serviceListingSchema,
  AVAILABILITY,
  CERTIFICATE_TYPES,
  MARKET_TYPES,
  REGIONS,
  certificateProblems,
  idSchema,
  profileSchema,
  opportunitySchema,
  validate,
  validateDeadlineTradingDates,
  validatePaymentDeadline,
  validateOpportunity,
  validateProfile,
} from './validation';

const router = Router();
let indexes: Promise<void> | undefined;
const wrap =
  (fn: (req: Request, res: Response) => Promise<any>) =>
  async (req: Request, res: Response) => {
    try {
      if (!indexes)
        indexes = ensureMarketplaceIndexes().catch((err) => {
          indexes = undefined;
          throw err;
        });
      await indexes;
      return await fn(req, res);
    } catch (e: any) {
      if (e?.code === 11000)
        return ApiResponseUtil.error(
          res,
          'This business already has an active application for this opportunity and date, or this certificate type already exists.',
          409,
        );
      return failWithHttpError(res, e, 'Marketplace request failed');
    }
  };
const actor = (req: Request) => String((req as any).marketplaceOwnerId);
const admin = (req: Request) => (req as any).ticketsUser.isSuperAdmin === true;
const id = (value: unknown): string => validate(idSchema, value);
const ok = (res: Response, data: unknown) =>
  ApiResponseUtil.success(res, data, 'Marketplace');
function validatedDocument(value: { file: string; mime: string }): Buffer {
  const file = Buffer.from(value.file, 'base64');
    if (file.length > 5 * 1024 * 1024 || file.length === 0)
      throw new HttpError(400, 'File must be between 1 byte and 5 MB');
    const matches =
      value.mime === 'application/pdf'
        ? file.subarray(0, 5).toString() === '%PDF-'
        : value.mime === 'image/png'
          ? file
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : file[0] === 255 && file[1] === 216 && file[2] === 255;
    if (!matches)
      throw new HttpError(
        400,
        'The file does not match the selected PDF, JPEG or PNG format',
      );
    return file;
}
async function ownedProfile(req: Request, profileId: unknown) {
  const profile = await MarketProfile.findOne({
    _id: id(profileId),
    ownerId: actor(req),
  });
  if (!profile) throw new HttpError(404, 'Provider business profile not found');
  return profile;
}
async function managedOpportunity(
  req: Request,
  opportunityId: unknown,
  session?: mongoose.ClientSession,
) {
  const query: any = { _id: id(opportunityId) };
  if (!admin(req)) query.organiserId = actor(req);
  const opportunity = await MarketOpportunity.findOne(query).select('+paymentDetails').session(
    session ?? null,
  );
  if (!opportunity) throw new HttpError(404, 'Opportunity not found');
  return opportunity;
}
async function transaction<T>(
  fn: (session: mongoose.ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
// Call only inside a transaction that also writes the opportunity revision.
// That shared write fence makes competing approvals retry with fresh counts.
async function ensureStallSpace(
  opportunity: Awaited<ReturnType<typeof managedOpportunity>>,
  name: string | undefined,
  scopeKey: string | undefined,
  session: mongoose.ClientSession,
) {
  const type = opportunity.stallTypes.find((t) => t.name === name);
  if (!type) throw new HttpError(400, 'Select an available stall type');
  const approved = await MarketApplication.countDocuments({
    opportunityId: opportunity._id,
    scopeKey,
    stallType: name,
    status: 'approved',
  }).session(session);
  if (approved >= type.spaces!)
    throw new HttpError(409, 'This stall type is full for the selected trading date or regular listing');
  return type;
}
router.get(
  '/options',
  wrap(async (_req, res) =>
    ok(res, {
      categories: await ServiceCategoryService.listActive(),
      marketTypes: MARKET_TYPES,
      availability: AVAILABILITY,
      certificateTypes: CERTIFICATE_TYPES,
      regions: REGIONS,
    }),
  ),
);
const listOpportunities = wrap(async (req, res) => {
  const q = validate(
    Joi.object({
      search: Joi.string().max(200).allow(''),
      location: Joi.string().max(200).allow(''),
      date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
      marketType: Joi.string().valid(...MARKET_TYPES),
      category: Joi.string().max(200),
      availability: Joi.string().valid(...AVAILABILITY),
      maxFee: Joi.number().min(0),
      minFee: Joi.number().min(0),
      currency: Joi.string()
        .length(3)
        .uppercase()
        .pattern(/^[A-Z]{3}$/),
      available: Joi.boolean(),
      page: Joi.number().integer().min(1).max(10000).default(1),
    }),
    req.query,
  );
  const filter: any = {
    status: 'published',
    applicationDeadline: { $gt: new Date() },
  };
  const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q.search)
    filter.$or = ['name', 'organiser', 'description'].map((k) => ({
      [k]: { $regex: literal(q.search), $options: 'i' },
    }));
  if (q.location)
    filter.location = { $regex: literal(q.location), $options: 'i' };
  for (const key of ['marketType', 'availability', 'currency'])
    if (q[key]) filter[key] = q[key];
  if (q.category) filter.categories = q.category;
  if (req.path === '/matched-opportunities') {
    const vendor = await Vendor.findById(actor(req))
      .select('serviceCategories')
      .lean();
    if (!vendor) throw new HttpError(404, 'Provider not found');
    const selected = vendor.serviceCategories ?? [];
    // Marketplace accepts category names as well as stable service identifiers.
    // Resolve current labels from the same catalogue used during signup.
    const categories = await ServiceCategory.find({ value: { $in: selected } })
      .select('label')
      .lean();
    const terms = [
      ...new Set([...selected, ...categories.map((c) => c.label)]),
    ];
    filter.$and = [
      {
        categories: {
          $in: terms.map((term) => new RegExp('^' + literal(term) + '$', 'i')),
        },
      },
    ];
  }
  if (q.maxFee !== undefined || q.minFee !== undefined) {
    if (!q.currency)
      throw new HttpError(400, 'Select a currency when filtering stall fees');
    filter.stallTypes = { $elemMatch: { price: {
      ...(q.maxFee !== undefined ? { $lte: q.maxFee } : {}),
      ...(q.minFee !== undefined ? { $gte: q.minFee } : {}),
    } } };
  }
  const today = new Date().toISOString().slice(0, 10);
  filter.dates = q.date || { $gte: today };
  const upcomingDates = q.date
    ? { $literal: [q.date] }
    : {
        $filter: {
          input: '$dates',
          as: 'date',
          cond: { $gte: ['$$date', today] },
        },
      };
  const items = await MarketOpportunity.aggregate([
    { $match: filter },
    {
      $set: {
        nextTradingDate: {
          $min: upcomingDates,
        },
      },
    },
    {
      $lookup: {
        from: MarketApplication.collection.name,
        let: {
          opportunityId: '$_id',
          dates: upcomingDates,
          scope: '$scope',
        },
        pipeline: [
          {
            $match: {
              status: 'approved',
              $expr: {
                $and: [
                  { $eq: ['$opportunityId', '$$opportunityId'] },
                  {
                    $cond: [
                      { $eq: ['$$scope', 'regular'] },
                      { $eq: ['$scopeKey', 'regular'] },
                      { $in: ['$scopeKey', '$$dates'] },
                    ],
                  },
                ],
              },
            },
          },
          { $group: { _id: '$scopeKey', count: { $sum: 1 } } },
        ],
        as: 'approvals',
      },
    },
    {
      $set: {
        approvedProviders: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: '$approvals',
                  as: 'approval',
                  cond: {
                    $eq: [
                      '$$approval._id',
                      {
                        $cond: [
                          { $eq: ['$scope', 'regular'] },
                          'regular',
                          q.date || '$nextTradingDate',
                        ],
                      },
                    ],
                  },
                },
              },
              as: 'approval',
              in: '$$approval.count',
            },
          },
        },
      },
    },
    {
      $set: {
        remainingCapacity: {
          $cond: [
            { $eq: ['$capacity', null] },
            null,
            { $subtract: ['$capacity', '$approvedProviders'] },
          ],
        },
      },
    },
    ...(q.available
      ? [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ['$capacity', null] },
                  {
                    $lt: [
                      // An unfilled date may have no approval group at all.
                      {
                        $size: {
                          $filter: {
                            input: '$approvals',
                            as: 'approval',
                            cond: { $gte: ['$$approval.count', '$capacity'] },
                          },
                        },
                      },
                      {
                        $cond: [
                          { $eq: ['$scope', 'regular'] },
                          1,
                          { $size: upcomingDates },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        ]
      : []),
    { $unset: ['approvals', '__v', 'revision', 'paymentDetails'] },
    { $sort: { nextTradingDate: 1, _id: 1 } },
    { $skip: (q.page - 1) * 30 },
    { $limit: 31 },
  ]);
  return ok(res, { items: items.slice(0, 30), hasMore: items.length > 30 });
});
router.get('/opportunities', listOpportunities);
router.get(
  '/opportunities/:id',
  wrap(async (req, res) => {
    const opportunity = await MarketOpportunity.findOne({
      _id: id(req.params['id']),
      status: { $in: ['published', 'paused', 'closed'] },
    }).lean();
    if (!opportunity) throw new HttpError(404, 'Opportunity not found');
    if (!opportunity.stallTypes?.length) throw new HttpError(409, 'The organiser must configure stall types before this listing can accept applications');
    const typeCounts = await MarketApplication.aggregate([
      { $match: { opportunityId: opportunity._id, status: 'approved' } },
      { $group: { _id: { scope: '$scopeKey', type: '$stallType' }, count: { $sum: 1 } } },
    ]);
    const approvedByScope: Record<string, number> = {};
    for (const c of typeCounts) approvedByScope[c._id.scope] = (approvedByScope[c._id.scope] || 0) + c.count;
    return ok(res, {
      ...opportunity,
      approvedByType: typeCounts.map((c) => ({ scope: c._id.scope, type: c._id.type, count: c.count })),
      approvedByScope,
    });
  }),
);
router.get(
  '/service-listings',
  wrap(async (req, res) => {
    const q = validate(
      Joi.object({
        category: Joi.string().max(200).allow(''),
        page: Joi.number().integer().min(1).max(10000).default(1),
      }),
      req.query,
    );
    const items = await MarketServiceListing.find({
      status: 'published',
      ...(q.category ? { category: q.category } : {}),
    })
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * 24)
      .limit(25)
      .lean();
    return ok(res, { items: items.slice(0, 24), hasMore: items.length > 24 });
  }),
);
// Buyers share the provider profile/application flow. Staff and scanner tokens
// cannot access private marketplace data; business-only routes retain their gates.
router.use(authenticateBuyerOrOrganizer);
router.use((req: Request, res: Response, next: NextFunction) => {
  if ((req as any).ticketsUser.userType !== 'buyer') {
    return requireTicketsOwner(req, res, () => {
      (req as any).marketplaceOwnerId = (req as any).ticketsUser.vendorId;
      next();
    });
  }
  resolveBuyerFromRequest(req).then((buyer) => {
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Buyer account no longer exists');
    (req as any).marketplaceOwnerId = String(buyer._id);
    return next();
  }).catch(next);
});
router.get('/matched-opportunities', listOpportunities);
async function requireProvider(req: Request) {
  if ((req as any).ticketsUser.userType !== 'vendor')
    throw new HttpError(403, 'A service provider business is required');
  const vendor = await Vendor.findById(actor(req))
    .select('operatorType')
    .lean();
  if (!vendor || vendor.operatorType !== 'services')
    throw new HttpError(403, 'A service provider business is required');
}
router.get(
  '/my-service-listings',
  wrap(async (req, res) => {
    await requireProvider(req);
    return ok(res, {
      items: await MarketServiceListing.find({ ownerId: actor(req) })
        .sort({ createdAt: -1 })
        .lean(),
    });
  }),
);
const saveServiceListing = wrap(async (req, res) => {
  await requireProvider(req);
  const value = validate(serviceListingSchema, req.body);
  if (
    !(await ServiceCategory.exists({ value: value.category, isActive: true }))
  )
    throw new HttpError(400, 'Choose an active service category');
  const listing = req.params['listingId']
    ? await MarketServiceListing.findOneAndUpdate(
        { _id: id(req.params['listingId']), ownerId: actor(req) },
        { $set: value },
        { new: true, runValidators: true },
      )
    : await MarketServiceListing.create({ ...value, ownerId: actor(req) });
  if (!listing) throw new HttpError(404, 'Service listing not found');
  return ok(res, listing);
});
router.post('/service-listings', saveServiceListing);
router.put('/service-listings/:listingId', saveServiceListing);
router.post(
  '/service-photos',
  posterUpload.single('poster'),
  handleMulterError,
  wrap(async (req, res) => {
    await requireProvider(req);
    return uploadMarketplacePhoto(req, res);
  }),
);

router.post('/experience-photos', posterUpload.single('poster'), handleMulterError, wrap(async (req, res) => {
  const posterUrl = await storeMarketplacePhoto(req);
  await MarketExperiencePhoto.create({ ownerId: actor(req), url: posterUrl });
  return ok(res, { posterUrl });
}));

async function requireStoredExperiencePhotos(req: Request, photos: string[]) {
  const count = await MarketExperiencePhoto.countDocuments({ ownerId: actor(req), url: { $in: photos } });
  if (count !== photos.length) throw new HttpError(400, 'Upload each experience photo before saving your business');
}

router.get(
  '/profiles',
  wrap(async (req, res) => {
    const [items, preference, certificates] = await Promise.all([
      MarketProfile.find({ ownerId: actor(req) })
        .sort({ createdAt: 1 })
        .lean(),
      MarketPreference.findOne({ ownerId: actor(req) }).lean(),
      MarketCertificate.find({ ownerId: actor(req), active: true }).lean(),
    ]);
    return ok(res, {
      items,
      defaultProfileId: preference?.defaultProfileId,
      certificates,
    });
  }),
);
router.post(
  '/profiles',
  wrap(async (req, res) => {
    const value = validateProfile(req.body);
    await requireStoredExperiencePhotos(req, value.experiencePhotos);
    return ok(
      res,
      await MarketProfile.create({ ...value, ownerId: actor(req) }),
    );
  }),
);
router.put(
  '/profiles/:id',
  wrap(async (req, res) => {
    const value = validateProfile(req.body);
    const profile = await ownedProfile(req, req.params['id']);
    await requireStoredExperiencePhotos(req, value.experiencePhotos);
    profile.set(value);
    await profile.save();
    return ok(res, profile);
  }),
);
router.put(
  '/default-profile',
  wrap(async (req, res) => {
    const body = validate(Joi.object({ profileId: idSchema }), req.body);
    const profile = await ownedProfile(req, body.profileId);
    return ok(
      res,
      await MarketPreference.findOneAndUpdate(
        { ownerId: actor(req) },
        { defaultProfileId: profile._id },
        { upsert: true, new: true },
      ),
    );
  }),
);
router.post(
  '/profiles/:id/certificates',
  wrap(async (req, res) => {
    const profile = await ownedProfile(req, req.params['id']);
    const value = validate(
      Joi.object({
        type: Joi.string()
          .valid(...CERTIFICATE_TYPES)
          .required(),
        name: Joi.string().trim().max(180).required(),
        mime: Joi.string()
          .valid('application/pdf', 'image/jpeg', 'image/png')
          .required(),
        expiresAt: Joi.date().iso().allow(null).default(null),
        file: Joi.string()
          .base64()
          .max(7 * 1024 * 1024)
          .required(),
      }),
      req.body,
    );
    const file = validatedDocument(value);
    const certificate = await transaction(async (session) => {
      await MarketProfile.updateOne(
        { _id: profile._id },
        { $inc: { revision: 1 } },
        { session },
      );
      await MarketCertificate.updateMany(
        { profileId: profile._id, type: value.type, active: true },
        { active: false },
        { session },
      );
      const [doc] = await MarketCertificate.create(
        [{ ...value, file, ownerId: actor(req), profileId: profile._id }],
        { session },
      );
      return doc!;
    });
    return ok(res, {
      _id: certificate._id,
      type: certificate.type,
      name: certificate.name,
      expiresAt: certificate.expiresAt,
    });
  }),
);
router.delete(
  '/certificates/:id',
  wrap(async (req, res) => {
    await transaction(async (session) => {
      const doc = await MarketCertificate.findOne({
        _id: id(req.params['id']),
        ownerId: actor(req),
      }).session(session);
      if (!doc) throw new HttpError(404, 'Certificate not found');
      await MarketProfile.updateOne(
        { _id: doc.profileId },
        { $inc: { revision: 1 } },
        { session },
      );
      doc.active = false;
      await doc.save({ session });
    });
    return ok(res, { ok: true });
  }),
);
router.get(
  '/certificates/:id',
  wrap(async (req, res) => {
    const doc = await MarketCertificate.findById(id(req.params['id'])).select(
      '+file',
    );
    if (!doc) throw new HttpError(404, 'Certificate not found');
    if (!admin(req) && String(doc.ownerId) !== actor(req)) {
      const permitted = await MarketApplication.exists({
        organiserId: actor(req),
        certificates: doc._id,
      });
      if (!permitted) throw new HttpError(404, 'Certificate not found');
    }
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', doc.mime || 'application/octet-stream');
    res.set(
      'Content-Disposition',
      `attachment; filename="${(doc.name || 'certificate').replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    );
    return res.send(doc.file);
  }),
);
router.post(
  '/applications/:id/payment-proof',
  wrap(async (req, res) => {
    const value = validate(Joi.object({
      name: Joi.string().trim().max(180).required(),
      mime: Joi.string().valid('application/pdf', 'image/jpeg', 'image/png').required(),
      file: Joi.string().base64().max(7 * 1024 * 1024).required(),
    }), req.body);
    const file = validatedDocument(value);
    const app = await MarketApplication.findOneAndUpdate(
      { _id: id(req.params['id']), ownerId: actor(req), status: 'approved', paymentStatus: 'due' },
      { $set: { paymentProof: { name: value.name, mime: value.mime, file, uploadedAt: new Date() } }, $inc: { __v: 1 } },
      { new: true },
    );
    if (!app) throw new HttpError(409, 'Only the applicant can upload proof for an approved application with payment due');
    return ok(res, { name: value.name, uploadedAt: app.paymentProof?.uploadedAt });
  }),
);
router.get(
  '/applications/:id/payment-proof',
  wrap(async (req, res) => {
    const app = await MarketApplication.findById(id(req.params['id'])).select('+paymentProof.file');
    if (!app || (!admin(req) && String(app.ownerId) !== actor(req) && String(app.organiserId) !== actor(req)) || !app.paymentProof?.file)
      throw new HttpError(404, 'Payment proof not found');
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', app.paymentProof.mime || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${(app.paymentProof.name || 'payment-proof').replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    return res.send(app.paymentProof.file);
  }),
);
router.get(
  '/applications',
  wrap(async (req, res) => {
    const items = await MarketApplication.find({ ownerId: actor(req) })
      .populate('opportunityId', 'name dates scope location status +paymentDetails')
      .sort({ createdAt: -1 })
      .lean();
    for (const item of items) {
      if (item.status !== 'approved' && item.opportunityId) delete (item.opportunityId as any).paymentDetails;
    }
    return ok(res, { items });
  }),
);
router.post(
  '/opportunities/:id/apply',
  wrap(async (req, res) => {
    const body = validate(
      Joi.object({
        profileId: idSchema,
        stallType: Joi.string().trim().max(100).required(),
        date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
        overrides: profileSchema.optional(),
        note: Joi.string().trim().max(2000).allow('').default(''),
      }),
      req.body,
    );
    const saved = await ownedProfile(req, body.profileId);
    const savedObject = saved.toObject();
    const savedFields = Object.fromEntries(
      Object.keys(profileSchema.describe().keys!).map((key) => [
        key,
        (savedObject as any)[key],
      ]),
    );
    const profile = validateProfile(body.overrides || savedFields);
    await requireStoredExperiencePhotos(req, profile.experiencePhotos);
    const application = await transaction(async (session) => {
      const opportunity = await MarketOpportunity.findOneAndUpdate(
        {
          _id: id(req.params['id']),
          status: 'published',
          applicationDeadline: { $gt: new Date() },
        },
        { $inc: { revision: 1 } },
        { new: true, session },
      );
      if (!opportunity)
        throw new HttpError(
          409,
          'This opportunity is not accepting applications',
        );
      if (String(opportunity.organiserId) === actor(req))
        throw new HttpError(400, 'You cannot apply to your own opportunity');
      const scopeKey = opportunity.scope === 'regular' ? 'regular' : body.date;
      if (
        scopeKey !== 'regular' &&
        (!opportunity.dates.includes(scopeKey) ||
          scopeKey < new Date().toISOString().slice(0, 10))
      )
        throw new HttpError(
          400,
          'Select an upcoming trading date from this opportunity',
        );
      await MarketProfile.updateOne(
        { _id: saved._id },
        { $inc: { revision: 1 } },
        { session },
      );
      const certificates = await MarketCertificate.find({
        profileId: saved._id,
        active: true,
      })
        .session(session)
        .lean();
      const problems = certificateProblems(profile, certificates, opportunity);
      if (problems.length) throw new HttpError(422, problems.join('; '));
      const selectedType = await ensureStallSpace(opportunity, body.stallType, scopeKey, session);
      const relevant = new Set([
        ...opportunity.requiredCertificates,
        ...(profile.sellsFood ? opportunity.foodCertificates : []),
        ...(profile.sellsFood ? CERTIFICATE_TYPES : ['public_liability']),
      ]);
      const [doc] = await MarketApplication.create(
        [
          {
            ownerId: actor(req),
            profileId: saved._id,
            opportunityId: opportunity._id,
            organiserId: opportunity.organiserId,
            scopeKey,
            stallType: body.stallType,
            profile,
            certificates: certificates
              .filter((c) => relevant.has(c.type))
              .map((c) => c._id),
            note: body.note,
            terms: {
              stallType: selectedType.name,
              stallFee: selectedType.price,
              currency: opportunity.currency,
              feeTiers: opportunity.feeTiers,
              optionalCharges: opportunity.optionalCharges,
              paymentDeadline: opportunity.paymentDeadline,
              cancellationTerms: opportunity.cancellationTerms,
              dates: opportunity.dates,
            },
          },
        ],
        { session },
      );
      await publishApplicationPhotos((req as any).ticketsUser.userType === 'buyer' ? 'buyer' : 'vendor', new mongoose.Types.ObjectId(actor(req)), profile.experiencePhotos, new Date(), session);
      return doc!;
    });
    return ok(res, application);
  }),
);
// Resolve the current account, rather than trusting a client role or stale token.
router.use('/manage', requireTicketsOwner);
router.use('/manage', (req, res, next) =>
  wrap(async () => {
    const vendor = await Vendor.findById(actor(req)).select('operatorType');
    if (!vendor) throw new HttpError(401, 'Business account no longer exists');
    if (!admin(req) && !['events', 'both'].includes(vendor.operatorType))
      throw new HttpError(
        403,
        'Only organisers can manage stall opportunities',
      );
    // The wrapper handles failures using the normal API error response.
    return next();
  })(req, res),
);
// Publicly listed Carrot events may be linked without transferring ownership.
async function validateLinkedEvent(value: { eventId?: string | null }) {
  if (
    value.eventId &&
    !(await Event.exists({
      _id: value.eventId,
      status: { $in: ['published', 'ongoing', 'completed'] },
    }))
  )
    throw new HttpError(400, 'Choose a published Carrot event');
}
async function storeMarketplacePhoto(req: Request): Promise<string> {
  if (!req.file) throw new HttpError(400, 'Choose a photo');
  if (!process.env['R2_PUBLIC_URL'])
    throw new HttpError(503, 'Photo storage is not configured');
  const key = R2Service.generateMediaKey(
    `marketplace/${actor(req)}/${new mongoose.Types.ObjectId()}`,
    req.file.originalname,
  );
  await R2Service.uploadBufferToR2(key, req.file.buffer, req.file.mimetype);
  return R2Service.getPublicUrl(key);
}
async function uploadMarketplacePhoto(req: Request, res: Response) {
  return ok(res, { posterUrl: await storeMarketplacePhoto(req) });
}
router.post(
  '/manage/poster',
  posterUpload.single('poster'),
  handleMulterError,
  wrap(uploadMarketplacePhoto),
);
router.get(
  '/manage/opportunities',
  wrap(async (req, res) => {
    const items = await MarketOpportunity.find(
      admin(req) ? {} : { organiserId: actor(req) },
    )
      .select('+paymentDetails')
      .sort({ createdAt: -1 })
      .lean();
    return ok(res, { items });
  }),
);
router.post(
  '/manage/opportunities',
  wrap(async (req, res) => {
    const value = validateOpportunity(req.body);
    await validateLinkedEvent(value);
    const vendor = await Vendor.findById(actor(req)).select('businessName');
    if (!vendor) throw new HttpError(401, 'Business account no longer exists');
    return ok(
      res,
      await MarketOpportunity.create({
        ...value,
        organiserId: actor(req),
        organiser: vendor.businessName,
      }),
    );
  }),
);
router.put(
  '/manage/opportunities/:id',
  wrap(async (req, res) => {
    const value = validateOpportunity(req.body);
    await validateLinkedEvent(value);
    return ok(
      res,
      await transaction(async (session) => {
        const opportunity = await managedOpportunity(
          req,
          req.params['id'],
          session,
        );
        if (opportunity.status === 'closed')
          throw new HttpError(409, 'Closed opportunities cannot be edited');
        const existing = await MarketApplication.exists({
          opportunityId: opportunity._id,
        }).session(session);
        // Accepted dates, scope and terms cannot be silently rewritten beneath applicants.
        if (existing) {
          // Older listings have no ticket quantity. An explicitly entered zero
          // records that no tickets were promised without changing existing terms.
          const previousStallTypes = opportunity.get('stallTypes').map((type: any) => {
            const plain = type.toObject ? type.toObject() : { ...type };
            if (plain.ticketsIncluded === undefined) plain.ticketsIncluded = 0;
            return plain;
          });
          for (const key of [
            'eventId',
            'dates',
            'scope',
            'currency',
            'feeTiers',
            'optionalCharges',
            'paymentDeadline',
            'cancellationTerms',
            'stallTypes',
            'stall',
            'requiredCertificates',
            'foodCertificates',
          ]) {
            if (
              JSON.stringify(key === 'stallTypes' ? previousStallTypes : opportunity.get(key)) !==
              JSON.stringify(value[key])
            )
              throw new HttpError(
                409,
                `${key} cannot change after applications have been submitted. Create another opportunity for different terms.`,
              );
          }
        }
        opportunity.set(value);
        opportunity.revision += 1;
        await opportunity.save({ session });
        return opportunity;
      }),
    );
  }),
);
router.patch(
  '/manage/opportunities/:id/application-deadline',
  wrap(async (req, res) => {
    const { applicationDeadline, paymentDeadline } = validate<{ applicationDeadline: Date; paymentDeadline: Date }>(
      Joi.object({ applicationDeadline: Joi.date().iso().required(), paymentDeadline: Joi.date().iso().required() }), req.body,
    );
    return ok(res, await transaction(async (session) => {
      const opportunity = await managedOpportunity(req, req.params['id'], session);
      if (opportunity.status === 'closed')
        throw new HttpError(409, 'Closed opportunities cannot be reopened');
      const now = new Date();
      if (applicationDeadline <= now)
        throw new HttpError(400, 'Choose a future application deadline');
      validateDeadlineTradingDates(applicationDeadline, opportunity.dates);
      validatePaymentDeadline(applicationDeadline, paymentDeadline, opportunity.dates);
      opportunity.applicationDeadline = applicationDeadline;
      opportunity.paymentDeadline = paymentDeadline;
      opportunity.revision += 1;
      await opportunity.save({ session });
      return opportunity;
    }));
  }),
);
router.patch(
  '/manage/opportunities/:id/status',
  wrap(async (req, res) => {
    const body = validate(
      Joi.object({
        status: Joi.string().valid('published', 'paused', 'closed').required(),
      }),
      req.body,
    );
    return ok(
      res,
      await transaction(async (session) => {
        const opportunity = await managedOpportunity(
          req,
          req.params['id'],
          session,
        );
        if (opportunity.status === 'closed')
          throw new HttpError(409, 'Closed opportunities cannot be reopened');
        if (body.status === 'published') {
          const fields = opportunity.toObject();
          validateOpportunity(
            Object.fromEntries(
              Object.keys(opportunitySchema.describe().keys!).map((key) => [
                key,
                key === 'eventId'
                  ? fields.eventId?.toString()
                  : (fields as any)[key],
              ]),
            ),
          );
          if (
            !opportunity.applicationDeadline ||
            opportunity.applicationDeadline <= new Date()
          )
            throw new HttpError(
              400,
              'Update the application deadline before publishing',
            );
        }
        opportunity.status = body.status;
        opportunity.revision += 1;
        await opportunity.save({ session });
        return opportunity;
      }),
    );
  }),
);
router.get(
  '/manage/opportunities/:id/applications',
  wrap(async (req, res) => {
    const opportunity = await managedOpportunity(req, req.params['id']);
    const items = await MarketApplication.find({
      opportunityId: opportunity._id,
    })
      .sort({ scopeKey: 1, createdAt: 1 })
      .lean();
    const certificateIds = items.flatMap((a) => a.certificates);
    const certificates = await MarketCertificate.find({
      _id: { $in: certificateIds },
    }).lean();
    return ok(res, { items, certificates });
  }),
);
router.patch(
  '/manage/applications/:id',
  wrap(async (req, res) => {
    const body = validate(
      Joi.object({
        status: Joi.string().valid('approved', 'declined'),
        paymentStatus: Joi.string().valid('due', 'paid', 'refunded', 'waived'),
        message: Joi.string().trim().max(2000).allow(''),
      }).or('status', 'paymentStatus'),
      req.body,
    );
    const result = await transaction(async (session) => {
      const app = await MarketApplication.findById(
        id(req.params['id']),
      ).session(session);
      if (!app) throw new HttpError(404, 'Application not found');
      const opportunity = await managedOpportunity(
        req,
        String(app.opportunityId),
        session,
      );
      if (app.status !== 'pending' && body.status && app.status !== body.status)
        throw new HttpError(409, 'This application has already been decided');
      if (
        body.paymentStatus &&
        app.status !== 'approved' &&
        body.status !== 'approved'
      )
        throw new HttpError(
          409,
          'Only approved applications have payment status',
        );
      if (body.status === 'approved' && app.status !== 'approved') {
        const certificates = await MarketCertificate.find({
          _id: { $in: app.certificates },
        })
          .session(session)
          .lean();
        const problems = certificateProblems(
          app.profile,
          certificates,
          opportunity,
        );
        if (problems.length) throw new HttpError(422, problems.join('; '));
        await ensureStallSpace(opportunity, app.stallType, app.scopeKey, session);
        app.paymentStatus = app.terms.stallFee ? 'due' : 'waived';
      }
      const changed =
        (body.status && body.status !== app.status) ||
        (body.paymentStatus && body.paymentStatus !== app.paymentStatus) ||
        (body.message !== undefined && body.message !== app.message);
      if (body.status) {
        app.status = body.status;
        app.active = body.status !== 'declined';
      }
      if (body.paymentStatus) app.paymentStatus = body.paymentStatus;
      if (body.message !== undefined) app.message = body.message;
      opportunity.revision += 1;
      await opportunity.save({ session });
      await app.save({ session });
      if (changed)
        await NotificationService.create(
          await Buyer.exists({ _id: app.ownerId }).session(session) ? 'buyer' : 'vendor',
          String(app.ownerId),
          'market_application',
          'Market application updated',
          `${opportunity.name}: ${app.status}; payment ${app.paymentStatus}. ${app.message || ''}`.slice(
            0,
            300,
          ),
          {
            opportunityId: String(opportunity._id),
            applicationId: String(app._id),
            url: '/services?tab=applications',
          },
          session,
        );
      return app;
    });
    return ok(res, result);
  }),
);
export default router;
