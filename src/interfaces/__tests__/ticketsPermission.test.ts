import { TicketsRole, TICKETS_ROLE_PERMISSIONS, TicketsPermission } from '@interfaces/ticketsPermission.interface';

// Platform-staff-only permissions: never part of any role's default set.
const PLATFORM_ONLY = [TicketsPermission.VIEW_USERS, TicketsPermission.PRINT_WRISTBANDS];

// Regression: organizers (OWNER) must never receive the platform-staff-only
// permissions — VIEW_USERS exposes the platform-wide buyer directory and
// PRINT_WRISTBANDS mints zero-amount tickets on the office printer.
it('OWNER role includes no platform-staff-only permission', () => {
  const perms = TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER];
  for (const p of PLATFORM_ONLY) expect(perms).not.toContain(p);
});

it('OWNER role keeps every other permission', () => {
  const perms = TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER];
  const everythingElse = Object.values(TicketsPermission).filter(
    (p) => !PLATFORM_ONLY.includes(p)
  );
  expect(perms).toEqual(expect.arrayContaining(everythingElse));
});

it('no role includes a platform-staff-only permission by default', () => {
  for (const role of Object.values(TicketsRole)) {
    for (const p of PLATFORM_ONLY) {
      expect(TICKETS_ROLE_PERMISSIONS[role]).not.toContain(p);
    }
  }
});
