import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Message } from '@models/message.model';

const oid = () => new mongoose.Types.ObjectId();

describe('Message channel/dm exclusivity', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('accepts a dm message (dmThreadId only)', async () => {
    const m = await Message.create({ dmThreadId: oid(), senderId: oid(), body: 'dm hello' });
    expect(m.dmThreadId).toBeDefined();
    expect(m.channelId).toBeUndefined();
  });

  it('accepts a channel message (channelId + communityId)', async () => {
    const m = await Message.create({ channelId: oid(), communityId: oid(), senderId: oid(), body: 'ch hello' });
    expect(m.channelId).toBeDefined();
  });

  it('rejects both, neither, and channel-without-community', async () => {
    await expect(Message.create({ senderId: oid(), body: 'x' })).rejects.toThrow(/exactly one/i);
    await expect(
      Message.create({ channelId: oid(), communityId: oid(), dmThreadId: oid(), senderId: oid(), body: 'x' })
    ).rejects.toThrow(/exactly one/i);
    await expect(Message.create({ channelId: oid(), senderId: oid(), body: 'x' })).rejects.toThrow(/communityId/i);
  });
});
