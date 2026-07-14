import { TicketsPermission, TICKETS_ROLE_PERMISSIONS, TicketsRole,
  EVENT_PERMISSIONS, TRANSPORT_PERMISSIONS, SHARED_PERMISSIONS } from '@interfaces/ticketsPermission.interface';
import { OperatorType } from '@interfaces/vendor.interface';
import { scopePermissionsToType } from '@utils/permissions.util';

const OWNER = TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER];
const STAFF = [TicketsPermission.VIEW_USERS, TicketsPermission.PRINT_WRISTBANDS, TicketsPermission.MODERATE_SOCIAL];

describe('vertical permission groups', () => {
  it('partition all non-staff permissions (disjoint + exhaustive)', () => {
    const groups = [...EVENT_PERMISSIONS, ...TRANSPORT_PERMISSIONS, ...SHARED_PERMISSIONS];
    // disjoint
    expect(new Set(groups).size).toBe(groups.length);
    // exhaustive: every non-staff permission appears in exactly one group
    const nonStaff = Object.values(TicketsPermission).filter((p) => !STAFF.includes(p));
    expect(new Set(groups)).toEqual(new Set(nonStaff));
  });
});

describe('scopePermissionsToType', () => {
  it('events strips transport perms, keeps event perms', () => {
    const scoped = scopePermissionsToType(OWNER, OperatorType.EVENTS);
    expect(scoped).not.toContain(TicketsPermission.MANAGE_TRANSPORT);
    expect(scoped).not.toContain(TicketsPermission.VIEW_TRANSPORT);
    expect(scoped).toContain(TicketsPermission.CREATE_EVENT);
  });

  it('transport strips event perms, keeps the two transport perms', () => {
    const scoped = scopePermissionsToType(OWNER, OperatorType.TRANSPORT);
    expect(scoped).not.toContain(TicketsPermission.CREATE_EVENT);
    expect(scoped).toEqual(expect.arrayContaining([TicketsPermission.VIEW_TRANSPORT, TicketsPermission.MANAGE_TRANSPORT]));
    expect(scoped.filter((p) => EVENT_PERMISSIONS.includes(p))).toHaveLength(0);
  });

  it('both strips nothing', () => {
    expect(scopePermissionsToType(OWNER, OperatorType.BOTH).sort()).toEqual([...OWNER].sort());
  });

  it('never strips platform-staff perms (they belong to no vertical)', () => {
    const withStaff = [...OWNER, ...STAFF];
    const scoped = scopePermissionsToType(withStaff, OperatorType.EVENTS);
    STAFF.forEach((p) => expect(scoped).toContain(p));
  });
});
