import mongoose from 'mongoose';
import { Notification } from '@models/notification.model';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

describe('Notification recipientType', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('defaults recipientType to buyer and accepts the follow type', async () => {
    const n = await Notification.create({ recipientId: new mongoose.Types.ObjectId(), type: 'follow', title: 'New follower', body: 'x', data: {} });
    expect(n.recipientType).toBe('buyer');
    expect(n.type).toBe('follow');
  });

  it('stores a vendor recipient', async () => {
    const n = await Notification.create({ recipientId: new mongoose.Types.ObjectId(), recipientType: 'vendor', type: 'follow', title: 'x', body: 'y', data: {} });
    expect(n.recipientType).toBe('vendor');
  });
});
