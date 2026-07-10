jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));
import webpush from 'web-push';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { PushSubscription } from '@models/pushSubscription.model';
import { PushService } from '@services/push.service';

const send = webpush.sendNotification as jest.Mock;

describe('PushService', () => {
  beforeAll(connectTestDb);
  beforeEach(() => send.mockReset());
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedSub(buyerId: string, endpoint: string) {
    return PushSubscription.create({ buyerId, endpoint, keys: { p256dh: 'p', auth: 'a' } });
  }

  it('sends to every subscription of the buyer with the JSON payload', async () => {
    const buyer = await Buyer.create({ phone: '+26878000001', password: 'secret1' });
    await seedSub(String(buyer._id), 'https://push.example/1');
    await seedSub(String(buyer._id), 'https://push.example/2');
    send.mockResolvedValue({ statusCode: 201 });

    await PushService.sendToBuyer(String(buyer._id), { title: 'T', body: 'B', data: { k: 'v' } });
    expect(send).toHaveBeenCalledTimes(2);
    const [subArg, payloadArg] = send.mock.calls[0]!;
    expect(subArg.endpoint).toBe('https://push.example/1');
    expect(JSON.parse(payloadArg)).toEqual({ title: 'T', body: 'B', data: { k: 'v' } });
  });

  it('deletes dead subscriptions (410) and never throws on errors', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const buyer = await Buyer.create({ phone: '+26878000001', password: 'secret1' });
    await seedSub(String(buyer._id), 'https://push.example/dead');
    await seedSub(String(buyer._id), 'https://push.example/erroring');
    send
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockRejectedValueOnce(new Error('network sadness'));

    await expect(
      PushService.sendToBuyer(String(buyer._id), { title: 'T', body: 'B', data: {} })
    ).resolves.toBeUndefined();

    expect(await PushSubscription.countDocuments({ endpoint: 'https://push.example/dead' })).toBe(0);
    expect(await PushSubscription.countDocuments({ endpoint: 'https://push.example/erroring' })).toBe(1);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('no subscriptions → no send calls', async () => {
    const buyer = await Buyer.create({ phone: '+26878000001', password: 'secret1' });
    await PushService.sendToBuyer(String(buyer._id), { title: 'T', body: 'B', data: {} });
    expect(send).not.toHaveBeenCalled();
  });
});
