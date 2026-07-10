import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ChannelAdminService } from '@services/channelAdmin.service';
import { CommunityService } from '@services/community.service';
import { CommunityMembershipService } from '@services/communityMembership.service';
import { MessageService } from '@services/message.service';
import { Channel } from '@models/channel.model';
import { Buyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { resetBuckets } from '@utils/rateLimit.util';

describe('ChannelAdminService', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Channel.init(); // unique {communityId, slug} index must exist before the duplicate-slug 409 tests race it
  });
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const eventId = () => new mongoose.Types.ObjectId().toString();
  const vendorId = () => new mongoose.Types.ObjectId().toString();

  async function seedCommunity() {
    const eid = eventId();
    const vid = vendorId();
    const { community } = await CommunityService.ensureForEvent(eid, vid);
    return { eid, vid, community };
  }

  // ChannelAdminService.update now takes the already-fetched channel doc
  // (the controller owns the 404/ownership lookups to avoid a double fetch).
  async function updateChannel(channelId: string, input: Parameters<typeof ChannelAdminService.update>[1]) {
    const channel = await Channel.findById(channelId);
    if (!channel) throw new Error(`test setup: channel ${channelId} not found`);
    return ChannelAdminService.update(channel, input);
  }

  describe('list', () => {
    it('returns { communityId, channels } including archived channels', async () => {
      const { eid, community } = await seedCommunity();
      const general = await Channel.findOne({ communityId: community._id, slug: 'general' });
      general!.archived = true;
      await general!.save();

      const result = await ChannelAdminService.list(eid);
      expect(result.communityId).toBe(String(community._id));
      expect(result.channels).toHaveLength(3);
      const bySlug = Object.fromEntries(result.channels.map((c) => [c.slug, c]));
      expect(bySlug['general']!.archived).toBe(true);
      expect(bySlug['announcements']!.isDefault).toBe(true);
      expect(bySlug['announcements']!).toHaveProperty('createdAt');
    });

    it('404s for an event with no community', async () => {
      await expect(ChannelAdminService.list(eventId())).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('create', () => {
    it('creates a non-default channel with a slugified name', async () => {
      const { eid } = await seedCommunity();
      const view = await ChannelAdminService.create(eid, { name: 'VIP Lounge' });

      expect(view.name).toBe('VIP Lounge');
      expect(view.slug).toBe('vip-lounge');
      expect(view.gated).toBe(false);
      expect(view.postPolicy).toBe('all');
      expect(view.archived).toBe(false);
      expect(view.isDefault).toBe(false);
    });

    it('honors gated + postPolicy overrides', async () => {
      const { eid } = await seedCommunity();
      const view = await ChannelAdminService.create(eid, {
        name: 'Backstage',
        gated: true,
        postPolicy: 'organizer',
      });
      expect(view.gated).toBe(true);
      expect(view.postPolicy).toBe('organizer');
    });

    it('409s on a duplicate slug within the community', async () => {
      const { eid } = await seedCommunity(); // already has a 'general' channel
      await expect(ChannelAdminService.create(eid, { name: 'General' })).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it('404s for an event with no community', async () => {
      await expect(
        ChannelAdminService.create(eventId(), { name: 'Orphan' })
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('update', () => {
    it('renames a non-default channel and re-slugs it', async () => {
      const { eid } = await seedCommunity();
      const created = await ChannelAdminService.create(eid, { name: 'VIP Lounge' });

      const updated = await updateChannel(created.id, { name: 'VVIP Lounge' });
      expect(updated.name).toBe('VVIP Lounge');
      expect(updated.slug).toBe('vvip-lounge');
    });

    it('toggles gated + postPolicy on a non-default channel', async () => {
      const { eid } = await seedCommunity();
      const created = await ChannelAdminService.create(eid, { name: 'VIP Lounge' });

      const updated = await updateChannel(created.id, { gated: true, postPolicy: 'organizer' });
      expect(updated.gated).toBe(true);
      expect(updated.postPolicy).toBe('organizer');
    });

    it('archives a non-default channel', async () => {
      const { eid } = await seedCommunity();
      const created = await ChannelAdminService.create(eid, { name: 'VIP Lounge' });

      const updated = await updateChannel(created.id, { archived: true });
      expect(updated.archived).toBe(true);
    });

    it('409s when a rename collides with an existing slug', async () => {
      const { eid } = await seedCommunity(); // has 'general' already
      const created = await ChannelAdminService.create(eid, { name: 'VIP Lounge' });

      await expect(
        updateChannel(created.id, { name: 'General' })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects renaming a default channel with 400', async () => {
      const { community } = await seedCommunity();
      const general = await Channel.findOne({ communityId: community._id, slug: 'general' });

      await expect(
        updateChannel(String(general!._id), { name: 'Renamed General' })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Default channels cannot be renamed or archived',
      });
    });

    it('rejects archiving a default channel with 400', async () => {
      const { community } = await seedCommunity();
      const general = await Channel.findOne({ communityId: community._id, slug: 'general' });

      await expect(
        updateChannel(String(general!._id), { archived: true })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Default channels cannot be renamed or archived',
      });
    });

    it('allows gated/postPolicy toggles on a default channel', async () => {
      const { community } = await seedCommunity();
      const general = await Channel.findOne({ communityId: community._id, slug: 'general' });

      const updated = await updateChannel(String(general!._id), {
        gated: true,
        postPolicy: 'organizer',
      });
      expect(updated.gated).toBe(true);
      expect(updated.postPolicy).toBe('organizer');
      expect(updated.isDefault).toBe(true);
    });

    it('allows a no-op patch (unchanged name + archived) on a default channel', async () => {
      const { community } = await seedCommunity();
      const general = await Channel.findOne({ communityId: community._id, slug: 'general' });

      const updated = await updateChannel(String(general!._id), {
        name: general!.name,
        archived: general!.archived,
      });
      expect(updated.name).toBe(general!.name);
      expect(updated.slug).toBe(general!.slug);
      expect(updated.archived).toBe(general!.archived);
      expect(updated.isDefault).toBe(true);
    });

    it('still rejects a real rename on a default channel even when archived is resubmitted unchanged', async () => {
      const { community } = await seedCommunity();
      const general = await Channel.findOne({ communityId: community._id, slug: 'general' });

      await expect(
        updateChannel(String(general!._id), { name: 'Renamed General', archived: general!.archived })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Default channels cannot be renamed or archived',
      });
    });

    it('still rejects a real archive flip on a default channel even when name is resubmitted unchanged', async () => {
      const { community } = await seedCommunity();
      const general = await Channel.findOne({ communityId: community._id, slug: 'general' });

      await expect(
        updateChannel(String(general!._id), { name: general!.name, archived: true })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Default channels cannot be renamed or archived',
      });
    });
  });

  describe('integration: archived channels stop appearing for buyers and stop accepting messages', () => {
    async function seedBuyerInCommunity(eid: string, communityId: mongoose.Types.ObjectId) {
      const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', username: 'archive_tester' });
      await Membership.create({ buyerId: buyer._id, communityId });
      return buyer;
    }

    it('excludes an archived channel from the buyer community view', async () => {
      const { eid, community } = await seedCommunity();
      const created = await ChannelAdminService.create(eid, { name: 'Pop-up Room' });
      const buyer = await seedBuyerInCommunity(eid, community._id as mongoose.Types.ObjectId);

      const beforeArchive = await CommunityMembershipService.getView(eid, buyer);
      expect(beforeArchive.channels.map((c) => c.slug)).toContain('pop-up-room');

      await updateChannel(created.id, { archived: true });

      const afterArchive = await CommunityMembershipService.getView(eid, buyer);
      expect(afterArchive.channels.map((c) => c.slug)).not.toContain('pop-up-room');
    });

    it('rejects sending a message into an archived channel with 403', async () => {
      const { eid, community } = await seedCommunity();
      const created = await ChannelAdminService.create(eid, { name: 'Pop-up Room' });
      const buyer = await seedBuyerInCommunity(eid, community._id as mongoose.Types.ObjectId);

      // sanity: sending works before archiving
      await MessageService.sendMessage(created.id, buyer, { body: 'hello before archive' });

      await updateChannel(created.id, { archived: true });

      await expect(
        MessageService.sendMessage(created.id, buyer, { body: 'hello after archive' })
      ).rejects.toMatchObject({ statusCode: 403, message: 'This channel is archived' });
    });
  });
});
