import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { HttpError } from '@utils/httpError.util';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import type { SocialActor, SocialActorType } from '@utils/socialActor.util';

/**
 * Batch author hydration for user-authored social content (Q&A questions and
 * replies, post comments). Extracted from eventQuestion.service so a second
 * threaded-content feature doesn't fork a near-identical copy of it — the
 * (authorType, authorId) → display-author mapping must read the same
 * everywhere or the same person renders differently on two surfaces.
 *
 * Note the vocabulary shift, which is deliberate and load-bearing: the MODEL
 * says authorType 'vendor', the CLIENT says author.type 'organizer'. authorDto
 * is where that translation happens; see isActorAuthorOf's note on why callers
 * must translate before comparing.
 */

interface BuyerAuthorDTO {
  type: 'buyer';
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
}

interface OrganizerAuthorDTO {
  type: 'organizer';
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type AuthorDTO = BuyerAuthorDTO | OrganizerAuthorDTO;

export interface AuthoredItem {
  authorType: SocialActorType;
  authorId: unknown;
}

export interface AuthorMaps {
  vendors: Map<string, any>;
  buyers: Map<string, any>;
}

/**
 * Load the Vendor/Buyer docs behind a set of (authorType, authorId) pairs in at
 * most two queries total. Callers pass EVERY row they intend to render at once
 * (questions + replies, or a whole page of comments) so author hydration never
 * degrades into one query per row.
 */
export async function loadAuthorMaps(items: AuthoredItem[]): Promise<AuthorMaps> {
  const vendorIds = [...new Set(items.filter((i) => i.authorType === 'vendor').map((i) => String(i.authorId)))];
  const buyerIds = [...new Set(items.filter((i) => i.authorType === 'buyer').map((i) => String(i.authorId)))];

  const [vendors, buyers] = await Promise.all([
    vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl') : Promise.resolve([]),
    buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : Promise.resolve([]),
  ]);

  return {
    vendors: new Map(vendors.map((v: any) => [String(v._id), v])),
    buyers: new Map(buyers.map((b: any) => [String(b._id), b])),
  };
}

export function authorDto(authorType: SocialActorType, authorId: unknown, maps: AuthorMaps): AuthorDTO {
  if (authorType === 'vendor') {
    const v = maps.vendors.get(String(authorId));
    return { type: 'organizer', id: String(authorId), name: v?.businessName ?? 'Organizer', avatarUrl: v?.logoUrl ?? null };
  }
  const b = maps.buyers.get(String(authorId));
  return { type: 'buyer', id: String(authorId), name: b?.name ?? null, username: b?.username ?? null, avatarUrl: b?.avatarUrl ?? null };
}

/**
 * A brand acting as an organizer has no `socialSuspendedAt` — only buyer
 * actors can be suspended (see @utils/socialSuspension.util). Every write path
 * that publishes world-readable content authored by an actor calls this first.
 */
export async function assertActorNotSuspended(actor: SocialActor): Promise<void> {
  if (actor.type !== 'buyer') return;
  const buyer = await Buyer.findById(actor.id);
  if (!buyer) throw new HttpError(404, 'Account not found');
  assertNotSuspended(buyer);
}
