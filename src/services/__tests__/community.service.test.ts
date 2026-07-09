import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { CommunityService } from '@services/community.service';
import { Community } from '@models/community.model';
import { Channel } from '@models/channel.model';

describe('CommunityService.ensureForEvent', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const eventId = () => new mongoose.Types.ObjectId().toString();
  const vendorId = () => new mongoose.Types.ObjectId().toString();

  it('creates the community and the 3 default channels', async () => {
    const eid = eventId();
    const { community, created } = await CommunityService.ensureForEvent(eid, vendorId());

    expect(created).toBe(true);
    expect(String(community.eventId)).toBe(eid);

    const channels = await Channel.find({ communityId: community._id }).sort({ slug: 1 });
    expect(channels.map((c) => c.slug)).toEqual(['announcements', 'attendees', 'general']);

    const bySlug = Object.fromEntries(channels.map((c) => [c.slug, c]));
    expect(bySlug['announcements']!.postPolicy).toBe('organizer');
    expect(bySlug['announcements']!.gated).toBe(false);
    expect(bySlug['general']!.postPolicy).toBe('all');
    expect(bySlug['attendees']!.gated).toBe(true);
    expect(channels.every((c) => c.isDefault)).toBe(true);
  });

  it('is idempotent — second call returns the existing community, no duplicate channels', async () => {
    const eid = eventId();
    const vid = vendorId();
    const first = await CommunityService.ensureForEvent(eid, vid);
    const second = await CommunityService.ensureForEvent(eid, vid);

    expect(second.created).toBe(false);
    expect(String(second.community._id)).toBe(String(first.community._id));
    expect(String(second.community.vendorId)).toBe(vid);
    expect(await Community.countDocuments({ eventId: eid })).toBe(1);
    expect(await Channel.countDocuments({ communityId: first.community._id })).toBe(3);
  });

  it('resolves the duplicate-key race to the winner community', async () => {
    const eid = eventId();
    const vid = vendorId();
    const winner = await CommunityService.ensureForEvent(eid, vid);

    // Simulate losing the check-then-create race: the initial existence
    // check sees nothing, so create() hits the unique index (11000).
    const spy = jest.spyOn(Community, 'findOne').mockResolvedValueOnce(null as any);
    try {
      const loser = await CommunityService.ensureForEvent(eid, vid);
      expect(loser.created).toBe(false);
      expect(String(loser.community._id)).toBe(String(winner.community._id));
      expect(String(loser.community.vendorId)).toBe(vid);
    } finally {
      spy.mockRestore();
    }
    expect(await Community.countDocuments({ eventId: eid })).toBe(1);
    expect(await Channel.countDocuments({ communityId: winner.community._id })).toBe(3);
  });

  it('heals missing default channels on a later call', async () => {
    const eid = eventId();
    const { community } = await CommunityService.ensureForEvent(eid, vendorId());
    await Channel.deleteMany({ communityId: community._id }); // simulate crash after create

    const again = await CommunityService.ensureForEvent(eid, vendorId());
    expect(again.created).toBe(false);
    const slugs = (await Channel.find({ communityId: community._id })).map((c) => c.slug).sort();
    expect(slugs).toEqual(['announcements', 'attendees', 'general']);
  });
});
