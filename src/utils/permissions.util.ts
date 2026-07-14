import {
  TicketsPermission,
  EVENT_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';
import { OperatorType } from '@interfaces/vendor.interface';

/** The permissions to strip for a type — the OPPOSITE vertical's perms. */
function disallowedForType(type: OperatorType): Set<TicketsPermission> {
  if (type === OperatorType.EVENTS) return new Set(TRANSPORT_PERMISSIONS);
  if (type === OperatorType.TRANSPORT) return new Set(EVENT_PERMISSIONS);
  return new Set(); // BOTH strips nothing
}

/**
 * Scope a base permission set to a vendor's operator type. Subtractive: removes
 * only the opposite vertical's perms; shared perms and the platform-staff perms
 * (which belong to no vertical group) always survive. Used to scope both the
 * owner's role-derived set and a sub-user's stored permission array.
 */
export function scopePermissionsToType(
  permissions: TicketsPermission[],
  type: OperatorType,
): TicketsPermission[] {
  const drop = disallowedForType(type);
  return permissions.filter((p) => !drop.has(p));
}
