import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';

/**
 * Which services businesses the public can SEE.
 *
 * Verification is a TRUST BADGE, not a visibility gate: a business is listed
 * and reachable the moment it signs up (PENDING) and simply carries no
 * verified sign until an admin flips it to VERIFIED.
 *
 * Gating visibility on VERIFIED is what produced the original bug — business
 * signup redirects a services vendor to its own /services/:id profile (landing
 * App.tsx HomeRoute), which answered "Business not found" for EVERY new
 * business until an admin got to it, reading to the owner as "your account
 * doesn't exist". Self-signup lands PENDING (ticketsAuth.registerBusiness) and
 * only AdminOrganizersController.updateVerification ever flips it, so that
 * dead end was guaranteed, not incidental.
 *
 * REJECTED and SUSPENDED stay hidden so admin takedown still works, as does
 * the isActive kill-switch.
 *
 * Lives in a leaf util rather than services.service so enquiry/review can
 * share it without an import cycle (services.service already imports
 * ReviewService). All three MUST answer this question identically: a listed
 * business has to be able to receive the leads and reviews its listing
 * generates, or the directory advertises a business whose enquiry button 404s.
 */
export const VISIBLE_BUSINESS_FILTER = {
  operatorType: OperatorType.SERVICES,
  verificationStatus: { $in: [VerificationStatus.PENDING, VerificationStatus.VERIFIED] },
  isActive: true,
};
