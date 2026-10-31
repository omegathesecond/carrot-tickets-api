import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVendorSessionToken } from '@/__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantOperatorService } from '@services/merchantOperator.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { decryptOperatorPin } from '@utils/operatorPinEncryption.util';

const OWNER = '64b000000000000000000a01';
beforeAll(connectLedgerTestDb, 90000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDb(); });
afterAll(disconnectTestDb);

async function setup(cashless = true) {
  const token = await seedVendorSessionToken(OWNER, { permissions: [TicketsPermission.MANAGE_ACCESS] });
  const event = await Event.create({ name: 'Festival', venue: 'Venue', vendorId: OWNER, cashless,
    eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000) });
  const eventId = String(event._id);
  const addStall = (name: string, extra = {}) => Merchant.create({ eventId, name, ...extra });
  const run = (auth = token) => request(app).post(`/api/tickets/events/${eventId}/stall-users`).set('Authorization', `Bearer ${auth}`);
  return { eventId, addStall, run };
}

it('creates working stall-named credentials with no extra grants and returns only counts', async () => {
  const { eventId, addStall, run } = await setup();
  const stall = await addStall('Surf N Fries');
  const res = await run();
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ created: 1, existing: 0, inactive: 0, skipped: 0 });
  const op = await MerchantOperator.findOne({ merchantId: stall._id }).select('+pin +encryptedPin');
  expect(op!.fullName).toBe('Surf N Fries');
  expect(String(op!.eventId)).toBe(eventId);
  expect(op!.isActive).toBe(true);
  expect(op!.grants).toEqual([]);
  expect(op!.loginCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  const pin = decryptOperatorPin(op!.get('encryptedPin'), String(op!._id));
  expect(pin).toMatch(/^\d{6}$/);
  expect(await op!.comparePin(pin)).toBe(true);
});

it('preserves existing credentials, scopes matches by stall and creates only missing users on repeated clicks', async () => {
  const { eventId, addStall, run } = await setup();
  const a = await addStall('The Meat Hub');
  const b = await addStall('The Meat Hub');
  const { operator } = await MerchantOperatorService.create({ merchantId: String(a._id), eventId, fullName: ' the   meat hub ', pin: '123456' });
  const before = await MerchantOperator.findById(operator._id).select('+pin +encryptedPin').lean();
  await MerchantOperatorService.create({ merchantId: String(b._id), eventId, fullName: 'Nomsa', pin: '654321' });
  expect((await run()).body.data).toEqual({ created: 1, existing: 1, inactive: 0, skipped: 0 });
  expect((await run()).body.data).toEqual({ created: 0, existing: 2, inactive: 0, skipped: 0 });
  const after = await MerchantOperator.findById(operator._id).select('+pin +encryptedPin').lean();
  expect(after).toEqual(before);
  expect(await MerchantOperator.countDocuments({ eventId })).toBe(3);
});

it('leaves disabled users disabled, skips suspended/deleted stalls and replaces a deleted user', async () => {
  const { eventId, addStall, run } = await setup();
  const a = await addStall('Disabled');
  const b = await addStall('Deleted person');
  await addStall('Suspended', { status: 'suspended' });
  await addStall('Deleted stall', { deletedAt: new Date() });
  const first = await MerchantOperatorService.create({ merchantId: String(a._id), eventId, fullName: 'Disabled' });
  await MerchantOperator.updateOne({ _id: first.operator._id }, { isActive: false });
  const deleted = await MerchantOperatorService.create({ merchantId: String(b._id), eventId, fullName: 'Deleted person' });
  await MerchantOperator.updateOne({ _id: deleted.operator._id }, { deletedAt: new Date() });
  const res = await run();
  expect(res.body.data).toEqual({ created: 1, existing: 1, inactive: 1, skipped: 1 });
  expect((await MerchantOperator.findById(first.operator._id))!.isActive).toBe(false);
  expect(await MerchantOperator.countDocuments({ eventId, deletedAt: null, isActive: true })).toBe(1);
});

it('serializes simultaneous requests without duplicate users or PIN resets', async () => {
  const { eventId, addStall, run } = await setup();
  await addStall('A'); await addStall('B');
  const responses = await Promise.all([run(), run()]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(responses.map(r => r.body.data.created).sort()).toEqual([0, 2]);
  const users = await MerchantOperator.find({ eventId }).lean();
  expect(users).toHaveLength(2);
  expect(new Set(users.map(u => u.loginCode)).size).toBe(2);
});

it('rolls back the entire batch on failure and surfaces the error', async () => {
  const { eventId, addStall, run } = await setup();
  await addStall('A'); await addStall('B');
  const create = MerchantOperatorService.create.bind(MerchantOperatorService);
  jest.spyOn(MerchantOperatorService, 'create').mockImplementationOnce(create).mockRejectedValueOnce(new Error('Credential generation failed'));
  expect((await run()).status).toBe(500);
  expect(await MerchantOperator.countDocuments({ eventId })).toBe(0);
});

it('requires manage_access, event ownership and a cashless event', async () => {
  const { eventId, addStall, run } = await setup();
  await addStall('A');
  const denied = await seedVendorSessionToken(OWNER, { permissions: [TicketsPermission.VIEW_SALES] });
  expect((await run(denied)).status).toBe(403);
  const otherOwner = await seedVendorSessionToken('64b000000000000000000b02');
  expect((await run(otherOwner)).status).toBe(403);
  expect((await request(app).post(`/api/tickets/events/${eventId}/stall-users`)).status).toBe(401);
  await Event.updateOne({ _id: eventId }, { cashless: false });
  expect((await run()).status).toBe(400);
  expect(await MerchantOperator.countDocuments({ eventId })).toBe(0);
});

it('allows a super-admin to create users for any owned cashless event', async () => {
  const { addStall, run } = await setup();
  await addStall('A');
  const admin = await seedVendorSessionToken('64b000000000000000000c03', { isSuperAdmin: true });
  expect((await run(admin)).body.data.created).toBe(1);
});
