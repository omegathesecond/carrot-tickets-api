// api/src/utils/__tests__/operatorCredentials.util.test.ts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('crypto');
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerOperator } from '@models/resellerOperator.model';
import { GateOperator } from '@models/gateOperator.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { generatePin, generateUniqueLoginCode, normalizeLoginCode, LOGIN_CODE_ALPHABET } from '@utils/operatorCredentials.util';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());
afterEach(clearTestDb);

it('generatePin returns a 6-digit numeric string', () => {
  for (let i = 0; i < 50; i++) {
    expect(generatePin()).toMatch(/^\d{6}$/);
  }
});

it('LOGIN_CODE_ALPHABET is Crockford base32 with the ambiguous glyphs removed', () => {
  expect(LOGIN_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  expect(LOGIN_CODE_ALPHABET).toHaveLength(32);
  for (const glyph of ['I', 'L', 'O', 'U']) {
    expect(LOGIN_CODE_ALPHABET).not.toContain(glyph);
  }
});

it('generateUniqueLoginCode returns 6 characters drawn only from the alphabet', async () => {
  for (let i = 0; i < 25; i++) {
    const code = await generateUniqueLoginCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  }
});

it('normalizeLoginCode uppercases and folds the ambiguous glyphs', () => {
  expect(normalizeLoginCode('abc123')).toBe('ABC123');
  expect(normalizeLoginCode('  4kz9p2  ')).toBe('4KZ9P2');
  expect(normalizeLoginCode('IL0O1')).toBe('11001');
  expect(normalizeLoginCode('il')).toBe('11');
});

it('normalizeLoginCode leaves an all-numeric legacy code untouched', () => {
  expect(normalizeLoginCode('482910')).toBe('482910');
});

it('generateUniqueLoginCode retries when a code is already taken', async () => {
  // Pre-seed a ResellerOperator owning 'ABCDEF'. In LOGIN_CODE_ALPHABET
  // ('0123456789ABCDEFGHJKMNPQRSTVWXYZ') those characters sit at indices
  // 10,11,12,13,14,15. randomCode() draws one randomInt(0, 32) per
  // character (6 draws per code), so stubbing the first 6 draws to that
  // exact index sequence forces the generator's first candidate to collide
  // with the seeded code. The next 6 draws (index 1 each) produce '111111',
  // which must be what comes back — proving the generator rejected the
  // collision and drew again, not merely that 25 draws happened to avoid it.
  const seededCode = 'ABCDEF';
  await ResellerOperator.collection.insertOne(
    { loginCode: seededCode, fullName: 'x', role: 'reseller_operator', isActive: true } as any,
  );
  const spy = jest.spyOn(crypto, 'randomInt') as unknown as jest.SpyInstance;
  spy
    .mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12)
    .mockReturnValueOnce(13).mockReturnValueOnce(14).mockReturnValueOnce(15)
    .mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValueOnce(1)
    .mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValueOnce(1);

  const code = await generateUniqueLoginCode();

  expect(spy).toHaveBeenCalledTimes(12);
  expect(code).not.toBe(seededCode);
  expect(code).toBe('111111');
});

it('generateUniqueLoginCode avoids codes taken by a gate operator', async () => {
  await GateOperator.collection.insertOne({ loginCode: '100000', fullName: 'g', scope: 'platform', isActive: true } as any);
  const code = await generateUniqueLoginCode();
  expect(code).not.toBe('100000');
});

// The stall (Merchant) left this uniqueness check when it stopped holding a
// login code; the PERSON on its till took its place. Without this probe two
// populations could be handed the same code and the operator-login dispatcher
// would route by whichever it found first.
it('generateUniqueLoginCode avoids codes taken by a stall operator', async () => {
  const seededCode = 'ABCDEF';
  await MerchantOperator.collection.insertOne({ loginCode: seededCode, fullName: 'till', isActive: true } as any);
  const spy = jest.spyOn(crypto, 'randomInt') as unknown as jest.SpyInstance;
  spy
    .mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12)
    .mockReturnValueOnce(13).mockReturnValueOnce(14).mockReturnValueOnce(15)
    .mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValueOnce(1)
    .mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValueOnce(1);

  const code = await generateUniqueLoginCode();

  expect(spy).toHaveBeenCalledTimes(12); // it drew twice: the collision, then a fresh one
  expect(code).toBe('111111');
});
