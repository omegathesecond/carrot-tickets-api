import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import Joi from 'joi';
import {
  authenticateTickets,
  requireTicketsOwner,
} from '@middleware/ticketsAuth.middleware';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { HttpError } from '@utils/httpError.util';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { R2Service } from '@utils/r2.service';
import { posterUpload, handleMulterError } from '@middleware/media.middleware';
import { ServiceCategoryService } from '@services/serviceCategory.service';
import { ServiceCategory } from '@models/serviceCategory.model';
import { NotificationService } from '@services/notification.service';
import {
  MarketApplication,
  MarketCertificate,
  MarketOpportunity,
  MarketPreference,
  MarketProfile,
  ensureMarketplaceIndexes,
} from './models';
import {
  AVAILABILITY,
  CERTIFICATE_TYPES,
  MARKET_TYPES,
  REGIONS,
  certificateProblems,
  idSchema,
  profileSchema,
  opportunitySchema,
  validate,
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
const actor = (req: Request) => String((req as any).ticketsUser.vendorId);
const admin = (req: Request) => (req as any).ticketsUser.isSuperAdmin === true;
const id = (value: unknown): string => validate(idSchema, value);
const ok = (res: Response, data: unknown) =>
  ApiResponseUtil.success(res, data, 'Marketplace');
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
  const opportunity = await MarketOpportunity.findOne(query).session(
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
router.get('/options', wrap(async (_req, res) =>
  ok(res, {
    categories: await ServiceCategoryService.listActive(),
    marketTypes: MARKET_TYPES,
    availability: AVAILABILITY,
    certificateTypes: CERTIFICATE_TYPES,
    regions: REGIONS,
  }),
));
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
    const vendor = await Vendor.findById(actor(req)).select('serviceCategories').lean();
    if (!vendor) throw new HttpError(404, 'Provider not found');
    const selected = vendor.serviceCategories ?? [];
    // Marketplace accepts category names as well as stable service identifiers.
    // Resolve current labels from the same catalogue used during signup.
    const categories = await ServiceCategory.find({ value: { $in: selected } })
      .select('label').lean();
    const terms = [...new Set([...selected, ...categories.map((c) => c.label)])];
    filter.$and = [{ categories: { $in: terms.map((term) => new RegExp('^' + literal(term) + '$', 'i')) } }];
  }
  if (q.maxFee !== undefined || q.minFee !== undefined) {
    if (!q.currency)
      throw new HttpError(400, 'Select a currency when filtering stall fees');
    filter.stallFee = {
      ...(q.maxFee !== undefined ? { $lte: q.maxFee } : {}),
      ...(q.minFee !== undefined ? { $gte: q.minFee } : {}),
    };
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
    { $unset: ['approvals', '__v', 'revision'] },
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
    const counts = await MarketApplication.aggregate([
      { $match: { opportunityId: opportunity._id, status: 'approved' } },
      { $group: { _id: '$scopeKey', count: { $sum: 1 } } },
    ]);
    return ok(res, {
      ...opportunity,
      approvedByScope: Object.fromEntries(counts.map((c) => [c._id, c.count])),
    });
  }),
);
// All provider and organiser mutations require a live vendor-owner session.
// Sales/scanner/sub-user tokens cannot access private applications or files.
router.use(authenticateTickets, requireTicketsOwner);
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!(req as any).ticketsUser.vendorId)
    return ApiResponseUtil.unauthorized(res, 'A business session is required');
  return next();
});
router.get('/matched-opportunities', listOpportunities);
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
    const file = Buffer.from(value.file, 'base64');
    if (file.length > 5 * 1024 * 1024 || file.length === 0)
      throw new HttpError(400, 'Certificate must be between 1 byte and 5 MB');
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
router.get(
  '/applications',
  wrap(async (req, res) => {
    const items = await MarketApplication.find({ ownerId: actor(req) })
      .populate('opportunityId', 'name dates scope location status')
      .sort({ createdAt: -1 })
      .lean();
    return ok(res, { items });
  }),
);
router.post(
  '/opportunities/:id/apply',
  wrap(async (req, res) => {
    const body = validate(
      Joi.object({
        profileId: idSchema,
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
      const approved = await MarketApplication.countDocuments({
        opportunityId: opportunity._id,
        scopeKey,
        status: 'approved',
      }).session(session);
      if (opportunity.capacity && approved >= opportunity.capacity)
        throw new HttpError(409, 'This trading date is full');
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
            profile,
            certificates: certificates
              .filter((c) => relevant.has(c.type))
              .map((c) => c._id),
            note: body.note,
            terms: {
              stallFee: opportunity.stallFee,
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
      return doc!;
    });
    return ok(res, application);
  }),
);
// Resolve the current account, rather than trusting a client role or stale token.
router.use("/manage", (req, res, next) =>
  wrap(async () => {
    const vendor = await Vendor.findById(actor(req)).select("operatorType");
    if (!vendor) throw new HttpError(401, "Business account no longer exists");
    if (!admin(req) && !["events", "both"].includes(vendor.operatorType))
      throw new HttpError(
        403,
        "Only organisers can manage stall opportunities",
      );
    // The wrapper handles failures using the normal API error response.
    return next();
  })(req, res),
);
// Publicly listed Carrot events may be linked without transferring ownership.
async function validateLinkedEvent(value: { eventId?: string | null }) {
  if (value.eventId && !await Event.exists({ _id: value.eventId, status: { $in: ['published', 'ongoing', 'completed'] } }))
    throw new HttpError(400, 'Choose a published Carrot event');
}
router.post('/manage/poster', posterUpload.single('poster'), handleMulterError, wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose an event poster');
  if (!process.env['R2_PUBLIC_URL']) throw new HttpError(503, 'Poster storage is not configured');
  const key = R2Service.generateMediaKey(`marketplace/${actor(req)}/${new mongoose.Types.ObjectId()}`, req.file.originalname);
  await R2Service.uploadBufferToR2(key, req.file.buffer, req.file.mimetype);
  return ok(res, { posterUrl: R2Service.getPublicUrl(key) });
}));
router.get(
  '/manage/opportunities',
  wrap(async (req, res) => {
    const items = await MarketOpportunity.find(
      admin(req) ? {} : { organiserId: actor(req) },
    )
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
          for (const key of [
            'eventId',
            'dates',
            'scope',
            'stallFee',
            'currency',
            'feeTiers',
            'optionalCharges',
            'paymentDeadline',
            'cancellationTerms',
            'stallSizes',
            'stall',
            'requiredCertificates',
            'foodCertificates',
          ]) {
            if (
              JSON.stringify(opportunity.get(key)) !==
              JSON.stringify(value[key])
            )
              throw new HttpError(
                409,
                `${key} cannot change after applications have been submitted. Create another opportunity for different terms.`,
              );
          }
          if (value.capacity) {
            const counts = await MarketApplication.aggregate([
              {
                $match: { opportunityId: opportunity._id, status: 'approved' },
              },
              { $group: { _id: '$scopeKey', count: { $sum: 1 } } },
            ]).session(session);
            if (counts.some((c) => c.count > value.capacity))
              throw new HttpError(
                409,
                'Capacity cannot be lower than the approved provider count',
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
                key === 'eventId' ? fields.eventId?.toString() : (fields as any)[key],
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
        const count = await MarketApplication.countDocuments({
          opportunityId: opportunity._id,
          scopeKey: app.scopeKey,
          status: 'approved',
        }).session(session);
        if (opportunity.capacity && count >= opportunity.capacity)
          throw new HttpError(409, 'This trading date is full');
        app.paymentStatus = opportunity.stallFee ? 'due' : 'waived';
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
          'vendor',
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
