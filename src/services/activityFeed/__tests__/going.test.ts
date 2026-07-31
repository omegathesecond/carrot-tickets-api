import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { goingCandidates } from '../going';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketStatus } from '@interfaces/ticket.interface';

const DAY = 86400000;

async function seedEvent(name: string, status: EventStatus = EventStatus.PUBLISHED) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  const event = await Event.create({
    vendorId: vendor._id, name, venue: 'V',
    eventDate: new Date(Date.now() + DAY), startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000),
    status, ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
  const community = await Community.create({ eventId: event._id, vendorId: vendor._id });
  return { vendor, event, community };
}

async function seedBuyer(phone: string) {
  return Buyer.create({ phone, password: 'password123', name: 'B' + phone });
}

/**
 * createdAt is set by timestamps, so override it explicitly after insert.
 *
 * Mongoose's `timestamps: true` plugin intercepts Model-level update calls
 * (updateOne/findOneAndUpdate/etc.) and strips any user-supplied `createdAt`
 * from the `$set` before it reaches Mongo — even with `{ timestamps: false }`
 * passed as an option (verified: that combination instead returns
 * `acknowledged: false` and persists nothing, on mongoose 7.8.7 +
 * mongodb-memory-server 11.2.0). Going through `.collection.updateOne`
 * bypasses the Mongoose middleware layer entirely and writes the raw
 * document, which is the only way to backdate a timestamped field here.
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

describe('goingCandidates', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns a going row for a community join', async () => {
    const { event, community } = await seedEvent('E1');
    const buyer = await seedBuyer('+26878000001');
    await joinAt(buyer._id, community._id, new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('going');
    expect(rows[0]!.actor).toEqual({ kind: 'buyer', id: String(buyer._id) });
    expect(rows[0]!.target).toEqual({ kind: 'event', id: String(event._id) });
  });

  it('returns a going row for a live ticket with no community join', async () => {
    const { vendor, event } = await seedEvent('E2');
    const buyer = await seedBuyer('+26878000002');
    await ticketAt(event._id, vendor._id, buyer.phone, new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor.id).toBe(String(buyer._id));
  });

  it('emits ONE row at the earlier timestamp when the buyer both joined and holds a ticket', async () => {
    const { vendor, event, community } = await seedEvent('E3');
    const buyer = await seedBuyer('+26878000003');
    const ticketTime = new Date(Date.now() - 5 * DAY); // earlier — owns the pair
    const joinTime = new Date(Date.now() - 1 * DAY);
    await ticketAt(event._id, vendor._id, buyer.phone, ticketTime);
    await joinAt(buyer._id, community._id, joinTime);

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sortAt.getTime()).toBe(ticketTime.getTime());
  });

  it('suppresses the twin row when both source rows land in the same window (same-window dedupe)', async () => {
    // NOTE: `before` is only an upper bound (`createdAt: { $lt: before }`),
    // so both the ticket and the join below are still inside this window —
    // this only proves the in-call `emitted` set works, not that the dedupe
    // survives across pages. See the next test for the genuine cross-window
    // case (the ticket and join land in DIFFERENT windows).
    const { vendor, event, community } = await seedEvent('E4');
    const buyer = await seedBuyer('+26878000004');
    const ticketTime = new Date(Date.now() - 5 * DAY);
    const joinTime = new Date(Date.now() - 1 * DAY);
    await ticketAt(event._id, vendor._id, buyer.phone, ticketTime);
    await joinAt(buyer._id, community._id, joinTime);

    const rows = await goingCandidates({ limit: 20, before: new Date(joinTime.getTime() + 1) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sortAt.getTime()).toBe(ticketTime.getTime());

    const deeper = await goingCandidates({ limit: 20, before: ticketTime });
    expect(deeper).toHaveLength(0);
  });

  it('suppresses the twin row even when the winning ticket is crowded out of its own window (cross-window dedupe)', async () => {
    // Genuine cross-page case: the buyer's ticket is far older than a pile of
    // OTHER live tickets, so with a small `limit` it never enters the ticket
    // sub-window at all — only the join does. A per-page-only dedupe would
    // see no competing row in this call and would wrongly emit the join. The
    // correct behaviour relies on step 4's UNWINDOWED lookup (no `before`,
    // no `limit`) to discover the older ticket anyway and suppress the join.
    const LIMIT = 3;
    const { vendor, event, community } = await seedEvent('E4B');
    const buyer = await seedBuyer('+26878000013');
    const ticketTime = new Date(Date.now() - 10 * DAY); // the true (older) winner
    const joinTime = new Date(Date.now() - 5 * DAY); // loses, and would be the
    // only row inside a `limit`-sized ticket window if the ticket weren't
    // crowded out entirely
    await ticketAt(event._id, vendor._id, buyer.phone, ticketTime);
    await joinAt(buyer._id, community._id, joinTime);

    // Crowd the ticket sub-window: >= LIMIT live tickets newer than
    // ticketTime, for buyers with no Carrot account (POS walk-ups), so the
    // window fills up with these before it ever reaches ticketTime.
    for (let i = 0; i < LIMIT; i++) {
      await ticketAt(event._id, vendor._id, `+2687899${9100 + i}`, new Date(Date.now() - (i + 1) * DAY));
    }

    const rows = await goingCandidates({ limit: LIMIT });
    const forPair = rows.filter((r) => r.actor.id === String(buyer._id) && r.target.id === String(event._id));
    expect(forPair).toHaveLength(0);
  });

  it('defers, but never permanently loses, a pair whose winning ticket a crowded window pushed out (boundary clamp)', async () => {
    // Reproduces the desync counter-example: buyer B's ticket (T) is crowded
    // out of the ticket sub-window by newer, unrelated tickets, while the
    // membership sub-window is not crowded and reaches back past T to a
    // BYSTANDER's own, older, unrelated join (M < T). If that bystander row
    // were emitted this call, a real caller would naturally set its next
    // `before` from it — landing below T and permanently skipping B's ticket
    // on every future page. The fix must withhold the bystander row here
    // too (not just B's pair), so the watermark can never fall below T.
    const LIMIT = 3;
    const { vendor, event, community } = await seedEvent('E4C');
    const buyer = await seedBuyer('+26878000020');
    const ticketTime = new Date(Date.now() - 10 * DAY); // B's true winner (T)
    const joinTime = new Date(Date.now() - 6 * DAY); // B's join, loses to T
    await ticketAt(event._id, vendor._id, buyer.phone, ticketTime);
    await joinAt(buyer._id, community._id, joinTime);

    const bystander = await seedBuyer('+26878000021');
    const bystanderJoinTime = new Date(Date.now() - 12 * DAY); // M < T
    await joinAt(bystander._id, community._id, bystanderJoinTime);

    // Crowd the ticket sub-window with LIMIT newer, unrelated live tickets
    // (POS walk-ups — no matching Carrot account, so they add no rows of
    // their own, only window pressure).
    const fillerTimes: Date[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const at = new Date(Date.now() - (i + 1) * DAY);
      fillerTimes.push(at);
      await ticketAt(event._id, vendor._id, `+2687899${9200 + i}`, at);
    }
    const boundary = fillerTimes[fillerTimes.length - 1]!.getTime(); // oldest fetched filler

    const page1 = await goingCandidates({ limit: LIMIT });
    expect(page1).toHaveLength(0);
    // General invariant, not just this scenario's specific count: nothing
    // below the boundary may ever be returned.
    for (const row of page1) {
      expect(row.sortAt.getTime()).toBeGreaterThanOrEqual(boundary);
    }
    expect(page1.some((r) => r.actor.id === String(bystander._id))).toBe(false);

    // A caller that never sets `before` below the guaranteed boundary can
    // still reach both withheld rows on a later call — deferred, not lost.
    const page2 = await goingCandidates({ limit: LIMIT, before: new Date(boundary + 1) });
    const recovered = page2.find((r) => r.actor.id === String(buyer._id) && r.target.id === String(event._id));
    expect(recovered).toBeDefined();
    expect(recovered!.sortAt.getTime()).toBe(ticketTime.getTime());
    const bystanderRow = page2.find((r) => r.actor.id === String(bystander._id));
    expect(bystanderRow).toBeDefined();
    expect(bystanderRow!.sortAt.getTime()).toBe(bystanderJoinTime.getTime());
  });

  it('skips a ticket whose phone matches no Carrot account (POS walk-up)', async () => {
    const { vendor, event } = await seedEvent('E5');
    await ticketAt(event._id, vendor._id, '+26878999999', new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(0);
  });

  it('excludes banned memberships and non-live tickets', async () => {
    const { vendor, event, community } = await seedEvent('E6');
    const banned = await seedBuyer('+26878000006');
    const refunded = await seedBuyer('+26878000007');
    const m = await joinAt(banned._id, community._id, new Date(Date.now() - DAY));
    await Membership.updateOne({ _id: m._id }, { $set: { bannedAt: new Date() } });
    await ticketAt(event._id, vendor._id, refunded.phone, new Date(Date.now() - DAY), TicketStatus.REFUNDED);

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(0);
  });

  it('excludes unpublished events but KEEPS ended ones', async () => {
    const draft = await seedEvent('E7', EventStatus.DRAFT);
    const ended = await seedEvent('E8');
    await Event.updateOne(
      { _id: ended.event._id },
      { $set: { endTime: new Date(Date.now() - 30 * DAY), eventDate: new Date(Date.now() - 30 * DAY) } }
    );
    const b1 = await seedBuyer('+26878000008');
    const b2 = await seedBuyer('+26878000009');
    await joinAt(b1._id, draft.community._id, new Date(Date.now() - DAY));
    await joinAt(b2._id, ended.community._id, new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target.id).toBe(String(ended.event._id));
  });

  it('restricts to actorIds when the following tab passes them', async () => {
    const { community } = await seedEvent('E9');
    const followed = await seedBuyer('+26878000010');
    const stranger = await seedBuyer('+26878000011');
    await joinAt(followed._id, community._id, new Date(Date.now() - DAY));
    await joinAt(stranger._id, community._id, new Date(Date.now() - DAY));

    const rows = await goingCandidates({ limit: 20, actorIds: [String(followed._id)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor.id).toBe(String(followed._id));
  });

  it('returns rows newest-first', async () => {
    const a = await seedEvent('EA');
    const b = await seedEvent('EB');
    const buyer = await seedBuyer('+26878000012');
    await joinAt(buyer._id, a.community._id, new Date(Date.now() - 5 * DAY));
    await joinAt(buyer._id, b.community._id, new Date(Date.now() - 1 * DAY));

    const rows = await goingCandidates({ limit: 20 });
    expect(rows.map((r) => r.target.id)).toEqual([String(b.event._id), String(a.event._id)]);
  });
});
