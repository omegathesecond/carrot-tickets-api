import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Update } from '@models/update.model';
import { UpdateComment } from '@models/updateComment.model';
import { listComments, createComment, removeComment } from '@services/updateComment.service';
import { HttpError } from '@utils/httpError.util';
import type { SocialActor } from '@utils/socialActor.util';

async function seedBuyer(overrides: Partial<{ phone: string; name: string; username: string }> = {}) {
  return Buyer.create({
    phone: overrides.phone ?? '+26878422613',
    password: 'secret1',
    name: overrides.name ?? 'Test Buyer',
    username: overrides.username,
  });
}

async function seedVendor(businessName = 'Test Organizer') {
  return Vendor.create({ businessName, password: 'secret123' });
}

/** A ready, visible post authored by `author` — the only kind that accepts comments. */
async function seedPost(author: SocialActor) {
  return Update.create({
    authorType: author.type,
    authorId: author.id,
    kind: 'image',
    caption: 'hello',
    media: { rawKey: 'raw/x.jpg', status: 'ready', image: { url: 'https://cdn/x.jpg', width: 1, height: 1 } },
  });
}

describe('updateComment.service', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('createComment', () => {
    it('rejects an empty or whitespace-only body with 400', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      await expect(createComment(post.id, actor, '   ')).rejects.toThrow(HttpError);
      await expect(createComment(post.id, actor, '')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects a body over 1000 chars with 400 (not 500)', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      await expect(createComment(post.id, actor, 'a'.repeat(1001))).rejects.toMatchObject({ statusCode: 400 });
    });

    it('404s on a non-existent post', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const missing = new mongoose.Types.ObjectId().toString();
      await expect(createComment(missing, actor, 'nice')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('404s on a soft-deleted post — a removed post accepts no new comments', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      await Update.updateOne({ _id: post._id }, { status: 'removed' });
      await expect(createComment(post.id, actor, 'nice')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('403s for a suspended buyer actor', async () => {
      const author = await seedBuyer();
      const post = await seedPost({ type: 'buyer', id: String(author._id) });
      const suspended = await Buyer.create({
        phone: '+26878400020', password: 'secret1', name: 'Suspended', socialSuspendedAt: new Date(),
      });
      await expect(
        createComment(post.id, { type: 'buyer', id: String(suspended._id) }, 'hi'),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('stores the comment and increments the post commentCount', async () => {
      const buyer = await seedBuyer({ name: 'Thabo', username: 'thabo' });
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);

      const dto = await createComment(post.id, actor, '  great show  ');

      expect(dto.body).toBe('great show'); // trimmed
      expect(dto.author).toMatchObject({ type: 'buyer', id: String(buyer._id), name: 'Thabo', username: 'thabo' });
      expect(dto.viewerCanDelete).toBe(true);
      const after = await Update.findById(post._id).lean();
      expect(after!.commentCount).toBe(1);
    });

    it('lets an organizer brand comment, hydrating the vendor as an "organizer" author', async () => {
      const buyer = await seedBuyer();
      const post = await seedPost({ type: 'buyer', id: String(buyer._id) });
      const vendor = await seedVendor('Sting Events');

      const dto = await createComment(post.id, { type: 'vendor', id: String(vendor._id) }, 'See you there');

      expect(dto.author).toMatchObject({ type: 'organizer', id: String(vendor._id), name: 'Sting Events' });
    });
  });

  describe('listComments', () => {
    it('returns active comments newest-first with the post commentCount', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      await createComment(post.id, actor, 'first');
      await createComment(post.id, actor, 'second');

      const out = await listComments(post.id, actor);

      expect(out.items.map((c) => c.body)).toEqual(['second', 'first']);
      expect(out.commentCount).toBe(2);
      expect(out.nextCursor).toBeNull();
    });

    it('omits soft-deleted comments', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      const doomed = await createComment(post.id, actor, 'oops');
      await createComment(post.id, actor, 'keep');
      await removeComment(doomed.id, actor);

      const out = await listComments(post.id, actor);
      expect(out.items.map((c) => c.body)).toEqual(['keep']);
    });

    it('reads publicly for an anonymous viewer, offering no delete', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      await createComment(post.id, actor, 'hello');

      const out = await listComments(post.id, null);
      expect(out.items).toHaveLength(1);
      expect(out.items[0]!.viewerCanDelete).toBe(false);
    });

    it('offers delete to the POST author on someone else’s comment', async () => {
      const poster = await seedBuyer({ phone: '+26878400001' });
      const commenter = await seedBuyer({ phone: '+26878400002', name: 'Other' });
      const postActor: SocialActor = { type: 'buyer', id: String(poster._id) };
      const post = await seedPost(postActor);
      await createComment(post.id, { type: 'buyer', id: String(commenter._id) }, 'rude');

      const asPoster = await listComments(post.id, postActor);
      expect(asPoster.items[0]!.viewerCanDelete).toBe(true);

      const asStranger = await listComments(post.id, { type: 'buyer', id: String(commenter._id) });
      expect(asStranger.items[0]!.viewerCanDelete).toBe(true); // their own comment
    });

    it('does not let a vendor whose id collides with the buyer author delete', async () => {
      // The authorType clause in isActorAuthorOf is load-bearing: matching ids
      // across different actor types must NOT grant ownership.
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      await createComment(post.id, actor, 'mine');

      const out = await listComments(post.id, { type: 'vendor', id: String(buyer._id) });
      expect(out.items[0]!.viewerCanDelete).toBe(false);
    });

    it('rejects a malformed cursor with 400', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      await expect(listComments(post.id, actor, 'not-a-date')).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('removeComment', () => {
    it('403s for an unrelated actor', async () => {
      const poster = await seedBuyer({ phone: '+26878400003' });
      const commenter = await seedBuyer({ phone: '+26878400004' });
      const stranger = await seedBuyer({ phone: '+26878400005' });
      const post = await seedPost({ type: 'buyer', id: String(poster._id) });
      const c = await createComment(post.id, { type: 'buyer', id: String(commenter._id) }, 'hi');

      await expect(
        removeComment(c.id, { type: 'buyer', id: String(stranger._id) }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('lets a superadmin remove any comment', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      const c = await createComment(post.id, actor, 'hi');

      await expect(removeComment(c.id, null, true)).resolves.toMatchObject({ ok: true, commentCount: 0 });
      expect((await UpdateComment.findById(c.id))!.status).toBe('removed');
    });

    it('decrements commentCount exactly once across a double delete', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      const c = await createComment(post.id, actor, 'hi');
      await createComment(post.id, actor, 'there');

      await removeComment(c.id, actor);
      const second = await removeComment(c.id, actor);

      expect(second.commentCount).toBe(1);
      expect((await Update.findById(post._id).lean())!.commentCount).toBe(1);
    });

    it('never drives commentCount below zero when it has drifted', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const post = await seedPost(actor);
      const c = await createComment(post.id, actor, 'hi');
      await Update.updateOne({ _id: post._id }, { commentCount: 0 }); // simulate drift

      const out = await removeComment(c.id, actor);
      expect(out.commentCount).toBe(0);
    });

    it('404s on a non-existent comment', async () => {
      const buyer = await seedBuyer();
      const missing = new mongoose.Types.ObjectId().toString();
      await expect(
        removeComment(missing, { type: 'buyer', id: String(buyer._id) }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
