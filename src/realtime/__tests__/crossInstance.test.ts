import { clearTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { Channel } from '@models/channel.model';
import { CommunityService } from '@services/community.service';
import {
  startTestRealtime,
  connectClient,
  waitForEvent,
  TestRealtime,
  connectAdapterTestDb,
  disconnectAdapterTestDb,
} from './helpers';
import { Socket as ClientSocket } from 'socket.io-client';

const PHONE_A = '+26878422613';
const PHONE_B = '+26878000042';

describe('cross-instance fan-out via mongo adapter', () => {
  let rt1: TestRealtime;
  let rt2: TestRealtime;
  const clients: ClientSocket[] = [];

  beforeAll(connectAdapterTestDb);
  beforeEach(async () => {
    rt1 = await startTestRealtime(true);
    rt2 = await startTestRealtime(true);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await rt1.close();
    await rt2.close();
    await clearTestDb();
  });
  afterAll(disconnectAdapterTestDb);

  it('presence spans instances: join on server2 updates a client on server1', async () => {
    const seeded = await seedPublishedEvent();
    const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
    const general = String(
      (await Channel.findOne({ communityId: community._id, slug: 'general' }))!._id
    );
    const a = await Buyer.create({ phone: PHONE_A, password: 'secret1' });
    const b = await Buyer.create({ phone: PHONE_B, password: 'secret1' });
    await Membership.create({ buyerId: a._id, communityId: community._id });
    await Membership.create({ buyerId: b._id, communityId: community._id });

    const clientA = await connectClient(rt1.port, signBuyerToken(PHONE_A));
    clients.push(clientA);
    await new Promise((resolve) => clientA.emit('channel:join', { channelId: general }, resolve));

    const clientB = await connectClient(rt2.port, signBuyerToken(PHONE_B));
    clients.push(clientB);

    const [presenceOnA, joinAckB] = await Promise.all([
      waitForEvent<any>(clientA, 'presence:update', 8000),
      new Promise<any>((resolve) => clientB.emit('channel:join', { channelId: general }, resolve)),
    ]);

    expect(joinAckB.ok).toBe(true);
    expect(presenceOnA.channelId).toBe(general);
    expect(presenceOnA.count).toBe(2); // distinct buyers across BOTH instances
  }, 20000);
});
