import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import { MeetupService } from '@services/meetup.service';

/**
 * The ONE rule for opening a new buyer↔buyer conversation:
 *   canDm = !blockedEitherWay && (mutual-follow friend OR accepted meetup either direction)
 * Every surface (assertCanDm, profile view, nearby, search) consumes this — do
 * not re-derive the friend/meetup logic anywhere else.
 */
export class DmEligibilityService {
  /** Friend OR accepted meetup — the "connected" half of the rule (no block check). */
  static async isConnected(aId: string, bId: string): Promise<boolean> {
    const [friend, accepted] = await Promise.all([
      FollowService.isFriend(aId, bId),
      MeetupService.areMeetupAccepted(aId, bId),
    ]);
    return Boolean(friend) || accepted;
  }

  /** Full gate for a single pair. */
  static async canDm(senderId: string, targetId: string): Promise<boolean> {
    if (await BlockService.isBlockedEitherWay(senderId, targetId)) return false;
    return DmEligibilityService.isConnected(senderId, targetId);
  }

  /** Batched: which of `otherIds` the viewer may DM. One pass for list surfaces. */
  static async canDmMap(viewerId: string, otherIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (otherIds.length === 0) return out;
    const [friendIds, acceptedIds, iBlocked, blockedMe] = await Promise.all([
      FollowService.friendIds(viewerId),
      MeetupService.acceptedPartnerIds(viewerId, otherIds),
      BlockService.listBlockedIds(viewerId),
      BlockService.listBlockerIds(viewerId),
    ]);
    const friends = new Set(friendIds);
    const blocked = new Set([...iBlocked, ...blockedMe]);
    for (const id of otherIds) {
      if (blocked.has(id)) continue;
      if (friends.has(id) || acceptedIds.has(id)) out.add(id);
    }
    return out;
  }
}
