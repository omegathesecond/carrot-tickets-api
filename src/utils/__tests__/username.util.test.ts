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
      expect(u).not.toMatch(/\d/);
    }
  });

  it('derives from the buyer name when present', async () => {
    const u = await generateUniqueUsername('Laslie Georges');
    expect(u).toBe('laslie_georges');
  });

  it('adds letters only when the readable name is already taken', async () => {
    await Buyer.create({ phone: '+26878000001', password: 'secret1', username: 'laslie_georges' });
    const u = await generateUniqueUsername('Laslie Georges');
    expect(u).toMatch(/^laslie_georges_[a-z]{4}$/);
    expect(u).toMatch(USERNAME_REGEX);
  });

  it('keeps long collision candidates within the username limit', async () => {
    const name = 'abcdefghijklmnop';
    await Buyer.create({ phone: '+26878000004', password: 'secret1', username: name });
    expect(await generateUniqueUsername(name)).toMatch(/^[a-z]{15}_[a-z]{4}$/);
  });

  it('does not assign reserved names', async () => {
    expect(await generateUniqueUsername('Admin')).toMatch(/^admin_[a-z]{4}$/);
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

  it('schema rejects a username that violates the pattern', async () => {
    await expect(
      Buyer.create({ phone: '+26878000003', password: 'secret1', username: 'bad name!' })
    ).rejects.toThrow(/Usernames are 3-20 characters/);
  });
});
