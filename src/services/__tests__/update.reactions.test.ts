import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import { toggleReaction, recordShare, recordView, getViewerReactions } from '@services/update.service';
import mongoose from 'mongoose';
import type { SocialActor } from '@utils/socialActor.util';

jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn(), reconcileStuckUpdates: jest.fn() }));

async function seedUpdate() {
  return Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: '', media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } } });
}

describe('update reactions', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('toggles a like on then off, keeping the counter in sync', async () => {
    const u = await seedUpdate();
    const buyerId = new mongoose.Types.ObjectId().toString();
    const on = await toggleReaction(u.id, { type: 'buyer', id: buyerId }, 'like');
    expect(on.active).toBe(true);
    expect(on.likeCount).toBe(1);
    const off = await toggleReaction(u.id, { type: 'buyer', id: buyerId }, 'like');
    expect(off.active).toBe(false);
    expect(off.likeCount).toBe(0);
  });

  it('records a share increment', async () => {
    const u = await seedUpdate();
    const r = await recordShare(u.id);
    expect(r.shareCount).toBe(1);
  });

  it('records view increments, counting up across repeated calls', async () => {
    const u = await seedUpdate();
    const first = await recordView(u.id);
    expect(first.viewCount).toBe(1);
    const second = await recordView(u.id);
    expect(second.viewCount).toBe(2);
  });

  it('reports viewer reactions across updates', async () => {
    const u = await seedUpdate();
    const buyerId = new mongoose.Types.ObjectId().toString();
    await toggleReaction(u.id, { type: 'buyer', id: buyerId }, 'save');
    const map = await getViewerReactions([u.id], { type: 'buyer', id: buyerId });
    expect(map[u.id]).toEqual({ liked: false, saved: true });
  });

  it('a vendor like toggles independently of a buyer like on the same update', async () => {
    const u = await seedUpdate();
    const vendor: SocialActor = { type: 'vendor', id: new mongoose.Types.ObjectId().toString() };
    const buyer: SocialActor = { type: 'buyer', id: new mongoose.Types.ObjectId().toString() };

    const first = await toggleReaction(u.id, vendor, 'like');
    expect(first).toMatchObject({ active: true, likeCount: 1 });

    const second = await toggleReaction(u.id, buyer, 'like');
    expect(second.likeCount).toBe(2);

    const off = await toggleReaction(u.id, vendor, 'like');
    expect(off).toMatchObject({ active: false, likeCount: 1 });
  });

  it('getViewerReactions returns the vendor viewer own flags only', async () => {
    const u = await seedUpdate();
    const vendor: SocialActor = { type: 'vendor', id: new mongoose.Types.ObjectId().toString() };
    const otherBuyer: SocialActor = { type: 'buyer', id: new mongoose.Types.ObjectId().toString() };
    await toggleReaction(u.id, otherBuyer, 'like');   // someone else liked
    await toggleReaction(u.id, vendor, 'save');       // this vendor saved

    const rx = await getViewerReactions([u.id], vendor);
    expect(rx[u.id]).toEqual({ liked: false, saved: true });
  });
});
