import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import type { UpdateAuthorType } from '@interfaces/update.interface';

export interface UpdateAuthor {
  type: 'organizer' | 'buyer';
  id: string;
  name: string | null;
  avatarUrl: string | null;
  username?: string | null;
  slug?: string;
}

/** Author display for ONE update. Mirrors the field mapping in
 *  feed.service.ts (which batches many updates via $in); this single-lookup
 *  variant is what the single-post `getOne` endpoint uses so a cold/shared
 *  /post/:id link can render the author header (buyers have no get-by-id
 *  endpoint otherwise). */
export async function resolveUpdateAuthor(
  authorType: UpdateAuthorType,
  authorId: string,
): Promise<UpdateAuthor> {
  if (authorType === 'vendor') {
    const v = await Vendor.findById(authorId).select('businessName slug logoUrl').lean();
    return {
      type: 'organizer',
      id: String(authorId),
      name: (v as any)?.businessName ?? 'Organizer',
      avatarUrl: (v as any)?.logoUrl ?? null,
      slug: (v as any)?.slug,
    };
  }
  const b = await Buyer.findById(authorId).select('username name avatarUrl').lean();
  return {
    type: 'buyer',
    id: String(authorId),
    name: (b as any)?.name ?? null,
    username: (b as any)?.username ?? null,
    avatarUrl: (b as any)?.avatarUrl ?? null,
  };
}
