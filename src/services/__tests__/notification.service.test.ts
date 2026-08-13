import mongoose from 'mongoose';
import { NotificationService } from '@services/notification.service';
import { Notification } from '@models/notification.model';
import { Buyer } from '@models/buyer.model';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

describe('NotificationService recipient-actor', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  // "Read doesn't work" for OLD rows: a legacy row can carry `readAt: null`
  // (present-but-null) rather than the field being absent — the Mongoose model
  // never writes that on insert, but past data operations leave such rows.
  // list() treats null as unread (Boolean(null) === false) so the user SEES it,
  // yet markRead's `{ readAt: { $exists: false } }` filter matched only ABSENT,
  // so the row could never be cleared → "I keep seeing the same notification;
  // clicking doesn't wipe it." markRead must clear null-or-absent alike.
  it('marks a legacy row whose readAt is explicitly null (not absent) as read', async () => {
    const recipient = new mongoose.Types.ObjectId();
    await Notification.collection.insertOne({
      recipientType: 'buyer',
      recipientId: recipient,
      type: 'follow',
      title: 'Old one',
      body: 'followed you',
      data: {},
      readAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const before = await NotificationService.list('buyer', String(recipient), {});
    expect(before.items).toHaveLength(1);
    expect(before.items[0]!.read).toBe(false); // the user sees it as unread
    expect(before.unreadCount).toBe(1); // …and it counts toward the badge

    await NotificationService.markRead('buyer', String(recipient), [String(before.items[0]!.id)]);

    const after = await NotificationService.list('buyer', String(recipient), {});
    expect(after.items[0]!.read).toBe(true); // it actually clears now
    expect(after.unreadCount).toBe(0);
  });

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
