import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerOperator } from '@models/resellerOperator.model';
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
