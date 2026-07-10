import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ModerationService } from '@services/moderation.service';
import { CommunityService } from '@services/community.service';
import { Channel } from '@models/channel.model';
import { Buyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { Message } from '@models/message.model';

describe('ModerationService', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const eventId = () => new mongoose.Types.ObjectId().toString();
  const vendorId = () => new mongoose.Types.ObjectId().toString();

  async function seedCommunity() {
    const eid = eventId();
    const vid = vendorId();
    const { community } = await CommunityService.ensureForEvent(eid, vid);
    const general = (await Channel.findOne({ communityId: community._id, slug: 'general' }))!;
    return { eid, vid, community, general };
  }

  async function seedMember(communityId: mongoose.Types.ObjectId, phone = '+26878422613') {
    const buyer = await Buyer.create({ phone, password: 'secret1', name: 'Test Buyer' });
    const membership = await Membership.create({ buyerId: buyer._id, communityId });
    return { buyer, membership };
  }

  describe('deleteMessage', () => {
    it('soft-deletes a channel message', async () => {
      const { general, community } = await seedCommunity();
      const { buyer } = await seedMember(community._id as mongoose.Types.ObjectId);
      const message = await Message.create({
        channelId: general._id, communityId: community._id, senderId: buyer._id, body: 'hello',
      });

      await ModerationService.deleteMessage(message);

      const reloaded = await Message.findById(message._id);
      expect(reloaded!.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('mute / unmute', () => {
    it('sets mutedUntil minutes-from-now and clears it on unmute', async () => {
      const { community } = await seedCommunity();
      const { membership } = await seedMember(community._id as mongoose.Types.ObjectId);

      const before = Date.now();
      const mutedUntil = await ModerationService.mute(membership, 60);
      expect(mutedUntil.getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
      expect(mutedUntil.getTime()).toBeLessThanOrEqual(before + 60 * 60_000 + 5000);

      const reloaded = await Membership.findById(membership._id);
      expect(reloaded!.mutedUntil).toBeInstanceOf(Date);

      await ModerationService.unmute(reloaded!);
      const afterUnmute = await Membership.findById(membership._id);
      expect(afterUnmute!.mutedUntil).toBeUndefined();
    });
  });

  describe('ban / unban', () => {
    it('sets bannedAt and clears it on unban', async () => {
      const { community } = await seedCommunity();
      const { membership } = await seedMember(community._id as mongoose.Types.ObjectId);

      await ModerationService.ban(membership);
      const banned = await Membership.findById(membership._id);
      expect(banned!.bannedAt).toBeInstanceOf(Date);

      await ModerationService.unban(banned!);
      const unbanned = await Membership.findById(membership._id);
      expect(unbanned!.bannedAt).toBeUndefined();
    });
  });

  describe('listMembers', () => {
    it('includes banned members with role/ticketVerified/mutedUntil/bannedAt/joinedAt/cursor', async () => {
      const { community } = await seedCommunity();
      const { membership } = await seedMember(community._id as mongoose.Types.ObjectId);
      await ModerationService.ban(membership);

      const members = await ModerationService.listMembers(String(community._id), {});
      expect(members).toHaveLength(1);
      const row = members[0]!;
      expect(row.role).toBe('member');
      expect(row.ticketVerified).toBe(false);
      expect(row.bannedAt).toBeInstanceOf(Date);
      expect(row.mutedUntil).toBeNull();
      expect(row.joinedAt).toBeInstanceOf(Date);
      expect(row.cursor).toBe(String(membership._id));
      expect(row.username).toBeDefined();
    });

    it('cursor-paginates newest first', async () => {
      const { community } = await seedCommunity();
      await seedMember(community._id as mongoose.Types.ObjectId, '+26878000001');
      await seedMember(community._id as mongoose.Types.ObjectId, '+26878000002');
      await seedMember(community._id as mongoose.Types.ObjectId, '+26878000003');

      const page1 = await ModerationService.listMembers(String(community._id), { limit: 2 });
      expect(page1).toHaveLength(2);
      const page2 = await ModerationService.listMembers(String(community._id), {
        limit: 2,
        before: page1[1]!.cursor,
      });
      expect(page2).toHaveLength(1);
      expect(page2[0]!.cursor).not.toBe(page1[0]!.cursor);
      expect(page2[0]!.cursor).not.toBe(page1[1]!.cursor);
    });
  });

  describe('pin / unpin', () => {
    it('pins and unpins a channel message (idempotent both ways)', async () => {
      const { general, community } = await seedCommunity();
      const { buyer } = await seedMember(community._id as mongoose.Types.ObjectId);
      const message = await Message.create({
        channelId: general._id, communityId: community._id, senderId: buyer._id, body: 'pin me',
      });

      await ModerationService.pinMessage(message);
      expect((await Message.findById(message._id))!.pinnedAt).toBeInstanceOf(Date);

      // idempotent re-pin — does not throw, does not double count (verified below)
      await ModerationService.pinMessage((await Message.findById(message._id))!);

      await ModerationService.unpinMessage((await Message.findById(message._id))!);
      expect((await Message.findById(message._id))!.pinnedAt).toBeNull();

      // idempotent unpin on an already-unpinned message
      await ModerationService.unpinMessage((await Message.findById(message._id))!);
      expect((await Message.findById(message._id))!.pinnedAt).toBeNull();
    });

    it('rejects the 11th pin in a channel with 400 Pin limit reached', async () => {
      const { general, community } = await seedCommunity();
      const { buyer } = await seedMember(community._id as mongoose.Types.ObjectId);

      const messages = await Promise.all(
        Array.from({ length: 11 }, (_, i) =>
          Message.create({
            channelId: general._id, communityId: community._id, senderId: buyer._id, body: `msg ${i}`,
          })
        )
      );

      for (const m of messages.slice(0, 10)) {
        await ModerationService.pinMessage(m);
      }
      const pinnedCount = await Message.countDocuments({ channelId: general._id, pinnedAt: { $ne: null } });
      expect(pinnedCount).toBe(10);

      await expect(ModerationService.pinMessage(messages[10]!)).rejects.toMatchObject({
        statusCode: 400,
        message: 'Pin limit reached',
      });
    });

    it('re-pinning an already-pinned message never counts twice against the cap', async () => {
      const { general, community } = await seedCommunity();
      const { buyer } = await seedMember(community._id as mongoose.Types.ObjectId);
      const messages = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          Message.create({
            channelId: general._id, communityId: community._id, senderId: buyer._id, body: `msg ${i}`,
          })
        )
      );
      for (const m of messages) await ModerationService.pinMessage(m);

      // Re-pin the first one again — must not throw even though the channel
      // is already at the cap.
      await expect(
        ModerationService.pinMessage((await Message.findById(messages[0]!._id))!)
      ).resolves.toBeUndefined();
    });
  });
});
