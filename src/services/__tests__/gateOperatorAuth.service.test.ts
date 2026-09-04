// api/src/services/__tests__/gateOperatorAuth.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 400;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

async function seedGate() {
  const loginCode = nextLoginCode();
  const operator = await GateOperator.create({
    fullName: 'Gate', loginCode, pin: '123456', scope: 'organizer', vendorId: new mongoose.Types.ObjectId(),
  });
  return { operator, loginCode };
}

it('logs a gate operator in by login code + PIN', async () => {
  const { operator, loginCode } = await seedGate();
  const { operator: out } = await GateOperatorAuthService.login(loginCode, '123456');
  expect(out.id).toBe((operator._id as any).toString());
});

it('locks the account after 5 sequential wrong PINs', async () => {
  const { operator, loginCode } = await seedGate();
  for (let i = 0; i < 5; i++) {
    await expect(GateOperatorAuthService.login(loginCode, '000000')).rejects.toThrow('Invalid credentials');
  }
  await expect(GateOperatorAuthService.login(loginCode, '123456')).rejects.toThrow('Account locked');
  const after = await GateOperator.findById(operator._id).lean();
  expect(after?.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
});

// The old bookkeeping was read → compare → write back n+1 on the loaded
// document, so five guesses in flight together all read 0, all wrote 1, and
// the lock never engaged. The counter has to be incremented on the server.
it('counts every one of 5 CONCURRENT wrong PINs and locks the account', async () => {
  const { operator, loginCode } = await seedGate();

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => GateOperatorAuthService.login(loginCode, '000000')),
  );
  expect(results.every((r) => r.status === 'rejected')).toBe(true);

  const after = await GateOperator.findById(operator._id).lean();
  expect(after?.failedPinAttempts).toBe(5);
  expect(after?.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  await expect(GateOperatorAuthService.login(loginCode, '123456')).rejects.toThrow('Account locked');
});

it('clears the counter and the lock on a successful login', async () => {
  const { operator, loginCode } = await seedGate();
  await expect(GateOperatorAuthService.login(loginCode, '000000')).rejects.toThrow('Invalid credentials');

  await GateOperatorAuthService.login(loginCode, '123456');

  const after = await GateOperator.findById(operator._id).lean();
  expect(after?.failedPinAttempts).toBe(0);
  expect(after?.lockedUntil).toBeNull();
  expect(after?.lastLoginAt).toBeInstanceOf(Date);
});
