import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { TicketsAuthService } from '@services/ticketsAuth.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

async function make(type: OperatorType) {
  await Vendor.create({ businessName: 'X', email: 'o@x.co', password: 'secret1', operatorType: type });
  return TicketsAuthService.login('o@x.co', 'secret1');
}

describe('owner token scoping', () => {
  it('events owner has no transport perms and reports operatorType', async () => {
    const r = await make(OperatorType.EVENTS);
    expect(r.user.permissions).not.toContain(TicketsPermission.MANAGE_TRANSPORT);
    expect(r.user.permissions).toContain(TicketsPermission.CREATE_EVENT);
    expect((r.user as any).operatorType).toBe('events');
  });

  it('transport owner has transport perms but no event perms', async () => {
    const r = await make(OperatorType.TRANSPORT);
    expect(r.user.permissions).toEqual(expect.arrayContaining([TicketsPermission.VIEW_TRANSPORT, TicketsPermission.MANAGE_TRANSPORT]));
    expect(r.user.permissions).not.toContain(TicketsPermission.CREATE_EVENT);
    expect((r.user as any).operatorType).toBe('transport');
  });

  it('getMe reflects the same scoping', async () => {
    const v = await Vendor.create({ businessName: 'Y', email: 'g@y.co', password: 'secret1', operatorType: OperatorType.TRANSPORT });
    const me = await TicketsAuthService.getMe(undefined, v._id.toString(), 'vendor');
    expect(me.permissions).not.toContain(TicketsPermission.CREATE_EVENT);
    expect((me as any).operatorType).toBe('transport');
  });
});
