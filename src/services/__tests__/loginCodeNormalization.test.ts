import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedOperator as seedResellerOperator } from '../../__tests__/helpers/fixtures';
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

// The unified POST /api/operator/login endpoint (operatorAuth.controller.ts) has its own
// routing probes — four raw .exists({ loginCode, ... }) lookups that decide which
// population's service to call. Those probes are a SEPARATE lookup site from the one
// inside each auth service, and gate/cashier/merchant operators have no other login
// route, so this is the primary surface for three of the four populations. Cover it
// directly: a code that only normalizes correctly at the service level, but not at the
// controller's routing probes, would 401 here even though the service-level tests above
// pass.
describe('POST /api/operator/login (routing probes)', () => {
  it('accepts a lowercase code end-to-end through the routing probes', async () => {
    await seedOperator('4KZ9P2');
    const res = await request(app).post('/api/operator/login').send({ loginCode: '4kz9p2', pin: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('gate');
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('accepts an I/O-glyph code end-to-end through the routing probes', async () => {
    await seedOperator('1A0B2C');
    const res = await request(app).post('/api/operator/login').send({ loginCode: 'IAOB2C', pin: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('gate');
    expect(res.body.data.accessToken).toBeTruthy();
  });
});

// The reseller portal (reseller.controller.ts -> POST /api/reseller/auth/login) calls
// ResellerAuthService.login() directly — it does NOT go through
// operatorAuth.controller.ts, so the routing-probe tests above give it zero coverage.
// Separately, the shared seedOperator() fixture (src/__tests__/helpers/fixtures.ts)
// generates purely sequential NUMERIC codes when no loginCode is given, so every
// pre-existing reseller suite logs in with the exact code it seeded and never exercises
// folding either. Seed an explicit canonical (letters+digits) code here so this test
// actually exercises normalizeLoginCode — and, as a bonus, hits the Joi pattern Task 1
// widened to /^[0-9A-Za-z]{6}$/ along the way.
describe('POST /api/reseller/auth/login (reseller portal)', () => {
  it('accepts a lowercase code', async () => {
    const { loginCode, pin } = await seedResellerOperator({ loginCode: '7HK4M9', pin: '223344' });
    const res = await request(app)
      .post('/api/reseller/auth/login')
      .send({ loginCode: loginCode.toLowerCase(), pin });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('folds a misread I onto 1 and O onto 0', async () => {
    await seedResellerOperator({ loginCode: '1D0E2F', pin: '223344' });
    const res = await request(app)
      .post('/api/reseller/auth/login')
      .send({ loginCode: 'IDOE2F', pin: '223344' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });
});
