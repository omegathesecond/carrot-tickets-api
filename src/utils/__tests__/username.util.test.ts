import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import {
  USERNAME_REGEX,
  generateUniqueUsername,
  ensureUsername,
} from '@utils/username.util';

describe('username.util', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('generates usernames matching the allowed pattern', async () => {
    for (let i = 0; i < 20; i++) {
      const u = await generateUniqueUsername();
      expect(u).toMatch(USERNAME_REGEX);
    }
  });

  it('derives from the buyer name when present', async () => {
    const u = await generateUniqueUsername('Laslie Georges');
    expect(u).toMatch(/^laslie_georges_\d{3}$/);
  });

  it('avoids taken usernames', async () => {
    await Buyer.create({ phone: '+26878000001', password: 'secret1', username: 'neon_fox_123' });
    const u = await generateUniqueUsername();
    expect(u).not.toBe('neon_fox_123');
  });

  it('ensureUsername backfills once and is idempotent', async () => {
    const buyer = await Buyer.create({ phone: '+26878000002', password: 'secret1', name: 'Test User' });
    expect(buyer.username).toBeUndefined();

    const first = await ensureUsername(buyer);
    expect(first.username).toMatch(USERNAME_REGEX);

    const assigned = first.username;
    const second = await ensureUsername(first);
    expect(second.username).toBe(assigned);
  });
});
