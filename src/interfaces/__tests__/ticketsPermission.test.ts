import { TicketsRole, TICKETS_ROLE_PERMISSIONS, TicketsPermission } from '@interfaces/ticketsPermission.interface';

// Regression: organizers (OWNER) must never receive the platform-staff-only
// VIEW_USERS permission — it exposes the platform-wide buyer directory. Only
// super-admins (via middleware) or explicit grants may hold it.
it('OWNER role does not include tickets:view_users', () => {
  const perms = TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER];
  expect(perms).not.toContain(TicketsPermission.VIEW_USERS);
});

it('OWNER role keeps every other permission', () => {
  const perms = TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER];
  const everythingElse = Object.values(TicketsPermission).filter(
    (p) => p !== TicketsPermission.VIEW_USERS
  );
  expect(perms).toEqual(expect.arrayContaining(everythingElse));
});

it('no role includes tickets:view_users by default', () => {
  for (const role of Object.values(TicketsRole)) {
    expect(TICKETS_ROLE_PERMISSIONS[role]).not.toContain(TicketsPermission.VIEW_USERS);
  }
});
