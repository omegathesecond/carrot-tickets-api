import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { getActivityFeed } from '../index';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Follow } from '@models/follow.model';
import { EventReaction } from '@models/eventReaction.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketStatus } from '@interfaces/ticket.interface';

const DAY = 86400000;

async function seedVendorEvent(name: string) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  const event = await Event.create({
    vendorId: vendor._id, name, venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED, publishedAt: new Date(Date.now() - DAY),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
  return { vendor, event };
}

async function seedVendorEventWithCommunity(name: string) {
  const { vendor, event } = await seedVendorEvent(name);
  const community = await Community.create({ eventId: event._id, vendorId: vendor._id });
  return { vendor, event, community };
}

/**
 * createdAt is set by timestamps, so override it explicitly after insert.
 *
 * Mongoose's `timestamps: true` plugin intercepts Model-level update calls
 * (updateOne/findOneAndUpdate/etc.) and strips any user-supplied `createdAt`
 * from the `$set` before it reaches Mongo — even with `{ timestamps: false }`
 * passed as an option. Going through `.collection.updateOne` bypasses the
 * Mongoose middleware layer entirely and writes the raw document, which is
 * the only way to backdate a timestamped field here. (Same trap noted in
 * going.test.ts / sources.test.ts.)
 */
async function joinAt(buyerId: any, communityId: any, at: Date) {
  const m = await Membership.create({ buyerId, communityId });
  await Membership.collection.updateOne({ _id: m._id }, { $set: { createdAt: at } });
  return m;
}

async function ticketAt(eventId: any, vendorId: any, phone: string, at: Date, status = TicketStatus.SOLD) {
  const t = await Ticket.create({
    eventId, vendorId, ticketId: 'T' + Math.random().toString(36).slice(2, 10),
    customerPhone: phone, customerName: 'B', ticketType: 'GA', price: 100, status,
  });
  await Ticket.collection.updateOne({ _id: t._id }, { $set: { createdAt: at } });
  return t;
}

describe('getActivityFeed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns rows newest-first across sources', async () => {
    const { event } = await seedVendorEvent('E1');
    const a = await Buyer.create({ phone: '+26878300001', password: 'password123', username: 'usr_a' });
    const b = await Buyer.create({ phone: '+26878300002', password: 'password123', username: 'usr_b' });
    await EventReaction.create({ eventId: event._id, buyerId: a._id, actorType: 'buyer', type: 'like' });
    await Follow.create({ followerType: 'buyer', followerId: b._id, targetType: 'buyer', targetId: a._id });

    const { items } = await getActivityFeed({ tab: 'everyone', limit: 30 });
    const types = items.map((i) => i.type);
    expect(types).toContain('like_event');
    expect(types).toContain('follow');
    expect(types).toContain('event');
    const stamps = items.map((i) => Date.parse(i.sortAt));
    expect([...stamps].sort((x, y) => y - x)).toEqual(stamps);
  });

  it('pages without duplicates or gaps', async () => {
    const { event } = await seedVendorEvent('E2');
    for (let i = 0; i < 12; i++) {
      const buyer = await Buyer.create({ phone: `+2687840${String(i).padStart(4, '0')}`, password: 'password123', username: `usr${i}` });
      await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res: any = await getActivityFeed({ tab: 'everyone', limit: 5, cursor });
      seen.push(...res.items.map((i: any) => i.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);            // no duplicates
    expect(seen.filter((id) => id.startsWith('like_event:'))).toHaveLength(12); // no gaps
  });

  it('treats a malformed cursor as "start from newest"', async () => {
    const { event } = await seedVendorEvent('E3');
    const buyer = await Buyer.create({ phone: '+26878300003', password: 'password123', username: 'usr_m' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const { items } = await getActivityFeed({ tab: 'everyone', limit: 30, cursor: 'not-base64-json' });
    expect(items.length).toBeGreaterThan(0);
  });

  it('clamps limit to 50', async () => {
    const res = await getActivityFeed({ tab: 'everyone', limit: 5000 });
    expect(res.items.length).toBeLessThanOrEqual(50);
  });

  it('following tab returns only followed actors, buyers AND organizers', async () => {
    const { vendor, event } = await seedVendorEvent('E4');
    const viewer = await Buyer.create({ phone: '+26878300004', password: 'password123', username: 'usr_v' });
    const friend = await Buyer.create({ phone: '+26878300005', password: 'password123', username: 'usr_f' });
    const stranger = await Buyer.create({ phone: '+26878300006', password: 'password123', username: 'usr_s' });
    await Follow.create({ followerType: 'buyer', followerId: viewer._id, targetType: 'buyer', targetId: friend._id });
    await Follow.create({ followerType: 'buyer', followerId: viewer._id, targetType: 'organizer', targetId: vendor._id });
    await EventReaction.create({ eventId: event._id, buyerId: friend._id, actorType: 'buyer', type: 'like' });
    await EventReaction.create({ eventId: event._id, buyerId: stranger._id, actorType: 'buyer', type: 'like' });

    const { items } = await getActivityFeed({
      tab: 'following', limit: 30, viewer: { type: 'buyer', id: String(viewer._id) },
    });
    const actorIds = items.map((i) => i.actor.id);
    expect(actorIds).toContain(String(friend._id));
    expect(actorIds).toContain(String(vendor._id)); // the organizer's own "announced" row
    expect(actorIds).not.toContain(String(stranger._id));
  });

  it('nextCursor is null when history is exhausted', async () => {
    const { event } = await seedVendorEvent('E5');
    const buyer = await Buyer.create({ phone: '+26878300007', password: 'password123', username: 'usr_x' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    let cursor: string | undefined;
    let last: any;
    for (let page = 0; page < 10; page++) {
      last = await getActivityFeed({ tab: 'everyone', limit: 30, cursor });
      if (!last.nextCursor) break;
      cursor = last.nextCursor;
    }
    expect(last.nextCursor).toBeNull();
  });

  // --- Fix-round-1 regressions ------------------------------------------

  it('does not lose a valid row when a source scans a full window but filters every fetched row to zero (Finding 1)', async () => {
    // A source that filters AFTER its DB `.limit()` (likeEventCandidates
    // filters by `published` post-fetch) must be judged by how far it
    // SCANNED, not by how many rows SURVIVED — otherwise a page that
    // legitimately fetched `limit` rows and kept none of them (e.g. every
    // one of them belongs to an event the organizer just unpublished) reads
    // as "this source is drained," and a real, valid, older row sitting just
    // below the scan floor becomes permanently unreachable.
    const LIMIT = 5;
    const { event: hiddenEvent } = await seedVendorEvent('F1Hidden');
    const { event: validEvent } = await seedVendorEvent('F1Valid');

    // Exactly LIMIT recent likes on the event we are about to unpublish —
    // enough to fill likeEventCandidates' own DB fetch entirely (a "full
    // window"), guaranteeing it reports a non-null scan floor.
    for (let i = 0; i < LIMIT; i++) {
      const buyer = await Buyer.create({
        phone: `+2687850${String(i).padStart(4, '0')}`, password: 'password123', username: `f1h${i}`,
      });
      await EventReaction.create({ eventId: hiddenEvent._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    }

    // One much older like on a STILL-published event, sitting below the
    // scan floor those 5 recent reactions establish.
    const validLiker = await Buyer.create({ phone: '+26878500999', password: 'password123', username: 'f1valid' });
    const validReaction = await EventReaction.create({
      eventId: validEvent._id, buyerId: validLiker._id, actorType: 'buyer', type: 'like',
    });
    await EventReaction.collection.updateOne(
      { _id: validReaction._id },
      { $set: { createdAt: new Date(Date.now() - 30 * DAY) } }
    );

    // Hide the newest 5 behind an unpublish. likeEventCandidates will still
    // fetch exactly those 5 (a full window, because they're the newest
    // `type: 'like'` rows in the whole collection) and filter every one of
    // them out.
    await Event.updateOne({ _id: hiddenEvent._id }, { $set: { status: EventStatus.PENDING_APPROVAL } });

    const page1 = await getActivityFeed({ tab: 'everyone', limit: LIMIT });
    // The core assertion: a page that filtered a full window to zero must
    // NOT report itself exhausted — there is more to look at below the
    // floor it scanned.
    expect(page1.nextCursor).not.toBeNull();

    const seenTypes: string[] = [];
    seenTypes.push(...page1.items.map((i) => i.type));
    let cursor: string | undefined = page1.nextCursor ?? undefined;
    for (let page = 0; page < 10 && cursor; page++) {
      const res = await getActivityFeed({ tab: 'everyone', limit: LIMIT, cursor });
      seenTypes.push(...res.items.map((i) => i.type));
      cursor = res.nextCursor ?? undefined;
    }
    // The only like_event row that can EVER survive is the valid, older one
    // (the 5 hidden ones are permanently unpublished) — so its mere presence
    // across pages proves it wasn't lost behind the false-exhausted bug.
    expect(seenTypes).toContain('like_event');
  });

  it('does not lose a source\'s unconsumed candidates when they are simply outranked on the page, not drained (Finding 5)', async () => {
    // A source can produce real candidates that never make the `limit`-sized
    // page because other sources are busier and rank above them — that is
    // NOT the same as the source having nothing left. Round 1 fixed the
    // "scanned full, filtered to zero" case (Finding 1) but introduced a
    // narrower regression: the floor-advance arm fired whenever nothing of
    // that type was CONSUMED, even when the source had plenty of unconsumed
    // candidates sitting just below the page cut. Advancing straight to the
    // scan floor in that case jumps clean over them.
    const LIMIT = 5;
    const { event } = await seedVendorEvent('F5');

    // Five recent likes: a full fetch for likeEventCandidates (publishes its
    // own floor) and, being the newest rows in the whole DB, exactly fill
    // page 1 on their own.
    for (let i = 0; i < LIMIT; i++) {
      const buyer = await Buyer.create({
        phone: `+2687860${String(i).padStart(4, '0')}`, password: 'password123', username: `f5l${i}`,
      });
      await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    }

    // Five OLDER follow rows: also a full fetch for followCandidates (also
    // publishes its own floor), but every one of them legitimately ranks
    // below the five likes above and so does not make page 1.
    const follower = await Buyer.create({ phone: '+26878600099', password: 'password123', username: 'f5follower' });
    const followIds: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const target = await Buyer.create({
        phone: `+2687860${100 + i}`, password: 'password123', username: `f5t${i}`,
      });
      const follow = await Follow.create({
        followerType: 'buyer', followerId: follower._id, targetType: 'buyer', targetId: target._id,
      });
      await Follow.collection.updateOne({ _id: follow._id }, { $set: { createdAt: new Date(Date.now() - (10 + i) * DAY) } });
      followIds.push(String(follow._id));
    }

    const page1 = await getActivityFeed({ tab: 'everyone', limit: LIMIT });
    // Page 1 is legitimately all five likes — the follows are older and
    // correctly lose the ranking, not the bug being tested here.
    expect(page1.items.every((i) => i.type === 'like_event')).toBe(true);

    // The bug: `follow`'s cursor key used to jump straight to its scan floor
    // (the OLDEST of the five follows) after page 1, even though none of the
    // five follows had been consumed yet — permanently skipping all five on
    // page 2 (`createdAt < floor` excludes everything at or above it, i.e.
    // every follow that still legitimately exists).
    let cursor: string | undefined = page1.nextCursor ?? undefined;
    const seenFollowIds: string[] = [];
    for (let page = 0; page < 5 && cursor; page++) {
      const res = await getActivityFeed({ tab: 'everyone', limit: LIMIT, cursor });
      seenFollowIds.push(...res.items.filter((i) => i.type === 'follow').map((i) => i.id));
      cursor = res.nextCursor ?? undefined;
    }
    for (const id of followIds) {
      expect(seenFollowIds).toContain(`follow:${id}`);
    }
  });

  it('drops a cursor key whose value is not a parseable date instead of throwing (Finding 2)', async () => {
    const { event } = await seedVendorEvent('F2');
    const buyer = await Buyer.create({ phone: '+26878300010', password: 'password123', username: 'f2buyer' });
    await EventReaction.create({ eventId: event._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    // Syntactically valid JSON, base64url-encoded exactly like a real
    // cursor — but the `le` (like_event) watermark is junk. Pre-fix, this
    // reached `new Date('not-a-date')` unchecked and blew up the downstream
    // Mongoose query with a CastError instead of starting that source fresh.
    const junkCursor = Buffer.from(JSON.stringify({ le: 'not-a-date' })).toString('base64url');

    const { items } = await getActivityFeed({ tab: 'everyone', limit: 30, cursor: junkCursor });
    expect(items.map((i) => i.type)).toContain('like_event');
  });

  it('throws rather than silently returning a global feed when tab is "following" with no viewer (Finding 3)', async () => {
    // opts.viewer is optional in the type, so this is reachable at runtime.
    // `followerId: undefined` gets stripped by Mongoose and would otherwise
    // degrade the query to "every follow of this type on the platform."
    await expect(getActivityFeed({ tab: 'following', limit: 30 })).rejects.toThrow();
  });

  it('going: the merge cursor advances to a published floor even when zero going candidates are consumed, and never skips past it (Finding 4)', async () => {
    // Reproduces going.test.ts's own "publishes nextBefore" scenario, but
    // driven through getActivityFeed's merge/cursor layer, which is the
    // thing that was previously untested: a real, membership-backed pair
    // sits below the boundary a crowded ticket sub-window creates. Page 1
    // must consume nothing for `going` yet still advance its cursor key to
    // the published floor (or page 2 would re-issue the identical query and
    // wedge forever); page 2 must then recover the deferred pair (proving
    // the key never advanced PAST the floor, which would have skipped it).
    const LIMIT = 3;
    const { vendor, event, community } = await seedVendorEventWithCommunity('F4A');
    const buyer = await Buyer.create({ phone: '+26878600010', password: 'password123', username: 'f4abuyer' });
    const joinTime = new Date(Date.now() - 10 * DAY); // the real pair, crowded below the boundary
    await joinAt(buyer._id, community._id, joinTime);

    // POS walk-up tickets: no matching Buyer account, so they add ticket-
    // window pressure without contributing candidates of their own.
    const fillerTimes: Date[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const at = new Date(Date.now() - (i + 1) * DAY);
      fillerTimes.push(at);
      await ticketAt(event._id, vendor._id, `+2687869${9500 + i}`, at);
    }
    const boundary = fillerTimes[fillerTimes.length - 1]!.getTime();

    const page1 = await getActivityFeed({ tab: 'everyone', limit: LIMIT });
    expect(page1.items.some((i) => i.type === 'going')).toBe(false);
    expect(page1.nextCursor).not.toBeNull();

    // Decode the cursor directly to pin down the exact rule being tested:
    // the `g` watermark must equal the published floor, not be left unset.
    const decoded = JSON.parse(Buffer.from(page1.nextCursor!, 'base64url').toString('utf8'));
    expect(decoded.g).toBe(new Date(boundary).toISOString());

    // Rule 1 (never advance past the floor): if the merge had instead left
    // `g` unset, or advanced it past the boundary, this page would still
    // return nothing for the buyer's deferred pair.
    const page2 = await getActivityFeed({ tab: 'everyone', limit: LIMIT, cursor: page1.nextCursor! });
    const goingRow = page2.items.find((i) => i.type === 'going' && i.actor.id === String(buyer._id));
    expect(goingRow).toBeDefined();
    expect(Date.parse(goingRow!.sortAt)).toBe(joinTime.getTime());
  });

  it('going: a deferred twin pair (ticket winner crowded out, membership loser scanned) is recovered on the next page, not skipped (Finding 4)', async () => {
    // Complements the previous test with going.test.ts's fuller "boundary
    // clamp" scenario: the buyer's TICKET is the true (older) winner of the
    // dedupe pair but is crowded out of this call's ticket sub-window, while
    // a bystander's unrelated, even older join is scanned but withheld by
    // the same boundary. Both must surface — recovered, not lost — once the
    // cursor's `g` watermark reaches them.
    const LIMIT = 3;
    const { vendor, event, community } = await seedVendorEventWithCommunity('F4B');
    const buyer = await Buyer.create({ phone: '+26878600020', password: 'password123', username: 'f4bbuyer' });
    const ticketTime = new Date(Date.now() - 10 * DAY); // buyer's true (older) winner
    const joinTime = new Date(Date.now() - 6 * DAY); // buyer's join, loses to the ticket
    await ticketAt(event._id, vendor._id, buyer.phone!, ticketTime);
    await joinAt(buyer._id, community._id, joinTime);

    const bystander = await Buyer.create({ phone: '+26878600021', password: 'password123', username: 'f4bystandr' });
    const bystanderJoinTime = new Date(Date.now() - 12 * DAY); // older than the ticket boundary too
    await joinAt(bystander._id, community._id, bystanderJoinTime);

    for (let i = 0; i < LIMIT; i++) {
      await ticketAt(event._id, vendor._id, `+2687869${9600 + i}`, new Date(Date.now() - (i + 1) * DAY));
    }

    const page1 = await getActivityFeed({ tab: 'everyone', limit: LIMIT });
    expect(page1.items.some((i) => i.type === 'going')).toBe(false);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getActivityFeed({ tab: 'everyone', limit: LIMIT, cursor: page1.nextCursor! });
    const goingActorIds = page2.items.filter((i) => i.type === 'going').map((i) => i.actor.id);
    expect(goingActorIds).toContain(String(buyer._id));
    expect(goingActorIds).toContain(String(bystander._id));
  });
});
