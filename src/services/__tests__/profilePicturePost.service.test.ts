import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Update } from '@models/update.model';
import { publishProfilePicture } from '@services/profilePicturePost.service';
import { backfillProfilePicturePosts } from '../../scripts/backfillProfilePicturePosts';
import { getFeed } from '@services/feed.service';
import { BuyerProfileController } from '@controllers/buyerProfile.controller';
import { postCandidates } from '@services/activityFeed/sources';
import { UpdateController } from '@controllers/update.controller';
import { R2Service } from '@utils/r2.service';

const avatar = (stamp = Date.now()) => `https://cdn.example.com/buyers/test/avatar/${stamp}-avatar.jpg`;
const seed = (avatarUrl?: string) => Buyer.create({ email: 'photo@example.com', password: 'secret6', avatarUrl });
const res = () => {
  const r: any = { req: { originalUrl: '/api/public/profile/avatar' } };
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

describe('profile picture posts', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(async () => { jest.restoreAllMocks(); await clearTestDb(); });
  afterAll(disconnectTestDb);

  it('backfills once, preserves source and existing posts, and uses the upload timestamp', async () => {
    const stamp = Date.now() - 86400000;
    const buyer = await seed(avatar(stamp));
    await Buyer.create({ email: 'no-photo@example.com', password: 'secret6' });
    expect(await backfillProfilePicturePosts()).toEqual({ created: 1, skipped: 0 });
    const post = (await Update.findOne())!;
    expect(post.createdAt.getTime()).toBe(stamp);
    expect(String(post.authorId)).toBe(String(buyer._id));
    expect(post.kind).toBe('image');
    expect(post.media[0]?.image?.url).toBe(buyer.avatarUrl);
    await Update.updateOne({ _id: post._id }, { $set: { caption: 'keep me', status: 'removed' } });
    expect(await backfillProfilePicturePosts()).toEqual({ created: 0, skipped: 1 });
    expect(await Update.countDocuments()).toBe(1);
    expect((await Update.findById(post._id))?.caption).toBe('keep me');
    expect((await Buyer.findById(buyer._id))?.avatarUrl).toBe(buyer.avatarUrl);
  });

  it('handles concurrent reruns and uses creation time for an undated photo', async () => {
    const buyer = await seed('https://cdn.example.com/old-photo.jpg');
    const start = Date.now();
    await Promise.all(Array.from({ length: 4 }, () => publishProfilePicture(buyer._id, buyer.avatarUrl!)));
    const post = (await Update.findOne())!;
    expect(await Update.countDocuments()).toBe(1);
    expect(post.createdAt.getTime()).toBeGreaterThanOrEqual(start);
    const page = await getFeed({ tab: 'for-you', limit: 8 });
    expect(page.items.find(i => i.id === String(post._id))).toMatchObject({ type: 'update', kind: 'image' });
    const home = await postCandidates({ limit: 10 });
    expect(home.candidates.map(c => c.sourceId)).toContain(String(post._id));
    const profile = res();
    await UpdateController.listByAuthor({ params: { authorType: 'buyer', authorId: String(buyer._id) }, query: {} } as any, profile);
    expect(profile.status).toHaveBeenCalledWith(200);
    expect(profile.json.mock.calls[0][0].data.items[0].id).toBe(String(post._id));
  });

  it('publishes each upload and keeps previous post images when changing or removing the avatar', async () => {
    const buyer = await seed();
    jest.spyOn(R2Service, 'uploadBufferToR2').mockResolvedValue(undefined as any);
    jest.spyOn(R2Service, 'getPublicUrl').mockImplementation(key => `https://cdn.example.com/${key}`);
    const del = jest.spyOn(R2Service, 'deleteEventMediaByUrl').mockResolvedValue(undefined as any);
    const req: any = { ticketsUser: { buyerId: String(buyer._id) },
      file: { originalname: 'photo.jpg', buffer: Buffer.from('photo'), mimetype: 'image/jpeg' } };
    for (const key of ['buyers/test/avatar/1700000000000-avatar.jpg', 'buyers/test/avatar/1700000000001-avatar.jpg']) {
      jest.spyOn(R2Service, 'generateMediaKey').mockReturnValue(key);
      const response = res();
      await BuyerProfileController.uploadAvatar(req, response);
      expect(response.status).toHaveBeenCalledWith(200);
    }
    expect(await Update.countDocuments({ authorId: buyer._id })).toBe(2);
    await BuyerProfileController.deleteAvatar(req, res());
    expect((await Buyer.findById(buyer._id))?.avatarUrl).toBeUndefined();
    expect(await Update.countDocuments()).toBe(2);
    expect(del).not.toHaveBeenCalled();
  });

  it('reports publication failure and rolls back the avatar change', async () => {
    const buyer = await seed(avatar());
    jest.spyOn(R2Service, 'uploadBufferToR2').mockResolvedValue(undefined as any);
    jest.spyOn(R2Service, 'getPublicUrl').mockReturnValue('not-a-url');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = res();
    await BuyerProfileController.uploadAvatar({ ticketsUser: { buyerId: String(buyer._id) },
      file: { originalname: 'photo.jpg', buffer: Buffer.from('photo'), mimetype: 'image/jpeg' } } as any, response);
    expect(response.json.mock.calls[0][0].success).toBe(false);
    expect((await Buyer.findById(buyer._id))?.avatarUrl).toBe(buyer.avatarUrl);
    expect(await Update.countDocuments()).toBe(0);
  });
});
