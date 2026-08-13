import {
  TicketsPermission,
  EVENT_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
  SERVICES_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';
import { OperatorType } from '@interfaces/vendor.interface';

/** Strip every vertical EXCEPT the operator's own (full disjoint partition). */
function disallowedForType(type: OperatorType): Set<TicketsPermission> {
  switch (type) {
    case OperatorType.EVENTS:    return new Set([...TRANSPORT_PERMISSIONS, ...SERVICES_PERMISSIONS]);
    case OperatorType.TRANSPORT: return new Set([...EVENT_PERMISSIONS, ...SERVICES_PERMISSIONS]);
    case OperatorType.SERVICES:  return new Set([...EVENT_PERMISSIONS, ...TRANSPORT_PERMISSIONS]);
    case OperatorType.BOTH:      return new Set(SERVICES_PERMISSIONS); // events+transport, not a service biz
    default:                     return new Set();
  }
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
