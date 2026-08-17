import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../mongo';
import { Buyer } from '@models/buyer.model';
import { RefreshToken } from '@models/refreshToken.model';
import { BuyerOtp } from '@models/buyerOtp.model';
import '@/app'; // registers every model so the audit below covers all of them

/**
 * Mongoose builds declared indexes in the BACKGROUND after connect. Several
 * code paths depend on a unique index for correctness rather than a lookup —
 * e.g. the duplicate-username 409 in socialProfile.controller.ts comes solely
 * from catching MongoDB's E11000. A test that races the index build gets a
 * silent wrong answer (200 instead of 409) instead of a failure, and it only
 * bites under full-suite CPU load, which makes it look like flakiness.
 *
 * connectTestDb() must therefore not return until indexes are built.
 */
describe('test harness: index readiness', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('has built every declared index before the first test runs', async () => {
    const names = (await Buyer.collection.indexes()).map((i: { name?: string }) => i.name);
    expect(names).toContain('phone_1');
    expect(names).toContain('username_1');
  });

  it('enforces the unique username index immediately (no background-build race)', async () => {
    await Buyer.create({ phone: '+26878000060', password: 'secret1', username: 'race_test' });
    await expect(
      Buyer.create({ phone: '+26878000061', password: 'secret1', username: 'race_test' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  /**
   * Regression guard for a whole CLASS of bug. Declaring a single-field index
   * BOTH on the field (index/unique/sparse) AND again via schema.index() yields
   * two definitions of "<field>_1" with different options; MongoDB rejects the
   * second and Mongoose swallows the error, so the index silently never exists.
   * That is how the RefreshToken/BuyerOtp TTL indexes went missing in prod.
   */
  it('builds every declared index on every registered model', async () => {
    const failures: string[] = [];
    for (const name of mongoose.modelNames()) {
      try {
        await mongoose.model(name).init();
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('builds the TTL indexes that auto-purge expired tokens and OTPs', async () => {
    const ttlOf = async (m: mongoose.Model<unknown>) =>
      (await m.collection.indexes()).find(
        (i: { name?: string }) => i.name === 'expiresAt_1',
      ) as { expireAfterSeconds?: number } | undefined;

    // expireAfterSeconds: 0 => delete the doc once expiresAt passes.
    expect((await ttlOf(RefreshToken as never))?.expireAfterSeconds).toBe(0);
    expect((await ttlOf(BuyerOtp as never))?.expireAfterSeconds).toBe(0);
  });
});
