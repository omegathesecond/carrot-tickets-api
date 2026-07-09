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
   */
  static async ensureForEvent(
    eventId: string,
    vendorId: string
  ): Promise<{ community: ICommunity; created: boolean }> {
    const existing = await Community.findOne({ eventId });
    if (existing) return { community: existing, created: false };

    try {
      const community = await Community.create({ eventId, vendorId });
      await Channel.insertMany(
        DEFAULT_CHANNELS.map((c) => ({ ...c, communityId: community._id, isDefault: true }))
      );
      return { community, created: true };
    } catch (err: any) {
      // Duplicate-key race: another request created it between our check and
      // insert. The winner also created the channels — return theirs.
      if (err?.code === 11000) {
        const community = await Community.findOne({ eventId });
        if (community) return { community, created: false };
      }
      throw err;
    }
  }
}
