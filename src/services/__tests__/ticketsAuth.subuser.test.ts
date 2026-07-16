import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { VendorSubUser } from '@models/vendorSubUser.model';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsRole, TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { SubUserRole } from '@interfaces/subUser.interface';
import { TicketsAuthService } from '@services/ticketsAuth.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

async function subUserOf(type: OperatorType, perms: TicketsPermission[]) {
  const vendor = await Vendor.create({ businessName: 'V', email: 'v@v.co', password: 'secret1', operatorType: type });
  // NOTE: VendorSubUser has no `username` schema field (confirmed against
  // src/models/vendorSubUser.model.ts — only email/phoneNumber are login
  // identifiers) and `role` is a required SubUserRole (manager/sales/scanner),
  // not the TicketsRole used by TicketsUserAccess. `.create()` silently drops
  // the unknown `username` key, so TicketsAuthService.login's
  // `VendorSubUser.findOne({ username: identifier })` lookup can never match
  // a real document — that lookup is pre-existing, unrelated to this task.
  // We write `username` straight to the collection so this test can still
  // drive the login() sub-user branch (the thing Task 4 actually touches)
  // without patching that unrelated lookup bug.
  const su = await VendorSubUser.create({ vendorId: vendor._id, fullName: 'Staff One', password: 'secret1', role: SubUserRole.MANAGER });
  await VendorSubUser.collection.updateOne({ _id: su._id }, { $set: { username: 'staff1' } });
  await TicketsUserAccess.create({ userId: su._id, vendorId: vendor._id, role: TicketsRole.MANAGER, permissions: perms, isActive: true });
  return TicketsAuthService.login('staff1', 'secret1');
}

describe('sub-user token scoping', () => {
  it("strips transport perms for a sub-user of an events vendor", async () => {
    const r = await subUserOf(OperatorType.EVENTS, [TicketsPermission.VIEW_EVENTS, TicketsPermission.MANAGE_TRANSPORT]);
    expect(r.user.permissions).toContain(TicketsPermission.VIEW_EVENTS);
    expect(r.user.permissions).not.toContain(TicketsPermission.MANAGE_TRANSPORT);
  });

  it('preserves platform-staff perms regardless of type', async () => {
    const r = await subUserOf(OperatorType.TRANSPORT, [TicketsPermission.VIEW_USERS, TicketsPermission.VIEW_TRANSPORT, TicketsPermission.CREATE_EVENT]);
    expect(r.user.permissions).toContain(TicketsPermission.VIEW_USERS);      // staff — survives
    expect(r.user.permissions).toContain(TicketsPermission.VIEW_TRANSPORT);  // own vertical — survives
    expect(r.user.permissions).not.toContain(TicketsPermission.CREATE_EVENT); // other vertical — stripped
  });
});
