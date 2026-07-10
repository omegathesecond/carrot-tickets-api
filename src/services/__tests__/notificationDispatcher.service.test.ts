jest.mock('@services/push.service', () => ({
  PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@utils/buyerOnline.util', () => ({
  isBuyerOnline: jest.fn().mockResolvedValue(false),
  PRESENCE_STALE_MS: 120000,
}));
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Notification } from '@models/notification.model';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { NotificationService } from '@services/notification.service';
import { PushService } from '@services/push.service';
import { isBuyerOnline } from '@utils/buyerOnline.util';

const push = PushService.sendToBuyer as jest.Mock;
const online = isBuyerOnline as jest.Mock;

describe('NotificationDispatcher', () => {
  beforeAll(connectTestDb);
  beforeEach(() => {
    push.mockClear();
    online.mockReset();
    online.mockResolvedValue(false);
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('writes inbox + pushes offline recipients; dedupes; respects per-category prefs', async () => {
    const a = await Buyer.create({ phone: '+26878000001', password: 'secret1' });
    const b = await Buyer.create({
      phone: '+26878000002', password: 'secret1',
      notificationPrefs: { announcements: false, dms: true, mentions: true, social: true, reminders: true },
    });

    await NotificationDispatcher.dispatch(
      [String(a._id), String(a._id), String(b._id)],
      'announcement', 'Piano Republic', 'Gates open 18:00', { eventId: 'e1' }
    );

    // a: inbox + push. b: toggled off announcements -> neither.
    expect(await Notification.countDocuments({ recipientId: a._id })).toBe(1);
    expect(await Notification.countDocuments({ recipientId: b._id })).toBe(0);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(String(a._id), {
      title: 'Piano Republic', body: 'Gates open 18:00', data: { eventId: 'e1', type: 'announcement' },
    });
  });

  it('online recipients get inbox but NO push', async () => {
    const a = await Buyer.create({ phone: '+26878000001', password: 'secret1' });
    online.mockResolvedValue(true);

    await NotificationDispatcher.dispatch([String(a._id)], 'dm', 'Beta', 'hey', { threadId: 't1' });
    expect(await Notification.countDocuments({ recipientId: a._id })).toBe(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('dispatchAsync never rejects the caller and logs failures loudly', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    online.mockRejectedValue(new Error('presence exploded'));
    const a = await Buyer.create({ phone: '+26878000001', password: 'secret1' });

    expect(() =>
      NotificationDispatcher.dispatchAsync([String(a._id)], 'friend', 'X', 'friended you', {})
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[notify]'), expect.anything());
    consoleSpy.mockRestore();
  });

  it('one failing recipient never drops the rest of the fan-out', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const a = await Buyer.create({ phone: '+26878000001', password: 'secret1' });
    const b = await Buyer.create({ phone: '+26878000002', password: 'secret1' });

    const createSpy = jest
      .spyOn(NotificationService, 'create')
      .mockRejectedValueOnce(new Error('transient write failure'));
    try {
      await NotificationDispatcher.dispatch(
        [String(a._id), String(b._id)],
        'dm', 'T', 'B', {}
      );
    } finally {
      createSpy.mockRestore();
    }

    // exactly one of the two got dropped; the other landed
    expect(await Notification.countDocuments({})).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[notify] recipient'), expect.anything());
    consoleSpy.mockRestore();
  });
});
