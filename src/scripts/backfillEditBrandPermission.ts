/**
 * One-time, idempotent backfill of `TicketsPermission.EDIT_BRAND` onto
 * persisted `TicketsUserAccess.permissions` arrays for the sub-user role(s)
 * that legitimately hold it per `TICKETS_ROLE_PERMISSIONS`.
 *
 * WHY this is needed: EDIT_BRAND was introduced when the two
 * organizer-profile routes (`PATCH /organizer/profile`,
 * `POST /organizer/profile/logo`) were repointed from EDIT_EVENT ->
 * EDIT_BRAND, and `canEditBrand` (which drives the frontend Edit-profile
 * button) now checks EDIT_BRAND instead of EDIT_EVENT.
 *
 * `TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]` grants EDIT_BRAND going
 * forward, but existing MANAGER `TicketsUserAccess` rows were persisted
 * BEFORE the enum value existed, so their stored `permissions` array does
 * not contain it. Both refresh (`ticketsAuth.service.ts`) and re-login read
 * that persisted array, NOT the role table, so without this backfill
 * affected MANAGERs silently lose brand-editing capability they previously
 * had via EDIT_EVENT — fails closed, no error: the Edit-profile button just
 * never appears again, even after logging out and back in.
 *
 * Scope is derived from `TICKETS_ROLE_PERMISSIONS` (not hardcoded) so this
 * stays correct if role grants change, with one deliberate exclusion:
 *   - OWNER also carries EDIT_BRAND in the table, but OWNER permissions are
 *     re-derived live from the vendor record on every refresh/login (see
 *     `TicketsAuthService.refreshAccessToken`) and are never persisted to
 *     TicketsUserAccess — there is nothing to backfill for OWNER.
 *   - SALES/SCANNER never appear in the derived set because
 *     TICKETS_ROLE_PERMISSIONS does not grant them EDIT_BRAND: staff must
 *     never be able to overwrite brand identity, which is the entire point
 *     of `canEditBrand`.
 *
 * The query excludes rows that already carry EDIT_BRAND (mirrors the
 * `{ field: { $exists: false } }` filter idiom in the other backfill
 * scripts in this directory) rather than relying on `$addToSet` alone to
 * make re-runs a true no-op: `TicketsUserAccess`'s schema has
 * `timestamps: true`, so an unfiltered `updateMany` would still bump
 * `updatedAt` on every matched row on every run even when `$addToSet` adds
 * nothing — harmless, but it defeats "re-running matches nothing" and
 * spuriously touches already-migrated rows forever. Filtering the query
 * itself is what actually makes re-runs inert.
 *
 * Safe to run against the OLD code too, the same as the existing backfill
 * scripts in this directory.
 */
import mongoose from 'mongoose';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import {
  TicketsRole,
  TicketsPermission,
  TICKETS_ROLE_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';

const rolesToBackfill = (Object.keys(TICKETS_ROLE_PERMISSIONS) as TicketsRole[]).filter(
  (role) =>
    role !== TicketsRole.OWNER &&
    TICKETS_ROLE_PERMISSIONS[role].includes(TicketsPermission.EDIT_BRAND)
);

export async function backfillEditBrandPermission(): Promise<{ updated: number }> {
  const res = await TicketsUserAccess.updateMany(
    {
      role: { $in: rolesToBackfill },
      permissions: { $ne: TicketsPermission.EDIT_BRAND },
    },
    { $addToSet: { permissions: TicketsPermission.EDIT_BRAND } },
  );
  return { updated: res.modifiedCount };
}

// Allow running directly: `ts-node -r tsconfig-paths/register src/scripts/backfillEditBrandPermission.ts`
if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    const counts = await backfillEditBrandPermission();
    console.log('[backfillEditBrandPermission] done:', counts);
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillEditBrandPermission] failed:', err);
    process.exit(1);
  });
}
