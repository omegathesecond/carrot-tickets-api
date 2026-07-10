import { IBuyer } from '@models/buyer.model';

/** The one public shape for "a person" in lists. NEVER includes the phone. */
export interface BuyerSummary {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export function toBuyerSummary(buyer: IBuyer): BuyerSummary {
  return {
    id: String(buyer._id),
    username: buyer.username ?? null,
    name: buyer.name ?? null,
    avatarUrl: buyer.avatarUrl ?? null,
  };
}
