// api/src/services/__tests__/merchantAuth.service.test.ts
// The stall (Merchant) holds identity + settlement; the PERSON
// (MerchantOperator) holds the credentials. These tests pin that split: a
// token must name BOTH, and nothing about the stall may be a login.
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantAuthService } from '@services/merchantAuth.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// loginCode is uniquely indexed across the whole population, so every seeded
// operator needs its own code — a shared literal collides on the second call.
// Crockford base32 (no I/L/O/U), shaped like a real printed code.
let __loginCodeSeq = 200;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

async function seedStallWithOperator(over: { stallStatus?: 'active' | 'suspended' } = {}) {
  const eventId = new mongoose.Types.ObjectId();
  const loginCode = nextLoginCode();
  const stall = await Merchant.create({
    name: 'Main Bar', eventId, commissionPercent: 10, status: over.stallStatus ?? 'active',
  });
  const op = new MerchantOperator({
    fullName: 'Thabo Dlamini', merchantId: stall._id, eventId, loginCode, pin: '123456',
  });
  await op.save();
  return { stall, op, eventId, loginCode };
}

it('mints a token naming both the stall and the person', async () => {
  const { stall, op, loginCode } = await seedStallWithOperator();

  const result = await MerchantAuthService.login(loginCode, '123456');
  const token = MerchantAuthService.verifyToken(result.accessToken);

  expect(token.merchantId).toBe((stall._id as any).toString());
  expect(token.merchantOperatorId).toBe((op._id as any).toString());
  expect(token.operatorName).toBe('Thabo Dlamini');
  expect(token.name).toBe('Main Bar');
  // the returned envelope carries the person too, for the POS header
  expect(result.operator.merchantOperatorId).toBe((op._id as any).toString());
  expect(result.operator.operatorName).toBe('Thabo Dlamini');
});

it('refuses a deactivated operator while the stall stays untouched', async () => {
  const { stall, op, loginCode } = await seedStallWithOperator();
  // Prove the code WORKS first, so the rejection below can only come from
  // isActive — not from the operator population being unreachable.
  await expect(MerchantAuthService.login(loginCode, '123456')).resolves.toBeTruthy();

  op.isActive = false;
  await op.save();

  await expect(MerchantAuthService.login(loginCode, '123456')).rejects.toThrow('Invalid credentials');
  const stillActive = await Merchant.findById(stall._id).lean();
  expect(stillActive?.status).toBe('active');
});

it('refuses an active operator whose stall was suspended', async () => {
  const { stall, loginCode } = await seedStallWithOperator();
  await expect(MerchantAuthService.login(loginCode, '123456')).resolves.toBeTruthy();

  await Merchant.updateOne({ _id: stall._id }, { $set: { status: 'suspended' } });

  await expect(MerchantAuthService.login(loginCode, '123456')).rejects.toThrow('Invalid credentials');
});

it('counts a wrong PIN against the PERSON, not the stall', async () => {
  const { op, loginCode } = await seedStallWithOperator();

  await expect(MerchantAuthService.login(loginCode, '999999')).rejects.toThrow('Invalid credentials');

  const after = await MerchantOperator.findById(op._id).lean();
  expect(after?.failedPinAttempts).toBe(1);
});

it('folds a typed login code onto the canonical alphabet before looking the person up', async () => {
  const eventId = new mongoose.Types.ObjectId();
  const stall = await Merchant.create({ name: 'Gin Bar', eventId, status: 'active' });
  await new MerchantOperator({
    fullName: 'Nomsa Simelane', merchantId: stall._id, eventId, loginCode: '4KZ1P0', pin: '654321',
  }).save();

  // lowercase, plus the ambiguous glyphs the printed slip invites: l→1, o→0
  const result = await MerchantAuthService.login(' 4kzlpo ', '654321');
  expect(MerchantAuthService.verifyToken(result.accessToken).name).toBe('Gin Bar');
});

it('creating a stall issues no login code at all', async () => {
  const stall = await Merchant.create({
    name: 'Side Bar', eventId: new mongoose.Types.ObjectId(), status: 'active',
  });
  expect((stall as any).loginCode).toBeUndefined();
  expect((stall as any).pin).toBeUndefined();
});
