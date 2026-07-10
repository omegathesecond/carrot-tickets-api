import { BuyerPresence } from '@models/buyerPresence.model';

export const PRESENCE_STALE_MS = 120_000;

/** ONLINE = any gateway socket row fresher than the staleness window. Used to
 *  suppress push for buyers who are actively connected (spec §6 offline-only). */
export async function isBuyerOnline(buyerId: string): Promise<boolean> {
  const hit = await BuyerPresence.exists({
    buyerId,
    lastSeenAt: { $gt: new Date(Date.now() - PRESENCE_STALE_MS) },
  });
  return hit !== null;
}
