import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { toggleEventLike, recordEventShare, getViewerEventReactions } from '@services/eventReaction.service';
import type { SocialActor } from '@utils/socialActor.util';

async function seedEvent() {
  return Event.create({
    name: 'Bushfire',
    venue: 'House on Fire',
    eventDate: new Date(Date.now() + 86400000),
    startTime: new Date(Date.now() + 86400000),
    endTime: new Date(Date.now() + 90000000),
    vendorId: new mongoose.Types.ObjectId(),
  });
}

const buyer = (): SocialActor => ({ type: 'buyer', id: new mongoose.Types.ObjectId().toString() });

describe('event reactions', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('toggles a like on then off, keeping the counter in sync', async () => {
    const e = await seedEvent();
    const actor = buyer();

    const on = await toggleEventLike(e.id, actor);
    expect(on.active).toBe(true);
    expect(on.likeCount).toBe(1);

    const off = await toggleEventLike(e.id, actor);
    expect(off.active).toBe(false);
    expect(off.likeCount).toBe(0);
  });

  it('counts two different actors independently', async () => {
    const e = await seedEvent();
    await toggleEventLike(e.id, buyer());
    const second = await toggleEventLike(e.id, buyer());
    expect(second.likeCount).toBe(2);
  });

  it('lets a vendor actor like an event', async () => {
    const e = await seedEvent();
    const vendor: SocialActor = { type: 'vendor', id: new mongoose.Types.ObjectId().toString() };
    const on = await toggleEventLike(e.id, vendor);
    expect(on.active).toBe(true);
    expect(on.likeCount).toBe(1);
  });

  it('records a share increment', async () => {
    const e = await seedEvent();
    expect((await recordEventShare(e.id)).shareCount).toBe(1);
    expect((await recordEventShare(e.id)).shareCount).toBe(2);
  });

  it('reports viewer reactions per event, defaulting unliked to false', async () => {
    const liked = await seedEvent();
    const notLiked = await seedEvent();
    const actor = buyer();
    await toggleEventLike(liked.id, actor);

    const map = await getViewerEventReactions([liked.id, notLiked.id], actor);
    expect(map[liked.id]).toEqual({ liked: true });
    expect(map[notLiked.id]).toEqual({ liked: false });
  });

  it('does not leak another actor\'s like into the viewer map', async () => {
    const e = await seedEvent();
    await toggleEventLike(e.id, buyer());
    const map = await getViewerEventReactions([e.id], buyer());
    expect(map[e.id]).toEqual({ liked: false });
  });
});
