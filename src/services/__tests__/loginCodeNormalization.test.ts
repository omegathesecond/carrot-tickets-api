import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedOperator(loginCode: string) {
  const op = new GateOperator({ fullName: 'Thabo', loginCode, scope: 'platform', isActive: true, pin: '123456' });
  await op.save(); // pre-save hook hashes the pin
  return op;
}

it('accepts a lowercase code', async () => {
  await seedOperator('4KZ9P2');
  const result = await GateOperatorAuthService.login('4kz9p2', '123456');
  expect(result.accessToken).toBeTruthy();
});

it('folds a misread I onto 1 and O onto 0', async () => {
  await seedOperator('1A0B2C');
  const result = await GateOperatorAuthService.login('IAOB2C', '123456');
  expect(result.accessToken).toBeTruthy();
});

it('still rejects a genuinely wrong code', async () => {
  await seedOperator('9Z9Z9Z');
  await expect(GateOperatorAuthService.login('4KZ9P2', '123456')).rejects.toThrow('Invalid credentials');
});
