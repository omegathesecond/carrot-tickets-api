import { Types } from 'mongoose';
import { ITicketType } from '@interfaces/event.interface';

/**
 * The resellerId a ticket sale must be attributed to.
 *
 * For an ALLOCATION tier (a block a reseller pre-bought off-platform and resells
 * on their own behalf) the owning reseller is the tier's `resellerId` — even for
 * an online buyer who carries no reseller context — because those proceeds are
 * held for that reseller's settlement and kept OFF the organizer's revenue. For
 * an ordinary tier it's whatever reseller context the caller supplied (a POS
 * operator sale), or undefined for a plain online buyer.
 *
 * Fails loudly if an allocation tier has no `resellerId`: that's a
 * misconfiguration, and silently letting it fall through would wrongly credit
 * the organizer and hide the sale from the reseller.
 */
export function resolveSaleResellerId(
  tt: Pick<ITicketType, 'isAllocation' | 'resellerId'> & { resellerId?: Types.ObjectId },
  callerResellerId?: string
): string | undefined {
  if (tt.isAllocation) {
    if (!tt.resellerId) {
      throw new Error('Allocation tier is missing resellerId — cannot attribute sale');
    }
    return String(tt.resellerId);
  }
  return callerResellerId;
}
