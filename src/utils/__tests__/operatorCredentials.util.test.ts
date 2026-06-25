// api/src/utils/__tests__/operatorCredentials.util.test.ts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('crypto');
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerOperator } from '@models/resellerOperator.model';
import { GateOperator } from '@models/gateOperator.model';
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
  // Seed an operator that owns code "100000" (the first randomInt result collides).
  await ResellerOperator.collection.insertOne({ loginCode: '100000', fullName: 'x', role: 'reseller_operator', isActive: true } as any);
  const spy = jest.spyOn(crypto, 'randomInt') as unknown as jest.SpyInstance;
  spy.mockReturnValueOnce(100000).mockReturnValueOnce(550000);
  const code = await generateUniqueLoginCode();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(code).toBe('550000'); // first (100000) collides, retry returns 550000
});

it('generateUniqueLoginCode avoids codes taken by a gate operator', async () => {
  await GateOperator.collection.insertOne({ loginCode: '100000', fullName: 'g', scope: 'platform', isActive: true } as any);
  const code = await generateUniqueLoginCode();
  expect(code).not.toBe('100000');
});
