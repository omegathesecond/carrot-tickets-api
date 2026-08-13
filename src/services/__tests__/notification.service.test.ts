import mongoose from 'mongoose';
import { NotificationService } from '@services/notification.service';
import { Buyer } from '@models/buyer.model';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

describe('NotificationService recipient-actor', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  // A meetup notification carries the acting buyer as `data.buyerId` (requester
  // for meetup_request, accepter for meetup_accepted). Read-time hydration must
  // resolve that buyer so the row can show their avatar — otherwise it falls
  // back to a generic glyph. Regression guard for the two newest social types.
  it.each(['meetup_request', 'meetup_accepted'] as const)(
    'hydrates the acting buyer on a %s row',
    async (type) => {
      const recipient = new mongoose.Types.ObjectId().toString();
      const actor = await Buyer.create({ password: 'secret123', email: 'ada@example.com', name: 'Ada', username: 'ada', avatarUrl: 'https://cdn/ada.jpg' });
      await NotificationService.create('buyer', recipient, type, 'Ada', 'wants to meet up', {
        buyerId: String(actor._id),
        username: 'ada',
        meetupId: new mongoose.Types.ObjectId().toString(),
      });

      const inbox = await NotificationService.list('buyer', recipient, {});
      expect(inbox.items[0]!.actor).toMatchObject({
        type: 'buyer',
        id: String(actor._id),
        name: 'Ada',
        avatarUrl: 'https://cdn/ada.jpg',
        username: 'ada',
      });
    },
  );

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
