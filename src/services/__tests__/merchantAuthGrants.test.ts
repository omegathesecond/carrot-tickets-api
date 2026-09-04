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
