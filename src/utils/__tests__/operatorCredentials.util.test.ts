// api/src/utils/__tests__/operatorCredentials.util.test.ts
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerOperator } from '@models/resellerOperator.model';
import { generatePin, generateUniqueLoginCode } from '@utils/operatorCredentials.util';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());

it('generatePin returns a 6-digit numeric string', () => {
  for (let i = 0; i < 50; i++) {
    expect(generatePin()).toMatch(/^\d{6}$/);
  }
});

it('generateUniqueLoginCode returns a 6-digit code in range', async () => {
  const code = await generateUniqueLoginCode();
  expect(code).toMatch(/^\d{6}$/);
  expect(Number(code)).toBeGreaterThanOrEqual(100000);
  expect(Number(code)).toBeLessThanOrEqual(999999);
});

it('generateUniqueLoginCode retries when a code already exists', async () => {
  // Seed an operator that owns code "100000" (Math.random -> 0).
  await ResellerOperator.collection.insertOne({ loginCode: '100000', fullName: 'x', role: 'reseller_operator', isActive: true } as any);
  const spy = jest.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5);
  const code = await generateUniqueLoginCode();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(code).toBe('550000'); // 100000 + floor(0.5 * 900000)
});
