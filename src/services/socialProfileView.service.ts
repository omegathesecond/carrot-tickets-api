import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import type { SocialActor } from '@utils/socialActor.util';

/** The one public shape for "a buyer's profile page", shared by every viewer type. */
export interface PublicBuyerProfile {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  joinedAt: Date;
  followerCount: number;
  followingCount: number;
  eventsAttended: number;
  isFollowing: boolean;
  isFollowedBy: boolean;
  isFriend: boolean;
  isBlocked: boolean;
}

export class SocialProfileViewService {
  /**
   * Build GET .../users/:username's payload for a given viewer actor
   * (buyer OR vendor brand). Shared by SocialProfileController.publicProfile
   * (buyer viewer, mounted at /api/social) and
   * VendorSocialController.publicProfile (vendor viewer, mounted at
   * /api/tickets/social) so the two routes can never drift on shape or on
   * how the viewer-relative flags are derived. Returns null when no buyer
   * has that username — callers translate that into a 404.
   */
  static async forViewer(username: string, viewer: SocialActor): Promise<PublicBuyerProfile | null> {
    const buyer = await Buyer.findOne({ username });
    if (!buyer) return null;

    const targetId = String(buyer._id);
    // A follow-of-the-viewer edge targets 'organizer' when the viewer is a
    // vendor brand, 'buyer' when the viewer is a buyer — mirrors targetType
    // on the Follow model (@models/follow.model.ts).
    const viewerTargetType = viewer.type === 'vendor' ? 'organizer' : 'buyer';

    const [followerCount, followingCount, attendedEventIds, isFollowing, isFollowedBy, isBlocked] = await Promise.all([
      FollowService.followerCount('buyer', targetId),
      FollowService.followingCount(targetId),
      Ticket.distinct('eventId', { customerPhone: buyer.phone, status: TicketStatus.CHECKED_IN }),
      Follow.exists({ followerType: viewer.type, followerId: viewer.id, targetType: 'buyer', targetId }).then(Boolean),
      Follow.exists({ followerType: 'buyer', followerId: targetId, targetType: viewerTargetType, targetId: viewer.id }).then(Boolean),
      BlockService.isBlockedEitherWay(viewer.id, targetId),
    ]);

    return {
      id: targetId,
      username: buyer.username ?? null,
      name: buyer.name ?? null,
      avatarUrl: buyer.avatarUrl ?? null,
      bio: buyer.bio ?? null,
      joinedAt: buyer.createdAt,
      followerCount,
      followingCount,
      eventsAttended: attendedEventIds.length,
      isFollowing,
      isFollowedBy,
      // Matches FollowService.isFriend's buyer<->buyer definition exactly
      // (mutual follow, both directions) generalized to any viewer actor.
      isFriend: isFollowing && isFollowedBy,
      isBlocked,
    };
  }
}
