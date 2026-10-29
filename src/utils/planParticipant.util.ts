import { Request } from 'express';
import { Buyer, IBuyer, PROVIDER_PARTICIPANT_INDEX_OPTIONS } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';

let indexReady: Promise<string> | undefined;

/** Plans and referral participation use a stable profile, independent of login.
 * Eligible brand owners act as their brand, never as a buyer sharing their phone.
 * The internal profile has no contact handles/password and cannot sign in.
 * Each feature selects its eligible operator types; staff access stays restricted.
 */
function participantResolver(operatorTypes: OperatorType[]) {
  const requestProfiles = new WeakMap<Request, Promise<IBuyer | null>>();
  return async (req: Request): Promise<IBuyer | null> => {
    const existing = requestProfiles.get(req);
    if (existing) return existing;
    const profile = resolveParticipant(req, operatorTypes);
    requestProfiles.set(req, profile);
    return profile;
  };
}

export const resolvePlanParticipant = participantResolver([OperatorType.SERVICES]);
/** Weekend posts are open to organizer and service-provider brand owners. */
export const resolveWeekendParticipant = participantResolver([OperatorType.EVENTS, OperatorType.BOTH, OperatorType.SERVICES]);

async function resolveParticipant(req: Request, operatorTypes: OperatorType[]): Promise<IBuyer | null> {
  const user = (req as any).ticketsUser;
  if (user?.userType === 'buyer') return resolveBuyerFromRequest(req);
  if (user?.userType !== 'vendor' || !user.vendorId ||
      !user.permissions?.includes(TicketsPermission.EDIT_BRAND)) return null;
  const vendor = await Vendor.findOne({ _id: user.vendorId, operatorType: { $in: operatorTypes }, isActive: true });
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
