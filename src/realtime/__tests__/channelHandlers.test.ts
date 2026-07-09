import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { Channel } from '@models/channel.model';
import { CommunityService } from '@services/community.service';
import { startTestRealtime, connectClient, waitForEvent, TestRealtime } from './helpers';
import { Socket as ClientSocket } from 'socket.io-client';

const PHONE_A = '+26878422613';
const PHONE_B = '+26878000042';

function joinChannel(client: ClientSocket, channelId: string): Promise<any> {
  return new Promise((resolve) => client.emit('channel:join', { channelId }, resolve));
}

async function seedWorld() {
  const seeded = await seedPublishedEvent();
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
  const channels = await Channel.find({ communityId: community._id });
  const bySlug = Object.fromEntries(channels.map((c) => [c.slug, c]));
  const buyerA = await Buyer.create({ phone: PHONE_A, password: 'secret1', name: 'Alpha' });
  const buyerB = await Buyer.create({ phone: PHONE_B, password: 'secret1', name: 'Beta' });
  await Membership.create({ buyerId: buyerA._id, communityId: community._id });
  await Membership.create({ buyerId: buyerB._id, communityId: community._id });
  return { seeded, community, bySlug, buyerA, buyerB };
}

describe('channel handlers', () => {
  let rt: TestRealtime;
  const clients: ClientSocket[] = [];

  beforeAll(connectTestDb);
  beforeEach(async () => {
    rt = await startTestRealtime();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await rt.close();
    await clearTestDb();
  });
  afterAll(disconnectTestDb);

  async function client(phone: string): Promise<ClientSocket> {
    const c = await connectClient(rt.port, signBuyerToken(phone));
    clients.push(c);
    return c;
  }

  it('member joins an open channel, gets ack with presence', async () => {
    const { bySlug } = await seedWorld();
    const a = await client(PHONE_A);
    const ack = await joinChannel(a, String(bySlug['general']!._id));
    expect(ack).toEqual({ ok: true, presence: 1 });
  });

  it('non-member is refused', async () => {
    const { bySlug } = await seedWorld();
    await Buyer.create({ phone: '+26878000077', password: 'secret1' });
    const stranger = await client('+26878000077');
    const ack = await joinChannel(stranger, String(bySlug['general']!._id));
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/join the community/i);
  });

  it('gated channel refused without ticket; malformed channelId refused', async () => {
    const { bySlug } = await seedWorld();
    const a = await client(PHONE_A);

    const gated = await joinChannel(a, String(bySlug['attendees']!._id));
    expect(gated.ok).toBe(false);
    expect(gated.error).toMatch(/ticket holders only/i);

    const malformed = await joinChannel(a, 'not-a-channel-id');
    expect(malformed.ok).toBe(false);
  });

  it('second joiner triggers presence:update to the room; leave decrements', async () => {
    const { bySlug } = await seedWorld();
    const general = String(bySlug['general']!._id);

    const a = await client(PHONE_A);
    await joinChannel(a, general);

    const b = await client(PHONE_B);
    const [presence] = await Promise.all([
      waitForEvent<any>(a, 'presence:update'),
      joinChannel(b, general),
    ]);
    expect(presence).toEqual({ channelId: general, count: 2 });

    const [afterLeave] = await Promise.all([
      waitForEvent<any>(a, 'presence:update'),
      (async () => b.emit('channel:leave', { channelId: general }))(),
    ]);
    expect(afterLeave).toEqual({ channelId: general, count: 1 });
  });

  it('typing forwards to OTHER room members only, with username', async () => {
    const { bySlug } = await seedWorld();
    const general = String(bySlug['general']!._id);
    const a = await client(PHONE_A);
    const b = await client(PHONE_B);
    await joinChannel(a, general);
    await joinChannel(b, general);

    const [typing] = await Promise.all([
      waitForEvent<any>(a, 'typing'),
      (async () => b.emit('typing', { channelId: general }))(),
    ]);
    expect(typing.channelId).toBe(general);
    expect(typeof typing.username).toBe('string');
  });

  it('typing from a socket NOT in the room is dropped', async () => {
    const { bySlug } = await seedWorld();
    const general = String(bySlug['general']!._id);
    const a = await client(PHONE_A);
    await joinChannel(a, general);

    const b = await client(PHONE_B); // connected, member, but never joined the room
    b.emit('typing', { channelId: general });

    await expect(waitForEvent(a, 'typing', 500)).rejects.toThrow(/timeout/);
  });

  it('disconnect broadcasts a presence decrement', async () => {
    const { bySlug } = await seedWorld();
    const general = String(bySlug['general']!._id);
    const a = await client(PHONE_A);
    const b = await client(PHONE_B);
    await joinChannel(a, general);
    await joinChannel(b, general);

    const [presence] = await Promise.all([
      waitForEvent<any>(a, 'presence:update', 5000),
      (async () => b.close())(),
    ]);
    expect(presence).toEqual({ channelId: general, count: 1 });
  });
});
