import {
  TicketsPermission,
  TicketsRole,
  TICKETS_ROLE_PERMISSIONS,
  EVENT_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';

describe('MANAGE_STOCK permission', () => {
  it('is defined in the tickets namespace', () => {
    expect(TicketsPermission.MANAGE_STOCK).toBe('tickets:manage_stock');
  });

  it('is an events-vertical permission (kept for events, stripped for transport)', () => {
    expect(EVENT_PERMISSIONS).toContain(TicketsPermission.MANAGE_STOCK);
    expect(TRANSPORT_PERMISSIONS).not.toContain(TicketsPermission.MANAGE_STOCK);
  });

  it('is granted to OWNER and MANAGER, not SALES or SCANNER', () => {
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER]).toContain(TicketsPermission.MANAGE_STOCK);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.MANAGER]).toContain(TicketsPermission.MANAGE_STOCK);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SALES]).not.toContain(TicketsPermission.MANAGE_STOCK);
    expect(TICKETS_ROLE_PERMISSIONS[TicketsRole.SCANNER]).not.toContain(TicketsPermission.MANAGE_STOCK);
  });
});
