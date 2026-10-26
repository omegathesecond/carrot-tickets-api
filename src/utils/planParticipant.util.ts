import { Request } from 'express';
import { Buyer, IBuyer, PROVIDER_PARTICIPANT_INDEX_OPTIONS } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';

let indexReady: Promise<string> | undefined;
const requestProfiles = new WeakMap<Request, Promise<IBuyer | null>>();

/** Plans and referral participation use a stable profile, independent of login.
 * Services owners act as their brand, never as a buyer sharing their phone.
 * The internal profile has no contact handles/password and cannot sign in.
 * Other vendor roles retain their existing access restrictions.
 */
export async function resolvePlanParticipant(req: Request): Promise<IBuyer | null> {
  const existing = requestProfiles.get(req);
  if (existing) return existing;
  const profile = resolveParticipant(req);
  requestProfiles.set(req, profile);
  return profile;
}

async function resolveParticipant(req: Request): Promise<IBuyer | null> {
  const user = (req as any).ticketsUser;
  if (user?.userType === 'buyer') return resolveBuyerFromRequest(req);
  if (user?.userType !== 'vendor' || !user.vendorId ||
      !user.permissions?.includes(TicketsPermission.EDIT_BRAND)) return null;
  const vendor = await Vendor.findOne({ _id: user.vendorId, operatorType: OperatorType.SERVICES, isActive: true });
  if (!vendor) return null;
  // Ensure uniqueness before the first upsert, including with autoIndex off.
  indexReady ??= Buyer.collection.createIndex({ sourceVendorId: 1 }, PROVIDER_PARTICIPANT_INDEX_OPTIONS)
    .catch((error) => { indexReady = undefined; throw error; });
  await indexReady;
  const profile = await Buyer.findOneAndUpdate(
    { sourceVendorId: vendor._id },
    { $set: { name: vendor.businessName, avatarUrl: vendor.logoUrl ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return profile;
}
