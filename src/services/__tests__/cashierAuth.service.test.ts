// api/src/services/__tests__/cashierAuth.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Cashier } from '@models/cashier.model';
import { CashierAuthService } from '@services/cashierAuth.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 300;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

async function seedCashier() {
  const loginCode = nextLoginCode();
  const cashier = await Cashier.create({
    fullName: 'Nomsa', loginCode, pin: '123456', scope: 'organizer',
    vendorId: new mongoose.Types.ObjectId(), eventId: new mongoose.Types.ObjectId(),
  });
  return { cashier, loginCode };
}

it('logs a cashier in by login code + PIN and issues a cashier-scoped token', async () => {
  const { loginCode } = await seedCashier();
  const { accessToken } = await CashierAuthService.login(loginCode, '123456');
  expect(CashierAuthService.verifyToken(accessToken).scope).toBe('cashier');
});

it('locks the account after 5 sequential wrong PINs', async () => {
  const { cashier, loginCode } = await seedCashier();
  for (let i = 0; i < 5; i++) {
    await expect(CashierAuthService.login(loginCode, '000000')).rejects.toThrow('Invalid credentials');
  }
  await expect(CashierAuthService.login(loginCode, '123456')).rejects.toThrow('Account locked');
  const after = await Cashier.findById(cashier._id).lean();
  expect(after?.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
});

// The old bookkeeping was read → compare → write back n+1 on the loaded
// document, so five guesses in flight together all read 0, all wrote 1, and
// the lock never engaged. The counter has to be incremented on the server.
it('counts every one of 5 CONCURRENT wrong PINs and locks the account', async () => {
  const { cashier, loginCode } = await seedCashier();

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => CashierAuthService.login(loginCode, '000000')),
  );
  expect(results.every((r) => r.status === 'rejected')).toBe(true);

  const after = await Cashier.findById(cashier._id).lean();
  expect(after?.failedPinAttempts).toBe(5);
  expect(after?.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  await expect(CashierAuthService.login(loginCode, '123456')).rejects.toThrow('Account locked');
});

it('clears the counter and the lock on a successful login', async () => {
  const { cashier, loginCode } = await seedCashier();
  await expect(CashierAuthService.login(loginCode, '000000')).rejects.toThrow('Invalid credentials');

  await CashierAuthService.login(loginCode, '123456');

  const after = await Cashier.findById(cashier._id).lean();
  expect(after?.failedPinAttempts).toBe(0);
  expect(after?.lockedUntil).toBeNull();
  expect(after?.lastLoginAt).toBeInstanceOf(Date);
});
