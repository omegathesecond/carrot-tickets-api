import {
  TicketsPermission,
  TicketsRole,
  TICKETS_ROLE_PERMISSIONS,
  EVENT_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
  SERVICES_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';
import { scopePermissionsToType } from '@utils/permissions.util';
import { OperatorType } from '@interfaces/vendor.interface';

describe('MANAGE_VENUE permission', () => {
  it('is defined in the tickets namespace', () => {
    expect(TicketsPermission.MANAGE_VENUE).toBe('tickets:manage_venue');
  });

  it('is an events-vertical permission', () => {
    expect(EVENT_PERMISSIONS).toContain(TicketsPermission.MANAGE_VENUE);
    expect(TRANSPORT_PERMISSIONS).not.toContain(TicketsPermission.MANAGE_VENUE);
    expect(SERVICES_PERMISSIONS).not.toContain(TicketsPermission.MANAGE_VENUE);
  });

  it('is in the OWNER default set only', () => {
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.MANAGE_VENUE);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]).not.toContain(TicketsPermission.MANAGE_VENUE);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SALES]).not.toContain(TicketsPermission.MANAGE_VENUE);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SCANNER]).not.toContain(TicketsPermission.MANAGE_VENUE);
  });

  it('survives scoping for a self-signup owner (operatorType events)', () => {
    const owner = scopePermissionsToType(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER], OperatorType.EVENTS);
    expect(owner).toContain(TicketsPermission.MANAGE_VENUE);
  });
});
