import { Community, ICommunity } from '@models/community.model';
import { Channel } from '@models/channel.model';

export const DEFAULT_CHANNELS = [
  { name: 'announcements', slug: 'announcements', gated: false, postPolicy: 'organizer' as const },
  { name: 'general', slug: 'general', gated: false, postPolicy: 'all' as const },
  { name: 'attendees', slug: 'attendees', gated: true, postPolicy: 'all' as const },
];

export class CommunityService {
  /**
   * Idempotently create the community (and its default channels) for an
   * event. Called when an event is published, and by the release backfill.
   * Default channels are ensured on EVERY call (upsert on the unique
   * (communityId, slug) index) so a crash between community creation and
   * channel creation self-heals on the next call.
   */
  static async ensureForEvent(
    eventId: string,
    vendorId: string
  ): Promise<{ community: ICommunity; created: boolean }> {
    const existing = await Community.findOne({ eventId });
    if (existing) {
      await CommunityService.ensureDefaultChannels(existing);
      return { community: existing, created: false };
    }

    try {
      const community = await Community.create({ eventId, vendorId });
      await CommunityService.ensureDefaultChannels(community);
      return { community, created: true };
    } catch (err: any) {
      // Duplicate-key race: another request created it between our check and
      // insert. Adopt the winner's community (and heal its channels too).
      if (err?.code === 11000) {
        const community = await Community.findOne({ eventId });
        if (community) {
          await CommunityService.ensureDefaultChannels(community);
          return { community, created: false };
        }
      }
      throw err;
    }
  }

  /** Upsert each default channel; a concurrent upsert losing the unique-index
   *  race throws 11000, which simply means the channel already exists. */
  private static async ensureDefaultChannels(community: ICommunity): Promise<void> {
    for (const c of DEFAULT_CHANNELS) {
      try {
        await Channel.updateOne(
          { communityId: community._id, slug: c.slug },
          { $setOnInsert: { ...c, communityId: community._id, isDefault: true } },
          { upsert: true }
        );
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
      }
    }
  }
}
