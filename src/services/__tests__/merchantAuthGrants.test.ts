import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantAuthService } from '@services/merchantAuth.service';
import { MerchantPermission, MerchantToken } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 910001;

async function seedOperator(grants: OperatorGrant[]) {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({ name: 'Sandwich Stall', eventId });
  const loginCode = String(seq++);
  await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode, pin: '111111', grants,
  });
  return { loginCode };
}

it('mints manage_stock for an operator carrying the grant', async () => {
  const { loginCode } = await seedOperator([OperatorGrant.MANAGE_STOCK]);
  const { accessToken } = await MerchantAuthService.login(loginCode, '111111');
  const payload = jwt.verify(accessToken, JWT_SECRET) as MerchantToken;
  expect(payload.permissions).toEqual([
    MerchantPermission.CHARGE,
    MerchantPermission.MANAGE_STOCK,
  ]);
});

it('leaves an ungranted operator with charge alone', async () => {
  const { loginCode } = await seedOperator([]);
  const { accessToken } = await MerchantAuthService.login(loginCode, '111111');
  const payload = jwt.verify(accessToken, JWT_SECRET) as MerchantToken;
  expect(payload.permissions).toEqual([MerchantPermission.CHARGE]);
});

it('returns the permission set in the response body, not only inside the token', async () => {
  const { loginCode } = await seedOperator([OperatorGrant.MANAGE_STOCK]);
  const { operator } = await MerchantAuthService.login(loginCode, '111111');

  expect(operator.permissions).toEqual([
    MerchantPermission.CHARGE,
    MerchantPermission.MANAGE_STOCK,
  ]);
});

it('gives an ungranted operator the floor alone in the body', async () => {
  const { loginCode } = await seedOperator([]);
  const { operator } = await MerchantAuthService.login(loginCode, '111111');

  expect(operator.permissions).toEqual([MerchantPermission.CHARGE]);
});

it('keeps every pre-existing operator field intact', async () => {
  const { loginCode } = await seedOperator([]);
  const { operator } = await MerchantAuthService.login(loginCode, '111111');

  // Additive change: an older POS build reads these and must not be disturbed.
  expect(operator).toMatchObject({
    merchantId: expect.any(String),
    merchantOperatorId: expect.any(String),
    operatorName: 'Nomsa Shongwe',
    name: 'Sandwich Stall',
    eventId: expect.any(String),
  });
});

it('returns the same array in the body as it minted into the token', async () => {
  const { loginCode } = await seedOperator([OperatorGrant.MANAGE_STOCK]);
  const { accessToken, operator } = await MerchantAuthService.login(loginCode, '111111');
  const payload = jwt.verify(accessToken, JWT_SECRET) as MerchantToken;

  // Body and token must carry the same permissions. This does NOT prove they
  // are one computation — two identical derive calls would pass it too — but
  // it fires the moment the two sides disagree, which is how the earlier
  // drift bug in this codebase actually surfaced.
  expect(operator.permissions).toEqual(payload.permissions);
});
