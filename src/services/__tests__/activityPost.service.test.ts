import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Update } from '@models/update.model';
import { FollowService } from '@services/follow.service';
import { publishFollowActivity } from '@services/activityPost.service';
import { toggleReaction, recordShare, getViewerReactions } from '@services/update.service';
import { createComment } from '@services/updateComment.service';
import { getFeed } from '@services/feed.service';
import { getActivityFeed } from '@services/activityFeed';
import { BlockService } from '@services/block.service';
import { UpdateController } from '@controllers/update.controller';
import type { Request, Response } from 'express';

jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn(), reconcileStuckUpdates: jest.fn() }));
let sequence = 0;
async function buyer(name: string, photo = true) {
  return Buyer.create({ phone: `+26878${String(++sequence).padStart(6, '0')}`, password: 'test-only-password',
    username: name.toLowerCase(), name, ...(photo ? { avatarUrl: `https://cdn.example/${name}.jpg` } : {}) });
}
async function regularPost(authorId: string) {
  return Update.create({ authorType: 'buyer', authorId, kind: 'image', caption: 'Ordinary post',
    media: [{ rawKey: 'normal.jpg', status: 'ready', image: { url: 'https://cdn.example/normal.jpg', width: 10, height: 10 } }] });
}

describe('Home activity posts use the existing post rails', () => {
  beforeAll(connectTestDb);
  afterEach(async () => { jest.restoreAllMocks(); await clearTestDb(); });
  afterAll(disconnectTestDb);

  it('creates one photo post per follow, repairs retries and preserves the Activity page', async () => {
    const a = await buyer('Alice'); const b = await buyer('Bob');
    await FollowService.follow(a, 'buyer', b.id);
    await FollowService.follow(a, 'buyer', b.id);
    await Promise.all([publishFollowActivity({ type: 'buyer', id: a.id }, 'buyer', b.id), publishFollowActivity({ type: 'buyer', id: a.id }, 'buyer', b.id)]);
    const posts = await Update.find({ 'activitySource.type': 'follow' });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.caption).toBe('alice now follows Bob.');
    expect(posts[0]?.media[0]?.image?.url).toBe(b.avatarUrl);
    const activity = await getActivityFeed({ tab: 'everyone', limit: 50 });
    expect(activity.items.some(i => i.type === 'follow' && i.actor.id === a.id && i.target?.id === b.id)).toBe(true);
    expect(activity.items.some(i => i.type === 'post' && i.target?.id === posts[0]?.id)).toBe(false);
  });

  it('renders persisted activities in Home without promoting them into Discover or profile posts', async () => {
    const a = await buyer('Alice'); const b = await buyer('Bob');
    const normal = await regularPost(a.id);
    await FollowService.follow(a, 'buyer', b.id);
    const activity = await Update.findOne({ 'activitySource.type': 'follow' });
    const home = await getFeed({ tab: 'for-you', surface: 'home', limit: 30 });
    expect(home.items.some(i => i.id === activity?.id)).toBe(true);
    expect(home.items.some(i => i.id === normal.id)).toBe(true);
    const discover = await getFeed({ tab: 'for-you', limit: 30 });
    expect(discover.items.some(i => i.id === activity?.id)).toBe(false);
    expect(discover.items.some(i => i.id === normal.id)).toBe(true);
    const res = { req: { originalUrl: '/api/public/updates/author/buyer/' + a.id }, status: jest.fn().mockReturnThis(), json: jest.fn() };
    await UpdateController.listByAuthor({ params: { authorType: 'buyer', authorId: a.id }, query: {} } as unknown as Request, res as unknown as Response);
    const body = res.json.mock.calls[0]?.[0];
    expect(body.success).toBe(true);
    expect(body.data.items.map((p: { id: string }) => p.id)).toEqual([normal.id]);
  });

  it('supports real Like, Save, Comment and Share actions without recursive activity spam', async () => {
    const a = await buyer('Alice'); const b = await buyer('Bob'); const c = await buyer('Carol');
    await FollowService.follow(a, 'buyer', b.id);
    const activity = await Update.findOne({ 'activitySource.type': 'follow' });
    expect(activity).not.toBeNull();
    const actor = { type: 'buyer' as const, id: c.id };
    expect(await toggleReaction(activity!.id, actor, 'like')).toMatchObject({ active: true, likeCount: 1 });
    await toggleReaction(activity!.id, actor, 'save');
    expect((await getViewerReactions([activity!.id], actor))[activity!.id]).toEqual({ liked: true, saved: true });
    await createComment(activity!.id, actor, 'Nice!');
    expect((await Update.findById(activity!.id))?.commentCount).toBe(1);
    expect(await recordShare(activity!.id)).toMatchObject({ shareCount: 1 });
    expect(await Update.countDocuments({ 'activitySource.id': { $exists: true } })).toBe(1);
  });

  it('publishes post likes with the author photo and removes activity after unlike/unfollow', async () => {
    const a = await buyer('Alice'); const b = await buyer('Bob');
    const post = await regularPost(b.id);
    await toggleReaction(post.id, { type: 'buyer', id: a.id }, 'like');
    const liked = await Update.findOne({ 'activitySource.type': 'like_post' });
    expect(liked?.caption).toBe('alice liked Bob’s post.');
    expect(liked?.media[0]?.image?.url).toBe(b.avatarUrl);
    await toggleReaction(post.id, { type: 'buyer', id: a.id }, 'like');
    expect((await Update.findById(liked!.id))?.status).toBe('removed');
    await FollowService.follow(a, 'buyer', b.id);
    await FollowService.unfollow(a, 'buyer', b.id);
    expect(await Update.countDocuments({ 'activitySource.type': 'follow', status: 'active' })).toBe(0);
    await FollowService.follow(a, 'buyer', b.id);
    expect(await Update.countDocuments({ 'activitySource.type': 'follow', status: 'active' })).toBe(1);
  });

  it('supports organizer actors and leaves ordinary saves unchanged', async () => {
    const a = await buyer('Alice');
    const brand = await Vendor.create({ businessName: 'Events', slug: 'events', password: 'test-only-password', logoUrl: 'https://cdn.example/brand.jpg' });
    await FollowService.followAsVendor(brand.id, 'buyer', a.id);
    expect(await Update.findOne({ authorType: 'vendor', 'activitySource.type': 'follow' })).toMatchObject({ caption: 'events now follows Alice.' });
    const post = await regularPost(a.id);
    await toggleReaction(post.id, { type: 'vendor', id: brand.id }, 'save');
    expect(await Update.countDocuments({ 'activitySource.type': 'like_post' })).toBe(0);
    await FollowService.unfollowAsVendor(brand.id, 'buyer', a.id);
    expect(await Update.countDocuments({ 'activitySource.type': 'follow', status: 'active' })).toBe(0);
  });

  it('does not invent photos and respects blocked actors/subjects in Home', async () => {
    const a = await buyer('Alice'); const b = await buyer('Bob', false); const c = await buyer('Carol');
    await FollowService.follow(a, 'buyer', b.id);
    expect(await Update.countDocuments({ 'activitySource.type': 'follow' })).toBe(0);
    await FollowService.follow(a, 'buyer', c.id);
    const activity = await Update.findOne({ 'activitySource.type': 'follow' });
    const viewer = await buyer('Viewer');
    await BlockService.blockActor(viewer.id, c.id);
    const home = await getFeed({ tab: 'for-you', surface: 'home', actor: { type: 'buyer', id: viewer.id }, limit: 30 });
    expect(home.items.some(i => i.id === activity?.id)).toBe(false);
  });

  it('surfaces persistence failures and allows an idempotent follow retry to repair the missing post', async () => {
    const a = await buyer('Alice'); const b = await buyer('Bob');
    const write = jest.spyOn(Update, 'updateOne').mockRejectedValueOnce(new Error('activity storage unavailable'));
    await expect(FollowService.follow(a, 'buyer', b.id)).rejects.toThrow('activity storage unavailable');
    write.mockRestore();
    await FollowService.follow(a, 'buyer', b.id);
    expect(await Update.countDocuments({ 'activitySource.type': 'follow' })).toBe(1);
  });
});
