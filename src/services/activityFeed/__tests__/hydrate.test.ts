import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { hydrate } from '../hydrate';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import { EventStatus } from '@interfaces/event.interface';
import type { ActivityCandidate } from '../types';
import mongoose from 'mongoose';

const DAY = 86400000;
const at = new Date('2026-07-30T10:00:00.000Z');

describe('hydrate', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('hydrates a buyer actor and an event target with hrefs', async () => {
    const buyer = await Buyer.create({ phone: '+26878200001', password: 'password123', name: 'Sipho', username: 'sipho' });
    const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org' });
    const event = await Event.create({
      vendorId: vendor._id, name: 'Winter Fest', venue: 'V', posterUrl: 'https://cdn/p.jpg',
      eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
      status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 10 }],
    });

    const candidates: ActivityCandidate[] = [{
      type: 'like_event', sourceId: 'src1', sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      target: { kind: 'event', id: String(event._id) },
    }];

    const [item] = await hydrate(candidates);
    expect(item!.id).toBe('like_event:src1');
    expect(item!.sortAt).toBe(at.toISOString());
    expect(item!.actor).toEqual({
      kind: 'buyer', id: String(buyer._id), name: 'Sipho', username: 'sipho', avatarUrl: null, href: '/u/sipho',
    });
    expect(item!.target!.name).toBe('Winter Fest');
    expect(item!.target!.imageUrl).toBe('https://cdn/p.jpg');
    expect(item!.target!.href).toBe(`/event/winter-fest-${String(event._id)}`);
  });

  it('hydrates an organizer actor', async () => {
    const vendor = await Vendor.create({ businessName: 'King Derby', password: 'password123', slug: 'king-derby', logoUrl: 'https://cdn/l.png' });
    const post = await Update.create({
      authorType: 'vendor', authorId: vendor._id, kind: 'image', caption: '',
      media: { rawKey: 'k', status: 'ready', image: { url: 'https://cdn/i.jpg', width: 1, height: 1 } },
    });

    const [item] = await hydrate([{
      type: 'post', sourceId: String(post._id), sortAt: at,
      actor: { kind: 'organizer', id: String(vendor._id) },
      target: { kind: 'post', id: String(post._id) },
    }]);
    expect(item!.actor).toEqual({
      kind: 'organizer', id: String(vendor._id), name: 'King Derby', username: 'king-derby',
      avatarUrl: 'https://cdn/l.png', href: `/o/${String(vendor._id)}`,
    });
    expect(item!.target!.imageUrl).toBe('https://cdn/i.jpg');
    expect(item!.target!.href).toBe(`/post/${String(post._id)}`);
  });

  it('drops a row whose actor is socially suspended', async () => {
    const buyer = await Buyer.create({
      phone: '+26878200002', password: 'password123', username: 'banned', socialSuspendedAt: new Date(),
    });
    const other = await Buyer.create({ phone: '+26878200003', password: 'password123', username: 'oky' });

    const items = await hydrate([{
      type: 'follow', sourceId: 's', sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      target: { kind: 'buyer', id: String(other._id) },
    }]);
    expect(items).toHaveLength(0);
  });

  it('drops a row whose target no longer resolves', async () => {
    const buyer = await Buyer.create({ phone: '+26878200004', password: 'password123', username: 'sipho2' });
    const items = await hydrate([{
      type: 'like_event', sourceId: 's', sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      target: { kind: 'event', id: String(new mongoose.Types.ObjectId()) },
    }]);
    expect(items).toHaveLength(0);
  });

  it('falls back to the id-based profile href when a buyer has no username', async () => {
    const buyer = await Buyer.create({ phone: '+26878200005', password: 'password123', name: 'No Handle' });
    const other = await Buyer.create({ phone: '+26878200006', password: 'password123', username: 'target' });
    const [item] = await hydrate([{
      type: 'follow', sourceId: 's', sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      target: { kind: 'buyer', id: String(other._id) },
    }]);
    expect(item!.actor.username).toBeNull();
    expect(item!.actor.href).toBe(`/u/${String(buyer._id)}`);
  });

  it('drops rows with a malformed actor id instead of throwing', async () => {
    const buyer = await Buyer.create({ phone: '+26878200010', password: 'password123', username: 'okbuyer' });
    const items = await hydrate([
      {
        // Mirrors the production CastError: String(undefined) === "undefined"
        // when an eventCandidates row has no vendorId (self-listed event).
        type: 'event', sourceId: 's1', sortAt: at,
        actor: { kind: 'organizer', id: 'undefined' },
        target: { kind: 'event', id: String(new mongoose.Types.ObjectId()) },
      },
      {
        // Well-formed but nonexistent — should also just resolve to nothing,
        // not throw.
        type: 'follow', sourceId: 's2', sortAt: at,
        actor: { kind: 'buyer', id: String(new mongoose.Types.ObjectId()) },
        target: { kind: 'buyer', id: String(buyer._id) },
      },
    ]);
    expect(items).toHaveLength(0);
  });

  it('preserves input order', async () => {
    const b1 = await Buyer.create({ phone: '+26878200007', password: 'password123', username: 'a1x' });
    const b2 = await Buyer.create({ phone: '+26878200008', password: 'password123', username: 'a2x' });
    const t = await Buyer.create({ phone: '+26878200009', password: 'password123', username: 'trg' });
    const mk = (id: string, sourceId: string): ActivityCandidate => ({
      type: 'follow', sourceId, sortAt: at,
      actor: { kind: 'buyer', id }, target: { kind: 'buyer', id: String(t._id) },
    });

    const items = await hydrate([mk(String(b2._id), 's2'), mk(String(b1._id), 's1')]);
    expect(items.map((i) => i.id)).toEqual(['follow:s2', 'follow:s1']);
  });

  it('keeps a join row (actor only) and emits target: null', async () => {
    const buyer = await Buyer.create({
      phone: '+26878200020', password: 'password123', name: 'New User', username: 'newbie',
    });
    const [item] = await hydrate([{
      type: 'join', sourceId: String(buyer._id), sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      // no target
    }]);
    expect(item!.type).toBe('join');
    expect(item!.target).toBeNull();
    expect(item!.actor.name).toBe('New User');
    expect(item!.actor.href).toBe('/u/newbie');
  });

  it('drops a join whose buyer is socially suspended', async () => {
    const buyer = await Buyer.create({
      phone: '+26878200021', password: 'password123', username: 'susp', socialSuspendedAt: new Date(),
    });
    const items = await hydrate([{
      type: 'join', sourceId: String(buyer._id), sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
    }]);
    expect(items).toHaveLength(0);
  });
});
