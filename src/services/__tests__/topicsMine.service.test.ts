import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventQuestion } from '@models/eventQuestion.model';
import { EventQuestionReply } from '@models/eventQuestionReply.model';
import { EventQuestionRead } from '@models/eventQuestionRead.model';
import { listMine, markRead } from '@services/topicsMine.service';
import type { SocialActor } from '@utils/socialActor.util';

async function seedBuyer(phone: string): Promise<IBuyer> {
  return Buyer.create({ phone, password: 'secret1', name: `B${phone.slice(-4)}` });
}

function actorOf(buyer: IBuyer): SocialActor {
  return { type: 'buyer', id: String(buyer._id) };
}

async function seedQuestion(eventId: string, author: IBuyer, body: string) {
  return EventQuestion.create({ eventId, authorType: 'buyer', authorId: author._id, body });
}

async function seedReply(questionId: any, eventId: string, author: IBuyer, body: string) {
  return EventQuestionReply.create({ questionId, eventId, authorType: 'buyer', authorId: author._id, body });
}

describe('topicsMine.service', () => {
  beforeAll(async () => {
    await connectTestDb();
    await EventQuestionRead.init(); // unique (actor, question) index for markRead upsert
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns topics I authored AND topics I only replied to, with the event image', async () => {
    const me = await seedBuyer('+26878000001');
    const other = await seedBuyer('+26878000002');
    const { eventId } = await seedPublishedEvent();
    await Event.updateOne({ _id: eventId }, { $set: { thumbnailUrl: 'https://cdn/thumb.jpg' } });

    const authored = await seedQuestion(eventId, me, 'My question');
    const otherQ = await seedQuestion(eventId, other, 'Their question');
    await seedReply(otherQ._id, eventId, me, 'my reply on theirs');
    // A topic I have nothing to do with must NOT appear.
    await seedQuestion(eventId, other, 'Unrelated question');

    const mine = await listMine(actorOf(me));
    const ids = mine.map((t) => t.id).sort();
    expect(ids).toEqual([String(authored._id), String(otherQ._id)].sort());
    expect(mine.every((t) => t.event.image === 'https://cdn/thumb.jpg')).toBe(true);
  });

  it('counts unread as other people\'s replies after my read cursor; never my own', async () => {
    const me = await seedBuyer('+26878000010');
    const other = await seedBuyer('+26878000011');
    const { eventId } = await seedPublishedEvent();
    const q = await seedQuestion(eventId, me, 'Where do we park?');

    // Explicit, distinct createdAt so the cursor boundary is unambiguous
    // (sequential creates can share a millisecond in-memory).
    const base = Date.now();
    const r1 = await seedReply(q._id, eventId, other, 'r1');
    const r2 = await seedReply(q._id, eventId, other, 'r2');
    const rMine = await seedReply(q._id, eventId, me, 'my own reply'); // mine — never unread
    const r3 = await seedReply(q._id, eventId, other, 'r3');
    // createdAt is immutable under mongoose timestamps — patch via the raw
    // driver collection so the boundary is exact.
    await EventQuestionReply.collection.updateOne({ _id: r1._id }, { $set: { createdAt: new Date(base + 1000) } });
    await EventQuestionReply.collection.updateOne({ _id: r2._id }, { $set: { createdAt: new Date(base + 2000) } });
    await EventQuestionReply.collection.updateOne({ _id: rMine._id }, { $set: { createdAt: new Date(base + 3000) } });
    await EventQuestionReply.collection.updateOne({ _id: r3._id }, { $set: { createdAt: new Date(base + 4000) } });

    // Never opened → every OTHER author's reply is unread (r1, r2, r3 = 3).
    let mine = await listMine(actorOf(me));
    expect(mine[0]!.unreadCount).toBe(3);

    // Cursor between r1 and r2 → only later replies by others (r2, r3 = 2);
    // r1 is at/before the cursor and rMine is my own.
    await EventQuestionRead.create({
      questionId: q._id,
      actorType: 'buyer',
      actorId: me._id,
      lastViewedAt: new Date(base + 1500),
    });
    mine = await listMine(actorOf(me));
    expect(mine[0]!.unreadCount).toBe(2);
  });

  it('markRead zeroes the unread badge (and is idempotent)', async () => {
    const me = await seedBuyer('+26878000020');
    const other = await seedBuyer('+26878000021');
    const { eventId } = await seedPublishedEvent();
    const q = await seedQuestion(eventId, me, 'Topic');
    await seedReply(q._id, eventId, other, 'unseen');

    expect((await listMine(actorOf(me)))[0]!.unreadCount).toBe(1);

    await markRead(String(q._id), actorOf(me));
    expect((await listMine(actorOf(me)))[0]!.unreadCount).toBe(0);

    // Second call must not throw on the unique cursor index.
    await expect(markRead(String(q._id), actorOf(me))).resolves.toEqual({ ok: true });
  });

  it('markRead 404s on a non-existent topic', async () => {
    const me = await seedBuyer('+26878000030');
    await expect(markRead(String(new mongoose.Types.ObjectId()), actorOf(me))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns [] for an actor with no topics', async () => {
    const nobody = await seedBuyer('+26878000040');
    expect(await listMine(actorOf(nobody))).toEqual([]);
  });
});
