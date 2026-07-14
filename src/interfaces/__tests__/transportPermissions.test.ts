import { TicketsPermission, TicketsRole, TICKETS_ROLE_PERMISSIONS } from '@interfaces/ticketsPermission.interface';

describe('transport permissions', () => {
  it('defines VIEW_TRANSPORT and MANAGE_TRANSPORT', () => {
    expect(TicketsPermission.VIEW_TRANSPORT).toBe('tickets:view_transport');
    expect(TicketsPermission.MANAGE_TRANSPORT).toBe('tickets:manage_transport');
  });
  it('OWNER has both (non-platform-staff perm)', () => {
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.MANAGE_TRANSPORT);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.VIEW_TRANSPORT);
  });
  it('MANAGER has both', () => {
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]).toContain(TicketsPermission.MANAGE_TRANSPORT);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]).toContain(TicketsPermission.VIEW_TRANSPORT);
  });
});
