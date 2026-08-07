import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { likeEventCandidates, likePostCandidates, followCandidates, postCandidates, eventCandidates } from '../sources';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import { EventReaction } from '@models/eventReaction.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Follow } from '@models/follow.model';
import { EventStatus } from '@interfaces/event.interface';
import mongoose from 'mongoose';

const DAY = 86400000;

async function seedEvent(name: string, status: EventStatus = EventStatus.PUBLISHED) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  const event = await Event.create({
    vendorId: vendor._id, name, venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status, publishedAt: new Date(Date.now() - DAY), ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
  return { vendor, event };
}

async function seedPost(authorId: any, authorType: 'buyer' | 'vendor' = 'vendor') {
  return Update.create({
    authorType, authorId, kind: 'image', caption: 'hi',
    media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } },
  });
}

describe('activity feed sources', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('likeEventCandidates returns likes and never saves', async () => {
    const { event } = await seedEvent('E1');
    const buyer = await Buyer.create({ phone: '+26878100001', password: 'password123' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });

    const { candidates: rows } = await likeEventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('like_event');
    expect(rows[0]!.target).toEqual({ kind: 'event', id: String(event._id) });
    expect(rows[0]!.actor).toEqual({ kind: 'buyer', id: String(buyer._id) });
  });

  it('likeEventCandidates excludes unpublished events but keeps ended ones', async () => {
    const draft = await seedEvent('E2', EventStatus.DRAFT);
    const ended = await seedEvent('E3');
    await Event.updateOne({ _id: ended.event._id }, { $set: { endTime: new Date(Date.now() - 30 * DAY) } });
    const buyer = await Buyer.create({ phone: '+26878100002', password: 'password123' });
    await EventReaction.create({ eventId: draft.event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: ended.event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const { candidates: rows } = await likeEventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target!.id).toBe(String(ended.event._id));
  });

  it('likePostCandidates maps a vendor actor and drops removed posts', async () => {
    const { vendor } = await seedEvent('E4');
    const live = await seedPost(vendor._id);
    const removed = await seedPost(vendor._id);
    await Update.updateOne({ _id: removed._id }, { $set: { status: 'removed' } });
    await UpdateReaction.create({ updateId: live._id, buyerId: vendor._id, actorType: 'vendor', type: 'like' });
    await UpdateReaction.create({ updateId: removed._id, buyerId: vendor._id, actorType: 'vendor', type: 'like' });

    const { candidates: rows } = await likePostCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('like_post');
    expect(rows[0]!.actor).toEqual({ kind: 'organizer', id: String(vendor._id) });
    expect(rows[0]!.target).toEqual({ kind: 'post', id: String(live._id) });
  });

  it('followCandidates maps buyer and organizer targets', async () => {
    const buyer = await Buyer.create({ phone: '+26878100003', password: 'password123' });
    const other = await Buyer.create({ phone: '+26878100004', password: 'password123' });
    const { vendor } = await seedEvent('E5');
    await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'buyer', targetId: other._id });
    await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'organizer', targetId: vendor._id });

    const { candidates: rows } = await followCandidates({ limit: 20 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target!.kind).sort()).toEqual(['buyer', 'organizer']);
    expect(rows.every((r) => r.type === 'follow')).toBe(true);
  });

  it('postCandidates returns ready active posts only', async () => {
    const { vendor } = await seedEvent('E6');
    const ok = await seedPost(vendor._id);
    const pending = await Update.create({
      authorType: 'vendor', authorId: vendor._id, kind: 'video', caption: '',
      media: { rawKey: 'k2', status: 'processing' },
    });

    const { candidates: rows } = await postCandidates({ limit: 20 });
    // The processing post is excluded: its media is not ready, so it would
    // render as a broken thumbnail in the feed.
    expect(rows.map((r) => r.target!.id)).toEqual([String(ok._id)]);
    expect(rows.map((r) => r.target!.id)).not.toContain(String(pending._id));
    expect(rows[0]!.actor).toEqual({ kind: 'organizer', id: String(vendor._id) });
  });

  it('eventCandidates returns published events with the vendor as actor', async () => {
    const { vendor, event } = await seedEvent('E7');
    await seedEvent('E8', EventStatus.DRAFT);

    const { candidates: rows } = await eventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('event');
    expect(rows[0]!.actor).toEqual({ kind: 'organizer', id: String(vendor._id) });
    expect(rows[0]!.target).toEqual({ kind: 'event', id: String(event._id) });
  });

  it('eventCandidates ranks a no-publishedAt event by its own createdAt, not below every dated one', async () => {
    // Legacy row: publishedAt set, but old (5 days ago).
    const { event: dated } = await seedEvent('E10');
    await Event.updateOne({ _id: dated._id }, { $set: { publishedAt: new Date(Date.now() - 5 * DAY) } });

    // A row missing publishedAt entirely (e.g. a bulk import / admin backfill
    // that set status: PUBLISHED without stamping publishedAt), but recently
    // created (1 day ago) — must still rank ABOVE the older dated row.
    // Mongoose strips $unset-via-updateOne the same way it strips createdAt
    // $set under `timestamps: true`, so this goes through the raw driver too.
    const { event: undated } = await seedEvent('E11');
    await Event.collection.updateOne(
      { _id: undated._id },
      { $unset: { publishedAt: '' }, $set: { createdAt: new Date(Date.now() - DAY) } }
    );

    const { candidates: rows } = await eventCandidates({ limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target!.id).toBe(String(undated._id));
  });

  it('eventCandidates attributes a self-listed event to its buyer author', async () => {
    const buyer = await Buyer.create({ phone: '+26878100010', password: 'password123' });
    const { event: selfListed } = await seedEvent('E12');
    // A buyer self-listed event has vendorId cleared and submittedByBuyerId
    // set instead — simulate via the raw driver, since Mongoose's
    // conditional `required` validator on `vendorId` only fires through
    // `.create()`/`.save()`, not a bare $unset/$set.
    await Event.collection.updateOne(
      { _id: selfListed._id },
      { $unset: { vendorId: '' }, $set: { submittedByBuyerId: buyer._id } }
    );

    const { candidates: rows } = await eventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target!.id).toBe(String(selfListed._id));
    expect(rows[0]!.actor).toEqual({ kind: 'buyer', id: String(buyer._id) });
  });

  it('eventCandidates still attributes a vendor-created event to its organizer (no regression)', async () => {
    const { vendor, event } = await seedEvent('E12b');
    const { candidates: rows } = await eventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target!.id).toBe(String(event._id));
    expect(rows[0]!.actor).toEqual({ kind: 'organizer', id: String(vendor._id) });
  });

  it('eventCandidates skips an event with neither vendorId nor submittedByBuyerId and does not throw', async () => {
    const { event: withVendor } = await seedEvent('E12c');
    const { event: orphaned } = await seedEvent('E13');
    // Neither field present — no one to attribute the announcement to.
    await Event.collection.updateOne({ _id: orphaned._id }, { $unset: { vendorId: '' } });

    const { candidates: rows } = await eventCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target!.id).toBe(String(withVendor._id));
    expect(rows.some((r) => r.target!.id === String(orphaned._id))).toBe(false);
  });

  it('following tab: a viewer following the self-listing buyer sees that event row', async () => {
    const buyer = await Buyer.create({ phone: '+26878100011', password: 'password123' });
    const stranger = await Buyer.create({ phone: '+26878100012', password: 'password123' });
    const { event: byBuyer } = await seedEvent('E14');
    await Event.collection.updateOne(
      { _id: byBuyer._id },
      { $unset: { vendorId: '' }, $set: { submittedByBuyerId: buyer._id } }
    );
    const { event: byStranger } = await seedEvent('E15');
    await Event.collection.updateOne(
      { _id: byStranger._id },
      { $unset: { vendorId: '' }, $set: { submittedByBuyerId: stranger._id } }
    );

    const { candidates: rows } = await eventCandidates({ limit: 20, actorIds: [String(buyer._id)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target!.id).toBe(String(byBuyer._id));
    expect(rows[0]!.actor).toEqual({ kind: 'buyer', id: String(buyer._id) });
  });

  it('honours the before watermark', async () => {
    const buyer = await Buyer.create({ phone: '+26878100005', password: 'password123' });
    const a = await Buyer.create({ phone: '+26878100006', password: 'password123' });
    const b = await Buyer.create({ phone: '+26878100007', password: 'password123' });
    const older = await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'buyer', targetId: a._id });
    // Backdate through the raw driver: Mongoose 7 marks createdAt immutable under
    // `timestamps: true` and strips it from a $set, so Model.updateOne(..., {timestamps:false})
    // silently no-ops. Confirmed the hard way in Task 3.
    await Follow.collection.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 5 * DAY) } });
    const newer = await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'buyer', targetId: b._id });

    const { candidates: rows } = await followCandidates({ limit: 20, before: newer.createdAt as Date });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target!.id).toBe(String(a._id));
  });

  it('restricts to actorIds for the following tab', async () => {
    const { event } = await seedEvent('E9');
    const followed = await Buyer.create({ phone: '+26878100008', password: 'password123' });
    const stranger = await Buyer.create({ phone: '+26878100009', password: 'password123' });
    await EventReaction.create({ eventId: event._id, buyerId: followed._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: event._id, buyerId: stranger._id, actorType: 'buyer', type: 'like' });

    const { candidates: rows } = await likeEventCandidates({ limit: 20, actorIds: [String(followed._id)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor.id).toBe(String(followed._id));
    expect(mongoose.isValidObjectId(rows[0]!.actor.id)).toBe(true);
  });
});
