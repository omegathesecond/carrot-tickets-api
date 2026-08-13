import { scopePermissionsToType } from '@utils/permissions.util';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsPermission, TICKETS_ROLE_PERMISSIONS, TicketsRole } from '@interfaces/ticketsPermission.interface';

describe('scopePermissionsToType — SERVICES', () => {
  const owner = TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER];

  it('strips all ticket/event/transport perms but keeps brand + enquiries', () => {
    const scoped = scopePermissionsToType(owner, OperatorType.SERVICES);
    expect(scoped).toContain(TicketsPermission.EDIT_BRAND);
    expect(scoped).toContain(TicketsPermission.MANAGE_ENQUIRIES);
    expect(scoped).not.toContain(TicketsPermission.SELL_TICKETS);
    expect(scoped).not.toContain(TicketsPermission.CREATE_EVENT);
    expect(scoped).not.toContain(TicketsPermission.MANAGE_TRANSPORT);
  });

  it('keeps MANAGE_ENQUIRIES out of an events owner (services vertical stripped)', () => {
    const scoped = scopePermissionsToType(owner, OperatorType.EVENTS);
    expect(scoped).not.toContain(TicketsPermission.MANAGE_ENQUIRIES);
    expect(scoped).toContain(TicketsPermission.SELL_TICKETS);
  });
});
