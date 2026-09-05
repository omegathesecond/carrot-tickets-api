import { WaiterPermission, WAITER_PERMISSIONS } from '@interfaces/waiter.interface';

describe('what a waiter holds by default', () => {
  it('serves tables but does not settle them', () => {
    // Settling is the money moment. An organizer may want it held by a
    // supervisor rather than by whoever is carrying trays, so it is granted
    // per person — the same shape as issue_tags on a cashier.
    expect(WAITER_PERMISSIONS).toContain(WaiterPermission.VIEW_EVENTS);
    expect(WAITER_PERMISSIONS).toContain(WaiterPermission.MANAGE_TABLES);
    expect(WAITER_PERMISSIONS).not.toContain(WaiterPermission.SETTLE_TABLES);
  });

  it('namespaces every permission so it can never be confused with a cashier one', () => {
    for (const p of Object.values(WaiterPermission)) {
      expect(p.startsWith('waiter:')).toBe(true);
    }
  });
});
