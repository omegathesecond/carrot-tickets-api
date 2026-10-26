import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import router from '../eventPayout.route';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import {
  EventPayoutService,
  payoutBreakdown,
} from '@services/eventPayout.service';
import { NotificationService } from '@services/notification.service';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventPayout, PayoutBank } from '@models/eventPayout.model';
import { OrganizerPayout } from '@models/organizerPayout.model';
import { Notification } from '@models/notification.model';
import {
  connectLedgerTestDb,
  clearTestDb,
  disconnectTestDb,
} from '../../__tests__/helpers/db';
import {
  validatePayoutBank,
  maskPayoutBank,
  encryptPayoutBank,
  decryptPayoutBank,
} from '@utils/payoutBank.util';

const app = express();
app.use(express.json());
app.use('/payouts', router);
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(500).json({ message: err.message }),
);
const vendorId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const bank = {
  country: 'Eswatini',
  bank: 'Test Bank',
  accountType: 'Current',
  branchCode: '123456',
  accountHolder: 'Event Organizer',
  accountNumber: '012345678901',
};
const auth = (token = 'owner') => ({ Authorization: `Bearer ${token}` });
let eventId: string;
const endpoint = () => `/payouts/events/${eventId}`;
const submit = (extra = {}) =>
  request(app)
    .post(endpoint())
    .set(auth())
    .send({ bank, saveBank: true, expectedAmount: 90, ...extra });

beforeAll(async () => {
  await connectLedgerTestDb();
  jest.spyOn(TicketsAuthService, 'verifyAndResolveSession').mockImplementation(
    async (token: string) =>
      ({
        vendorId: String(token === 'other' ? otherId : vendorId),
        userId: String(otherId),
        userType: token === 'staff' ? 'sub-user' : 'vendor',
        isSuperAdmin: token === 'admin',
        permissions: [],
      }) as any,
  );
}, 60000);
afterAll(async () => {
  jest.restoreAllMocks();
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearTestDb();
  await Vendor.collection.insertOne({
    _id: vendorId,
    businessName: 'Organizer',
  });
  const event = await Event.create({
    vendorId,
    name: 'Ended Festival',
    venue: 'Grounds',
    eventDate: new Date('2020-01-01'),
    startTime: new Date('2020-01-01'),
    endTime: new Date('2020-01-02'),
    currency: 'SZL',
  });
  eventId = String(event._id);
  await sale();
});
async function sale(extra = {}) {
  return TicketSale.create({
    eventId,
    vendorId,
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    soldBy: vendorId,
    soldByType: 'Vendor',
    paymentMethod: 'cash',
    paymentStatus: 'completed',
    totalAmount: 100,
    faceAmount: 100,
    platformFeeAmount: 10,
    resellerCommissionAmount: 0,
    organizerProceeds: 90,
    fundsCustody: 'carrot',
    ...extra,
  });
}
async function createRequest() {
  const response = await submit();
  expect(response.status).toBe(201);
  return response.body.data._id as string;
}
async function decide(id: string, status: string, extra = {}) {
  return request(app)
    .post(`/payouts/${id}/status`)
    .set(auth('admin'))
    .send({ status, ...extra });
}

it('requires authentication, ownership and owner access for bank and event requests', async () => {
  expect((await request(app).get(endpoint())).status).toBe(401);
  expect((await request(app).get(endpoint()).set(auth('other'))).status).toBe(
    404,
  );
  expect((await request(app).get(endpoint()).set(auth('staff'))).status).toBe(
    403,
  );
  expect(
    (await request(app).get('/payouts/bank').set(auth('staff'))).status,
  ).toBe(403);
  expect((await request(app).get('/payouts').set(auth())).status).toBe(403);
});
it('disables before event end, pending sales, zero balance, and validates fields without leaking them', async () => {
  await Event.updateOne({ _id: eventId }, { endTime: new Date('2999-01-01') });
  expect((await submit()).status).toBe(409);
  await Event.updateOne({ _id: eventId }, { endTime: new Date('2020-01-02') });
  await TicketSale.updateMany({}, { paymentStatus: 'pending' });
  expect((await submit()).status).toBe(409);
  await TicketSale.updateMany({}, { paymentStatus: 'completed' });
  const invalid = await submit({
    bank: { ...bank, accountNumber: 'private-invalid-number' },
  });
  expect(invalid.status).toBe(400);
  expect(JSON.stringify(invalid.body)).not.toContain('private-invalid-number');
  expect((await submit({ expectedAmount: 89 })).status).toBe(409);
});
it('encrypts saved/snapshot bank details and returns masked fields except to reviewing admins', async () => {
  const id = await createRequest();
  const raw = await EventPayout.collection.findOne({
    _id: new mongoose.Types.ObjectId(id),
  });
  expect(JSON.stringify(raw)).not.toContain(bank.accountNumber);
  const savedRaw = await PayoutBank.collection.findOne({ vendorId });
  expect(JSON.stringify(savedRaw)).not.toContain(bank.accountNumber);
  const owner = await request(app).get(endpoint()).set(auth());
  expect(owner.body.data.requests[0].bank.accountNumber).toBe('••••8901');
  expect(JSON.stringify(owner.body)).not.toContain('bankEncrypted');
  expect((await request(app).get(`/payouts/${id}`).set(auth())).status).toBe(
    403,
  );
  const admin = await request(app).get(`/payouts/${id}`).set(auth('admin'));
  expect(admin.headers['cache-control']).toBe('no-store');
  expect(admin.body.data.bank.accountNumber).toBe(bank.accountNumber);
  expect(admin.body.data).not.toHaveProperty('bankEncrypted');
  const list = await request(app).get('/payouts').set(auth('admin'));
  expect(list.body.data.items[0].bank.accountNumber).toBe('••••8901');
});
it('serializes concurrent submissions and leaves one active request', async () => {
  const responses = await Promise.all([submit(), submit()]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(await EventPayout.countDocuments({ active: true })).toBe(1);
});
it('prevents approval/paid transitions out of order and records notification, audit, date and reference', async () => {
  const id = await createRequest();
  expect(
    (
      await decide(id, 'paid', {
        paidAt: new Date().toISOString(),
        paymentReference: 'EFT1',
        paymentCompleted: true,
      })
    ).status,
  ).toBe(409);
  expect((await decide(id, 'approved', { note: 'Reviewed' })).status).toBe(200);
  expect((await submit()).status).toBe(409);
  expect((await decide(id, 'approved')).status).toBe(409);
  expect((await decide(id, 'paid')).status).toBe(400);
  expect(
    (
      await decide(id, 'paid', {
        paidAt: '2999-01-01',
        paymentReference: 'EFT1',
        paymentCompleted: true,
      })
    ).status,
  ).toBe(400);
  const paidAt = new Date().toISOString();
  const paid = await decide(id, 'paid', {
    paidAt,
    paymentReference: 'EFT1',
    paymentCompleted: true,
  });
  expect(paid.status).toBe(200);
  expect(paid.body.data).toMatchObject({
    status: 'paid',
    paidAt,
    paymentReference: 'EFT1',
    active: false,
  });
  expect(paid.body.data.history.map((h: any) => h.status)).toEqual([
    'pending',
    'approved',
    'paid',
  ]);
  expect(
    await Notification.countDocuments({
      recipientId: vendorId,
      type: 'payout_status',
    }),
  ).toBe(2);
  expect((await submit()).status).toBe(409);
  expect((await decide(id, 'declined')).status).toBe(409);
});
it('declines with a note, permits secure reuse or replacement, and preserves immutable snapshots', async () => {
  const id = await createRequest();
  expect(
    (await decide(id, 'declined', { note: 'Please check the bank' })).status,
  ).toBe(200);
  const saved = (await request(app).get('/payouts/bank').set(auth())).body.data;
  expect(saved.accountNumber).toBe('••••8901');
  expect(
    (await submit({ useSaved: true, bankVersion: 'outdated' })).status,
  ).toBe(409);
  const reused = await submit({
    bank: undefined,
    useSaved: true,
    bankVersion: saved.version,
  });
  expect(reused.status).toBe(201);
  await decide(reused.body.data._id, 'declined');
  const replaced = await submit({
    bank: { ...bank, accountNumber: '9876543210' },
  });
  expect(replaced.status).toBe(201);
  expect(
    (await request(app).get(`/payouts/${id}`).set(auth('admin'))).body.data.bank
      .accountNumber,
  ).toBe(bank.accountNumber);
  expect((await request(app).delete('/payouts/bank').set(auth())).status).toBe(
    200,
  );
  expect(
    (await request(app).get('/payouts/bank').set(auth())).body.data,
  ).toBeNull();
});
it('rechecks refund deductions before approval/payment and lets admin decline an approved request', async () => {
  const id = await createRequest();
  await TicketSale.updateMany({}, { refundedAmount: 20 });
  expect((await decide(id, 'approved')).status).toBe(409);
  await TicketSale.updateMany({}, { refundedAmount: 0 });
  expect((await decide(id, 'approved')).status).toBe(200);
  await TicketSale.updateMany({}, { refundedAmount: 20 });
  expect(
    (
      await decide(id, 'paid', {
        paidAt: new Date().toISOString(),
        paymentReference: 'EFT1',
        paymentCompleted: true,
      })
    ).status,
  ).toBe(409);
  expect((await decide(id, 'declined')).status).toBe(200);
  const updated = await submit({ expectedAmount: 70 });
  expect(updated.status).toBe(201);
  expect(updated.body.data.breakdown.refunds).toBe(20);
});
it('rolls back decision when durable notification creation fails', async () => {
  const id = await createRequest();
  const mock = jest
    .spyOn(NotificationService, 'create')
    .mockRejectedValueOnce(new Error('notification storage unavailable'));
  expect((await decide(id, 'approved')).status).toBe(500);
  mock.mockRestore();
  expect((await EventPayout.findById(id))!.status).toBe('pending');
});
it('blocks sales already covered by an existing period payout', async () => {
  await OrganizerPayout.create({
    vendorId,
    periodStart: new Date('2000-01-01'),
    periodEnd: new Date('2999-01-01'),
    status: 'settled',
    proceedsOwed: 90,
    feeOwedByVendor: 0,
    availableProceeds: 90,
    netAmount: 90,
  });
  expect((await submit()).status).toBe(409);
});
it('searches and filters history, escapes regex, and rejects invalid filters', async () => {
  const id = await createRequest();
  await decide(id, 'declined');
  const filtered = await request(app)
    .get('/payouts?search=Festival&status=declined')
    .set(auth('admin'));
  expect(filtered.body.data.total).toBe(1);
  expect(
    (await request(app).get('/payouts?search=.*').set(auth('admin'))).body.data
      .total,
  ).toBe(0);
  expect(
    (await request(app).get('/payouts?status=invalid').set(auth('admin')))
      .status,
  ).toBe(400);
});
it('accounts for refunds, remitted custody, vendor fees, and prior payouts without paying pending/unremitted money', async () => {
  await TicketSale.deleteMany({});
  await sale({ refundedAmount: 20 }); // 70 available
  await sale({ fundsCustody: 'reseller', resellerRemitted: false }); // 90 withheld
  await sale({ fundsCustody: 'reseller', resellerRemitted: true }); // 90 available
  await sale({ fundsCustody: 'vendor' }); // fee 10 owed, 90 already held
  await sale({ paymentStatus: 'pending' });
  const overview = await EventPayoutService.overview(eventId, String(vendorId));
  expect(overview.breakdown).toMatchObject({
    availableBalance: 150,
    unremitted: 90,
    vendorHeld: 90,
    vendorFees: 10,
    refunds: 20,
    sales: 4,
  });
});
it('treats fully refunded sales as refunded even without a refund counter', () => {
  expect(
    payoutBreakdown(
      [
        {
          totalAmount: 100,
          organizerProceeds: 90,
          platformFeeAmount: 10,
          resellerCommissionAmount: 0,
          fundsCustody: 'carrot',
          paymentStatus: 'refunded',
        },
      ],
      0,
    ).availableBalance,
  ).toBe(-10);
});
it('fails loudly on incomplete snapshots and prevents ciphertext/account swapping', () => {
  expect(() => payoutBreakdown([{ totalAmount: 100 }], 0)).toThrow(
    'incomplete',
  );
  expect(() => validatePayoutBank({ ...bank, accountHolder: ' ' })).toThrow();
  const cipher = encryptPayoutBank(bank, String(vendorId));
  expect(decryptPayoutBank(cipher, String(vendorId))).toEqual(bank);
  expect(() => decryptPayoutBank(cipher, String(otherId))).toThrow();
});

it('deducts completed payouts and permits only newly confirmed proceeds in later requests', async () => {
  const id = await createRequest();
  await decide(id, 'approved');
  expect(
    (
      await decide(id, 'paid', {
        paidAt: new Date().toISOString(),
        paymentReference: 'FIRST',
        paymentCompleted: true,
      })
    ).status,
  ).toBe(200);
  await sale({ totalAmount: 50, organizerProceeds: 45, platformFeeAmount: 5 });
  const next = await submit({ expectedAmount: 45 });
  expect(next.status).toBe(201);
  expect(next.body.data.breakdown.previouslyPaid).toBe(90);
  expect(next.body.data.amount).toBe(45);
});
it('does not include reseller allocation resales in organiser payout funds', async () => {
  await sale({
    isAllocation: true,
    totalAmount: 1000,
    organizerProceeds: 900,
    platformFeeAmount: 100,
  });
  const overview = await EventPayoutService.overview(eventId, String(vendorId));
  expect(overview.breakdown.availableBalance).toBe(90);
  expect(overview.breakdown.sales).toBe(1);
});
it('serializes competing admin decisions and writes exactly one decision notification', async () => {
  const id = await createRequest();
  const responses = await Promise.all([
    decide(id, 'approved'),
    decide(id, 'declined'),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await Notification.countDocuments({ type: 'payout_status' })).toBe(1);
});
it('keeps history reviewable with an explicit error if an event was deleted', async () => {
  const id = await createRequest();
  await Event.deleteOne({ _id: eventId });
  const detail = await request(app).get(`/payouts/${id}`).set(auth('admin'));
  expect(detail.status).toBe(200);
  expect(detail.body.data.balanceError).toBe('Event not found');
  expect(detail.body.data).not.toHaveProperty('currentBreakdown');
  expect((await decide(id, 'approved')).status).toBe(404);
  expect((await decide(id, 'declined')).status).toBe(200);
});
it('rejects approval if the event has been rescheduled into the future', async () => {
  const id = await createRequest();
  await Event.updateOne({ _id: eventId }, { endTime: new Date('2999-01-01') });
  expect((await decide(id, 'approved')).status).toBe(409);
});

it('keeps part of short valid account numbers private too', () => {
  expect(maskPayoutBank({ ...bank, accountNumber: '1234' }).accountNumber).toBe(
    '••••34',
  );
});
