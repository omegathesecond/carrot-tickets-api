import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerOperator } from '@models/resellerOperator.model';
import { Reseller } from '@models/reseller.model';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { seedOperator } from '../../__tests__/helpers/fixtures';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('logs in an operator by login code + PIN and issues a reseller token', async () => {
  const { resellerId, loginCode, pin } = await seedOperator({ pin: '123456' });
  const { accessToken, operator } = await ResellerAuthService.login(loginCode, pin);
  expect(operator.role).toBe('reseller_operator');
  const decoded = ResellerAuthService.verifyToken(accessToken);
  expect(decoded.scope).toBe('reseller');
  expect(decoded.resellerId).toBe(resellerId);
  expect(decoded.permissions).toContain('reseller:sell_tickets');
});

it('rejects an unknown login code', async () => {
  await expect(ResellerAuthService.login('000001', '123456')).rejects.toThrow('Invalid credentials');
});

it('rejects a wrong PIN', async () => {
  const { loginCode } = await seedOperator({ pin: '123456' });
  await expect(ResellerAuthService.login(loginCode, '999999')).rejects.toThrow('Invalid credentials');
});

it('locks the account after 5 failed attempts', async () => {
  const { loginCode } = await seedOperator({ pin: '123456' });
  for (let i = 0; i < 5; i++) {
    await expect(ResellerAuthService.login(loginCode, '000000')).rejects.toThrow('Invalid credentials');
  }
  // 6th attempt — even with the correct PIN — is rejected while locked.
  await expect(ResellerAuthService.login(loginCode, '123456')).rejects.toThrow('Account locked');
  const op = await ResellerOperator.findOne({ loginCode });
  expect(op!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
});

it('resets the failed counter on a successful login', async () => {
  const { loginCode } = await seedOperator({ pin: '123456' });
  await expect(ResellerAuthService.login(loginCode, '000000')).rejects.toThrow();
  await ResellerAuthService.login(loginCode, '123456');
  const op = await ResellerOperator.findOne({ loginCode });
  expect(op!.failedPinAttempts).toBe(0);
  expect(op!.lockedUntil).toBeNull();
});

it('returns the permissions array on the operator payload', async () => {
  const { loginCode, pin } = await seedOperator({ role: 'reseller_admin', pin: '111222' });
  const result = await ResellerAuthService.login(loginCode, pin);
  expect(Array.isArray((result.operator as any).permissions)).toBe(true);
  expect((result.operator as any).permissions).toContain('reseller:request_payout');
});

// The till login only ever read the OPERATOR row. Suspending or deactivating
// the reseller company (the admin's only revocation control for a whole
// partner) therefore stopped nothing at the till: every operator under it kept
// logging in and selling. ownerLogin already filters on the parent; this holds
// the till login to the same rule.
describe('the parent reseller gates the till login', () => {
  it('refuses an operator whose reseller has been deactivated', async () => {
    const { resellerId, loginCode } = await seedOperator({ pin: '123456' });
    await expect(ResellerAuthService.login(loginCode, '123456')).resolves.toBeTruthy();

    await Reseller.updateOne({ _id: resellerId }, { $set: { isActive: false } });

    await expect(ResellerAuthService.login(loginCode, '123456')).rejects.toThrow('Invalid credentials');
  });

  it('refuses an operator whose reseller has been suspended', async () => {
    const { resellerId, loginCode } = await seedOperator({ pin: '123456' });
    await expect(ResellerAuthService.login(loginCode, '123456')).resolves.toBeTruthy();

    await Reseller.updateOne({ _id: resellerId }, { $set: { status: 'suspended' } });

    await expect(ResellerAuthService.login(loginCode, '123456')).rejects.toThrow('Invalid credentials');
  });
});

describe('the PIN lockout survives parallel attempts', () => {
  // The old bookkeeping was read → compare → write back n+1 on the loaded
  // document. Five requests in flight together all read 0, all wrote 1, and
  // the lock never engaged — an attacker just had to send guesses in parallel
  // instead of in series.
  it('counts every one of 5 CONCURRENT wrong PINs and locks the account', async () => {
    const { loginCode } = await seedOperator({ pin: '123456' });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ResellerAuthService.login(loginCode, '000000')),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    const op = await ResellerOperator.findOne({ loginCode });
    expect(op!.failedPinAttempts).toBe(5);
    expect(op!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await expect(ResellerAuthService.login(loginCode, '123456')).rejects.toThrow('Account locked');
  });

  it('starts a fresh window once a lock has expired, rather than re-locking on the first miss', async () => {
    const { loginCode } = await seedOperator({ pin: '123456' });
    await ResellerOperator.updateOne(
      { loginCode },
      { $set: { failedPinAttempts: 5, lockedUntil: new Date(Date.now() - 1000) } },
    );

    await expect(ResellerAuthService.login(loginCode, '000000')).rejects.toThrow('Invalid credentials');

    const op = await ResellerOperator.findOne({ loginCode });
    expect(op!.failedPinAttempts).toBe(1);
    expect(op!.lockedUntil).toBeNull();
  });
});
