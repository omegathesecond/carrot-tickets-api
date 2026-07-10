import mongoose from 'mongoose';
import { clearTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { Channel } from '@models/channel.model';
import { Message } from '@models/message.model';
import { CommunityService } from '@services/community.service';
import { MessageService } from '@services/message.service';
import { ModerationService } from '@services/moderation.service';
import { ensureUsername } from '@utils/username.util';
import { ensureAdapterCollection } from '../adapterCollection';
import { initSocketEmitter } from '../emitter';
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

describe('REST write path broadcasts to gateway rooms', () => {
  let rt: TestRealtime;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    await connectAdapterTestDb();
    const collection = await ensureAdapterCollection(mongoose.connection.db! as any);
    initSocketEmitter(collection);
  });
  beforeEach(async () => {
    rt = await startTestRealtime(true); // adapter-backed, same collection as the emitter
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await rt.close();
    await clearTestDb();
  });
  afterAll(disconnectAdapterTestDb);

  it('sendMessage lands as message:new on a subscribed client; delete as message:deleted', async () => {
    const seeded = await seedPublishedEvent();
    const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
    const general = (await Channel.findOne({ communityId: community._id, slug: 'general' }))!;

    const sender = await Buyer.create({ phone: PHONE_A, password: 'secret1', name: 'Sender' });
    // MessageService.sendMessage is called directly below (bypassing the REST
    // controller), so lazily assign the username the same way
    // message.controller.ts does before calling it — otherwise sender.username
    // stays unset and the live payload assertion below is flaky-by-design.
    await ensureUsername(sender);
    const listenerBuyer = await Buyer.create({ phone: PHONE_B, password: 'secret1' });
    await Membership.create({ buyerId: sender._id, communityId: community._id });
    await Membership.create({ buyerId: listenerBuyer._id, communityId: community._id });

    const listener = await connectClient(rt.port, signBuyerToken(PHONE_B));
    clients.push(listener);
    const ack = await new Promise<any>((resolve) =>
      listener.emit('channel:join', { channelId: String(general._id) }, resolve)
    );
    expect(ack.ok).toBe(true);

    const [live, sent] = await Promise.all([
      waitForEvent<any>(listener, 'message:new', 8000),
      MessageService.sendMessage(String(general._id), sender, { body: 'hello from REST' }),
    ]);
    expect(live.id).toBe(sent.id);
    expect(live.body).toBe('hello from REST');
    expect(live.sender.username).toBeTruthy();

    const [deleted] = await Promise.all([
      waitForEvent<any>(listener, 'message:deleted', 8000),
      MessageService.deleteOwnMessage(sent.id, sender),
    ]);
    expect(deleted).toEqual({ channelId: String(general._id), messageId: sent.id });
  }, 20000);

  it('organizer moderation delete-any broadcasts message:deleted identically to self-delete', async () => {
    const seeded = await seedPublishedEvent();
    const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
    const general = (await Channel.findOne({ communityId: community._id, slug: 'general' }))!;

    const sender = await Buyer.create({ phone: PHONE_A, password: 'secret1', name: 'Sender' });
    await ensureUsername(sender);
    const listenerBuyer = await Buyer.create({ phone: PHONE_B, password: 'secret1' });
    await Membership.create({ buyerId: sender._id, communityId: community._id });
    await Membership.create({ buyerId: listenerBuyer._id, communityId: community._id });

    const listener = await connectClient(rt.port, signBuyerToken(PHONE_B));
    clients.push(listener);
    const ack = await new Promise<any>((resolve) =>
      listener.emit('channel:join', { channelId: String(general._id) }, resolve)
    );
    expect(ack.ok).toBe(true);

    const sent = await MessageService.sendMessage(String(general._id), sender, { body: 'rule-breaking message' });

    // Organizer moderation delete-any, NOT self-delete — ModerationService
    // takes the already-fetched, already ownership-checked doc the way
    // ModerationController hands it over (see moderation.controller.ts), and
    // reuses MessageService.softDeleteChannelMessage under the hood. This
    // must emit the exact same `message:deleted` shape as self-delete above.
    const messageDoc = (await Message.findById(sent.id))!;
    const [deleted] = await Promise.all([
      waitForEvent<any>(listener, 'message:deleted', 8000),
      ModerationService.deleteMessage(messageDoc),
    ]);
    expect(deleted).toEqual({ channelId: String(general._id), messageId: sent.id });
  }, 20000);
});
