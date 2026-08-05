import { Request } from 'express';
import { Buyer, IBuyer } from '@models/buyer.model';
import { normalizePhone } from '@utils/phone.util';

/**
 * Resolve the signed-in buyer from the verified token. buyerId is the canonical
 * key (email buyers always carry it); older/phone tokens fall back to userPhone.
 */
export async function resolveBuyerFromRequest(req: Request): Promise<IBuyer | null> {
  const u = (req as any).ticketsUser;
  if (u?.buyerId) return Buyer.findById(u.buyerId);
  const phone = normalizePhone(u?.userPhone || '');
  if (phone) return Buyer.findOne({ phone });
  return null;
}
