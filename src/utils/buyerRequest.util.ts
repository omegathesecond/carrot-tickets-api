import { Request } from 'express';
import { Buyer, IBuyer } from '@models/buyer.model';
import { normalizePhone } from '@utils/phone.util';

/** Resolve the signed-in buyer document from the verified token phone. */
export async function resolveBuyerFromRequest(req: Request): Promise<IBuyer | null> {
  const phone = normalizePhone((req as any).ticketsUser?.userPhone || '');
  if (!phone) return null;
  return Buyer.findOne({ phone });
}
