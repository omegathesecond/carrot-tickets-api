import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import router from '../routes';
import {
  MarketApplication,
  MarketCertificate,
  MarketOpportunity,
  MarketProfile,
} from '../models';
import { Notification } from '@models/notification.model';
import { NotificationService } from '@services/notification.service';
import { Vendor } from '@models/vendor.model';
import {
  connectLedgerTestDb,
  clearTestDb,
  disconnectTestDb,
} from '../../__tests__/helpers/mongo';
import { TicketsAuthService } from '@services/ticketsAuth.service';

jest.mock('@services/ticketsAuth.service', () => ({
  TicketsAuthService: { verifyAndResolveSession: jest.fn() },
  SessionAuthError: class extends Error {},
}));
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/marketplace', router);
const organiser = new mongoose.Types.ObjectId();
const provider = new mongoose.Types.ObjectId();
const stranger = new mongoose.Types.ObjectId();
const endpoint = '/api/marketplace';
const profile = {
  businessName: 'Craft studio',
  contactName: 'A Provider',
  email: 'provider@example.com',
  phone: '+26878422613',
  country: 'ZA',
  regions: ['Gauteng'],
  categories: ['Crafts'],
  currentMarkets: 'City market',
  desiredMarkets: 'Night market',
  marketTypes: ['Night Markets'],
  availability: ['Saturdays'],
  stall: {
    size: '2 × 2 m',
    power: true,
    water: false,
    shelter: true,
    ownGazebo: false,
  },
  sellsFood: false,
};
const opportunity = {
  name: 'Summer market',
  location: 'Mbabane',
  country: 'SZ',
  description: 'Local makers welcome.',
  marketType: 'Weekly Markets',
  categories: ['Crafts'],
  availability: ['Saturdays'],
  dates: ['2099-11-18', '2099-11-25'],
  scope: 'date',
  applicationDeadline: '2099-11-10T12:00:00Z',
  paymentDeadline: '2099-11-12T12:00:00Z',
  capacity: 1,
  stallSizes: ['2 × 2 m', '3 × 3 m'],
  stall: profile.stall,
  currency: 'SZL',
  stallFee: 100,
  feeTiers: [],
  optionalCharges: [],
  cancellationTerms: 'Refund before deadline.',
  requiredCertificates: [],
  foodCertificates: [],
};
const auth = (req: request.Test, who: mongoose.Types.ObjectId = provider) =>
  req.set('Authorization', 'Bearer ' + who);
const createProfile = async (who = provider, overrides = {}) => {
  const res = await auth(request(app).post(endpoint + '/profiles'), who).send({
    ...profile,
    ...overrides,
  });
  expect(res.status).toBe(200);
  return res.body.data._id as string;
};
const createOpportunity = async (overrides = {}) => {
  const res = await auth(
    request(app).post(endpoint + '/manage/opportunities'),
    organiser,
  ).send({ ...opportunity, ...overrides });
  expect(res.status).toBe(200);
  const marketId = res.body.data._id as string;
  const publish = await auth(
    request(app).patch(
      endpoint + '/manage/opportunities/' + marketId + '/status',
    ),
    organiser,
  ).send({ status: 'published' });
  expect(publish.status).toBe(200);
  return marketId;
};
const apply = (
  marketId: string,
  profileId: string,
  date = '2099-11-18',
  who = provider,
  extra = {},
) =>
  auth(
    request(app).post(endpoint + '/opportunities/' + marketId + '/apply'),
    who,
  ).send({ profileId, date, ...extra });
const upload = (profileId: string, expiresAt = '2099-11-19', who = provider) =>
  auth(
    request(app).post(endpoint + '/profiles/' + profileId + '/certificates'),
    who,
  ).send({
    type: 'coa',
    name: 'private.pdf',
    mime: 'application/pdf',
    file: Buffer.from('%PDF-1.7 test certificate').toString('base64'),
    expiresAt,
  });

beforeAll(connectLedgerTestDb, 120000);
afterEach(async () => {
  await clearTestDb();
  jest.restoreAllMocks();
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  jest
    .mocked(TicketsAuthService.verifyAndResolveSession)
    .mockImplementation(async (token: string) => ({
      vendorId: token,
      userId: token,
      userType: token === 'sub-user' ? 'sub-user' : 'vendor',
      isSuperAdmin: token === String(stranger),
    }));
  await Vendor.collection.insertMany([
    { _id: organiser, businessName: 'Market organiser', slug: 'organiser' },
    { _id: provider, businessName: 'Provider', slug: 'provider' },
    { _id: stranger, businessName: 'Admin', slug: 'admin' },
  ]);
});
it('publishes, searches literal text, filters fees and dates and sorts by the next trading date', async () => {
  const first = await createOpportunity();
  await createOpportunity({
    name: 'Earlier',
    dates: ['2099-10-10'],
    applicationDeadline: '2099-10-01',
    paymentDeadline: '2099-10-02',
    stallFee: 50,
  });
  const list = await request(app).get(endpoint + '/opportunities');
  expect(list.status).toBe(200);
  expect(list.body.data.items.map((x: any) => x.name)).toEqual([
    'Earlier',
    'Summer market',
  ]);
  const filtered = await request(app)
    .get(endpoint + '/opportunities')
    .query({
      date: '2099-11-18',
      currency: 'SZL',
      minFee: 75,
      maxFee: 150,
      category: 'Crafts',
      availability: 'Saturdays',
      available: true,
    });
  expect(filtered.body.data.items.map((x: any) => x._id)).toEqual([first]);
  const literal = await request(app)
    .get(endpoint + '/opportunities')
    .query({ search: '.*' });
  expect(literal.body.data.items).toEqual([]);
  expect(
    (
      await request(app)
        .get(endpoint + '/opportunities')
        .query({ maxFee: 100 })
    ).status,
  ).toBe(400);
});
it('keeps an opportunity available when a later trading date has capacity', async () => {
  const marketId = await createOpportunity();
  const profileId = await createProfile();
  const approve = async (date: string) => {
    const application = await apply(marketId, profileId, date);
    expect(application.status).toBe(200);
    const reviewed = await auth(
      request(app).patch(endpoint + '/manage/applications/' + application.body.data._id),
      organiser,
    ).send({ status: 'approved' });
    expect(reviewed.status).toBe(200);
  };
  const available = async (date?: string) => {
    const response = await request(app).get(endpoint + '/opportunities')
      .query({ available: true, ...(date ? { date } : {}) });
    expect(response.status).toBe(200);
    return response.body.data.items;
  };
  await approve('2099-11-18');
  const items = await available();
  expect(items.map((item: any) => item._id)).toEqual([marketId]);
  expect(items[0]).toMatchObject({ nextTradingDate: '2099-11-18', approvedProviders: 1, remainingCapacity: 0 });
  expect(await available('2099-11-18')).toHaveLength(0);
  expect(await available('2099-11-25')).toHaveLength(1);
  await approve('2099-11-25');
  expect(await available()).toHaveLength(0);
});
it('enforces profile ownership and private document access, including authorised admins', async () => {
  const profileId = await createProfile();
  const uploaded = await upload(profileId);
  expect(uploaded.status).toBe(200);
  const certificateId = uploaded.body.data._id;
  expect(
    (await request(app).get(endpoint + '/certificates/' + certificateId))
      .status,
  ).toBe(401);
  expect(
    (
      await auth(
        request(app).get(endpoint + '/certificates/' + certificateId),
        organiser,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await auth(
        request(app).get(endpoint + '/certificates/' + certificateId),
        stranger,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await auth(
        request(app).put(endpoint + '/profiles/' + profileId),
        organiser,
      ).send(profile)
    ).status,
  ).toBe(404);
  const profiles = await auth(request(app).get(endpoint + '/profiles'));
  expect(profiles.body.data.certificates[0].file).toBeUndefined();
  expect(
    (await auth(request(app).get(endpoint + '/profiles'), organiser)).body.data
      .items,
  ).toEqual([]);
});
it('uses an immutable application snapshot, permits per-market adjustments and blocks duplicate active applications per date', async () => {
  const profileId = await createProfile();
  const marketId = await createOpportunity();
  const response = await apply(marketId, profileId, '2099-11-18', provider, {
    overrides: { ...profile, contactName: 'Market contact' },
  });
  expect(response.status).toBe(200);
  expect(response.body.data.profile.contactName).toBe('Market contact');
  expect((await MarketProfile.findById(profileId))!.contactName).toBe(
    'A Provider',
  );
  const duplicate = await Promise.all([
    apply(marketId, profileId),
    apply(marketId, profileId),
  ]);
  expect(duplicate.map((r) => r.status)).toEqual([409, 409]);
  expect((await apply(marketId, profileId, '2099-11-25')).status).toBe(200);
  expect((await apply(marketId, profileId, '2099-12-01')).status).toBe(400);
  expect(
    (await apply(marketId, profileId, '2099-11-25', organiser)).status,
  ).toBe(404);
  const applications = await auth(request(app).get(endpoint + '/applications'));
  expect(applications.body.data.items).toHaveLength(2);
  expect(applications.body.data.items[0].opportunityId.name).toBe(
    'Summer market',
  );
});
it('shows actionable missing/expired certificate errors and attaches only relevant private documents', async () => {
  const profileId = await createProfile(provider, { sellsFood: true });
  const marketId = await createOpportunity({ foodCertificates: ['coa'] });
  const missing = await apply(marketId, profileId);
  expect(missing.status).toBe(422);
  expect(missing.body.message).toContain('certificates.coa');
  await upload(profileId, '2000-01-01');
  expect((await apply(marketId, profileId)).body.message).toContain('expired');
  const replacement = await upload(profileId);
  expect(replacement.status).toBe(200);
  expect(
    await MarketCertificate.countDocuments({ profileId, active: true }),
  ).toBe(1);
  const applied = await apply(marketId, profileId);
  expect(applied.status).toBe(200);
  expect(applied.body.data.certificates).toEqual([replacement.body.data._id]);
  expect(
    (
      await auth(
        request(app).get(
          endpoint + '/certificates/' + replacement.body.data._id,
        ),
        organiser,
      )
    ).status,
  ).toBe(200);
  // Profile replacement/removal cannot mutate the certificate version already submitted.
  await upload(profileId, '2099-12-01');
  await auth(
    request(app).delete(
      endpoint + '/certificates/' + replacement.body.data._id,
    ),
  );
  expect(
    (
      await auth(
        request(app).get(
          endpoint + '/certificates/' + replacement.body.data._id,
        ),
        organiser,
      )
    ).status,
  ).toBe(200);
});
it('prevents capacity oversubscription under concurrent approval and atomically notifies providers', async () => {
  const marketId = await createOpportunity();
  const first = await createProfile();
  const second = await createProfile(provider, {
    businessName: 'Second studio',
  });
  const a = await apply(marketId, first);
  const b = await apply(marketId, second);
  const review = (applicationId: string) =>
    auth(
      request(app).patch(endpoint + '/manage/applications/' + applicationId),
      organiser,
    ).send({ status: 'approved', message: 'Welcome' });
  const results = await Promise.all([
    review(a.body.data._id),
    review(b.body.data._id),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await MarketApplication.countDocuments({ status: 'approved' })).toBe(
    1,
  );
  expect(
    await Notification.countDocuments({ type: 'market_application' }),
  ).toBe(1);
  const approved = await MarketApplication.findOne({ status: 'approved' });
  expect(approved!.paymentStatus).toBe('due');
  const paid = await auth(
    request(app).patch(endpoint + '/manage/applications/' + approved!._id),
    organiser,
  ).send({ paymentStatus: 'paid' });
  expect(paid.status).toBe(200);
  expect(
    await Notification.countDocuments({ type: 'market_application' }),
  ).toBe(2);
  const publicList = await request(app)
    .get(endpoint + '/opportunities')
    .query({ available: true, date: '2099-11-18' });
  expect(publicList.body.data.items).toHaveLength(0);
  const detail = await request(app).get(
    endpoint + '/opportunities/' + marketId,
  );
  expect(detail.body.data.approvedByScope['2099-11-18']).toBe(1);
});
it('does not let foreign organisers review or change decisions, and allows reapplication after decline', async () => {
  const marketId = await createOpportunity();
  const profileId = await createProfile();
  const applied = await apply(marketId, profileId);
  expect(
    (
      await auth(
        request(app).get(
          endpoint + '/manage/opportunities/' + marketId + '/applications',
        ),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await auth(
        request(app).patch(
          endpoint + '/manage/applications/' + applied.body.data._id,
        ),
      ).send({ status: 'approved' })
    ).status,
  ).toBe(404);
  const decline = await auth(
    request(app).patch(
      endpoint + '/manage/applications/' + applied.body.data._id,
    ),
    organiser,
  ).send({ status: 'declined', message: 'Please reapply' });
  expect(decline.status).toBe(200);
  expect((await apply(marketId, profileId)).status).toBe(200);
});
it('enforces pause, close, deadlines, regular trader scope and immutable terms after submission', async () => {
  const profileId = await createProfile();
  const marketId = await createOpportunity({ scope: 'regular' });
  expect((await apply(marketId, profileId)).body.data.scopeKey).toBe('regular');
  expect((await apply(marketId, profileId, '2099-11-25')).status).toBe(409);
  const edit = await auth(
    request(app).put(endpoint + '/manage/opportunities/' + marketId),
    organiser,
  ).send({ ...opportunity, scope: 'regular', stallFee: 999 });
  expect(edit.status).toBe(409);
  const permittedEdit = await auth(
    request(app).put(endpoint + '/manage/opportunities/' + marketId),
    organiser,
  ).send({
    ...opportunity,
    scope: 'regular',
    description: 'Updated description',
  });
  expect(permittedEdit.status).toBe(200);
  const nextProfile = await createProfile(provider, {
    businessName: 'Third studio',
  });
  await auth(
    request(app).patch(
      endpoint + '/manage/opportunities/' + marketId + '/status',
    ),
    organiser,
  ).send({ status: 'paused' });
  expect((await apply(marketId, nextProfile)).status).toBe(409);
  expect(
    (await request(app).get(endpoint + '/opportunities')).body.data.items,
  ).toEqual([]);
  await auth(
    request(app).patch(
      endpoint + '/manage/opportunities/' + marketId + '/status',
    ),
    organiser,
  ).send({ status: 'published' });
  await MarketOpportunity.updateOne(
    { _id: marketId },
    { applicationDeadline: new Date('2000-01-01') },
  );
  expect((await apply(marketId, nextProfile)).status).toBe(409);
  await auth(
    request(app).patch(
      endpoint + '/manage/opportunities/' + marketId + '/status',
    ),
    organiser,
  ).send({ status: 'closed' });
  expect(
    (
      await auth(
        request(app).patch(
          endpoint + '/manage/opportunities/' + marketId + '/status',
        ),
        organiser,
      ).send({ status: 'published' })
    ).status,
  ).toBe(409);
});
it('rejects unknown input, invalid regions, forged file types, missing authentication and sub-user tokens', async () => {
  expect(
    (
      await request(app)
        .post(endpoint + '/profiles')
        .send(profile)
    ).status,
  ).toBe(401);
  expect(
    (
      await request(app)
        .get(endpoint + '/profiles')
        .set('Authorization', 'Bearer sub-user')
    ).status,
  ).toBe(403);
  expect(
    (
      await auth(request(app).post(endpoint + '/profiles')).send({
        ...profile,
        regions: ['Hhohho'],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await auth(request(app).post(endpoint + '/profiles')).send({
        ...profile,
        ownerId: String(organiser),
      })
    ).status,
  ).toBe(400);
  const profileId = await createProfile();
  expect(
    (
      await auth(request(app).put(endpoint + '/default-profile')).send({
        profileId,
      })
    ).status,
  ).toBe(200);
  expect(
    (await auth(request(app).get(endpoint + '/profiles'))).body.data
      .defaultProfileId,
  ).toBe(profileId);
  const fake = await auth(
    request(app).post(endpoint + '/profiles/' + profileId + '/certificates'),
  ).send({
    type: 'coa',
    name: 'evil.pdf',
    mime: 'application/pdf',
    file: Buffer.from('<html>bad</html>').toString('base64'),
  });
  expect(fake.status).toBe(400);
});

it('rolls back an approval if its notification fails instead of reporting success', async () => {
  const marketId = await createOpportunity();
  const profileId = await createProfile();
  const applied = await apply(marketId, profileId);
  const notification = jest
    .spyOn(NotificationService, 'create')
    .mockRejectedValueOnce(new Error('Notification storage unavailable'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const response = await auth(
    request(app).patch(
      endpoint + '/manage/applications/' + applied.body.data._id,
    ),
    organiser,
  ).send({ status: 'approved' });
  expect(response.status).toBe(500);
  expect(
    (await MarketApplication.findById(applied.body.data._id))!.status,
  ).toBe('pending');
  expect(await Notification.countDocuments()).toBe(0);
  expect(log).toHaveBeenCalled();
  notification.mockRestore();
  log.mockRestore();
});
