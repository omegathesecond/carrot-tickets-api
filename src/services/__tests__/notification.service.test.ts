import mongoose from 'mongoose';
import { NotificationService } from '@services/notification.service';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

describe('NotificationService recipient-actor', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lists/marks a vendor recipient independently of a buyer with the same id', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    await NotificationService.create('vendor', id, 'follow', 'New follower', 'A followed you', {});
    await NotificationService.create('buyer', id, 'follow', 'buyer one', 'x', {});

    const vendorInbox = await NotificationService.list('vendor', id, {});
    expect(vendorInbox.items).toHaveLength(1);
    expect(vendorInbox.unreadCount).toBe(1);
    expect(vendorInbox.items[0]!.title).toBe('New follower');

    await NotificationService.markRead('vendor', id);
    const after = await NotificationService.list('vendor', id, {});
    expect(after.unreadCount).toBe(0);
    // buyer inbox untouched
    expect((await NotificationService.list('buyer', id, {})).unreadCount).toBe(1);
  });
});
