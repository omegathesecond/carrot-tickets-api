import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ResellerAuthService } from '../resellerAuth.service';
import { Reseller } from '@models/reseller.model';

describe('ResellerAuthService.ownerLogin — email + password', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seed() {
    // password is hashed by the pre-save hook.
    await Reseller.create({ businessName: 'DeltaPay', email: 'akoch@deltapay.co.sz', password: 'Secret123!', isActive: true });
  }

  it('signs in with the right email + password and returns a reseller-scoped token', async () => {
    await seed();
    const r = await ResellerAuthService.ownerLogin('AKOCH@deltapay.co.sz', 'Secret123!');
    expect(r.accessToken).toBeTruthy();
    expect(r.reseller.businessName).toBe('DeltaPay');
    const decoded = ResellerAuthService.verifyToken(r.accessToken);
    expect(decoded.scope).toBe('reseller');
    expect(decoded.resellerId).toBe(r.reseller.resellerId);
    expect(decoded.role).toBe('reseller_admin');
  });

  it('rejects a wrong password', async () => {
    await seed();
    await expect(ResellerAuthService.ownerLogin('akoch@deltapay.co.sz', 'nope')).rejects.toThrow(/invalid credentials/i);
  });

  it('rejects an unknown email', async () => {
    await seed();
    await expect(ResellerAuthService.ownerLogin('nobody@x.com', 'Secret123!')).rejects.toThrow(/invalid credentials/i);
  });

  it('never serializes the password', async () => {
    await seed();
    const r = await Reseller.findOne({ email: 'akoch@deltapay.co.sz' });
    expect(JSON.stringify(r)).not.toMatch(/password/i);
  });
});
