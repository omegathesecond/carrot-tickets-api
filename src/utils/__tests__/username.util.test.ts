import { backfillUsernames } from '../../scripts/backfillUsernames';
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

  it('replaces an existing generated numeric handle and persists it once', async () => {
    const buyer = await Buyer.create({
      phone: '+26878000005', password: 'secret1', name: 'Laslie Georges',
      username: 'laslie_georges_123',
    });
    await ensureUsername(buyer);
    expect(buyer.username).toBe('laslie_georges');
    const reloaded = await Buyer.findById(buyer._id);
    expect(reloaded?.username).toBe('laslie_georges');
    await ensureUsername(reloaded!);
    expect(reloaded?.username).toBe('laslie_georges');
  });

  it('keeps migrated usernames unique when the readable name is taken', async () => {
    await Buyer.create({ phone: '+26878000006', password: 'secret1', username: 'laslie_georges' });
    const buyer = await Buyer.create({
      phone: '+26878000007', password: 'secret1', name: 'Laslie Georges',
      username: 'laslie_georges_123',
    });
    await ensureUsername(buyer);
    expect(buyer.username).toMatch(/^laslie_georges_[a-z]{4}$/);
  });

  it('preserves customized numeric handles', async () => {
    const buyer = await Buyer.create({
      phone: '+26878000008', password: 'secret1', name: 'Laslie Georges',
      username: 'laslie_georges_123', usernameCustomizedAt: new Date(),
    });
    await ensureUsername(buyer);
    expect(buyer.username).toBe('laslie_georges_123');
    expect((await Buyer.findById(buyer._id))?.username).toBe('laslie_georges_123');
  });

  it('replaces legacy anonymous generated handles without adding numbers', async () => {
    const buyer = await Buyer.create({
      phone: '+26878000009', password: 'secret1', username: 'cosmic_fox_999',
    });
    await ensureUsername(buyer);
    expect(buyer.username).toMatch(USERNAME_REGEX);
    expect(buyer.username).not.toMatch(/\d/);
  });

  it('keeps numbers that are part of the display name on repeat calls', async () => {
    const buyer = await Buyer.create({
      phone: '+26878000010', password: 'secret1', name: 'Club 123', username: 'club_123_456',
    });
    await ensureUsername(buyer);
    expect(buyer.username).toBe('club_123');
    await ensureUsername(buyer);
    expect(buyer.username).toBe('club_123');
  });

  it('migrates inactive buyers in bulk, preserves custom handles and is idempotent', async () => {
    const buyers = await Buyer.create([
      { phone: '+26878000011', password: 'secret1', name: 'Laslie Georges', username: 'laslie_georges_123' },
      { phone: '+26878000012', password: 'secret1', name: 'Laslie Georges', username: 'laslie_georges_456' },
      { phone: '+26878000013', password: 'secret1', username: 'custom_123', usernameCustomizedAt: new Date() },
      { phone: '+26878000014', password: 'secret1', name: 'Club 123', username: 'club_123' },
      { phone: '+26878000015', password: 'secret1', username: 'cosmic_fox_999' },
    ]);
    expect(await backfillUsernames()).toEqual({ updated: 3 });
    const results = await Buyer.find({ _id: { $in: buyers.map(b => b._id) } });
    const handles = results.map(b => b.username);
    expect(handles).toContain('laslie_georges');
    expect(handles.some(u => /^laslie_georges_[a-z]{4}$/.test(u!))).toBe(true);
    expect(handles).toContain('custom_123');
    expect(handles).toContain('club_123');
    expect(new Set(handles).size).toBe(5);
    expect(await backfillUsernames()).toEqual({ updated: 0 });
  });

  it('does not overwrite a username customized while migration is generating a replacement', async () => {
    const buyer = await Buyer.create({
      phone: '+26878000016', password: 'secret1', name: 'Laslie Georges', username: 'laslie_georges_123',
    });
    const exists = jest.spyOn(Buyer, 'exists').mockImplementationOnce(() => {
      return Buyer.updateOne({ _id: buyer._id }, {
        $set: { username: 'chosen_123', usernameCustomizedAt: new Date() },
      }).then(() => null) as ReturnType<typeof Buyer.exists>;
    });
    try {
      expect(await backfillUsernames()).toEqual({ updated: 0 });
      expect((await Buyer.findById(buyer._id))?.username).toBe('chosen_123');
    } finally {
      exists.mockRestore();
    }
  });

  it('schema rejects a username that violates the pattern', async () => {
    await expect(
      Buyer.create({ phone: '+26878000003', password: 'secret1', username: 'bad name!' })
    ).rejects.toThrow(/Usernames are 3-20 characters/);
  });
});
