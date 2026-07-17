import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import { TicketsRole, TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { backfillEditBrandPermission } from '../backfillEditBrandPermission';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function legacyAccess(role: TicketsRole, permissions: TicketsPermission[]) {
  return TicketsUserAccess.create({
    userId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    role,
    permissions,
    isActive: true,
  });
}

describe('backfillEditBrandPermission', () => {
  it('grants EDIT_BRAND to a MANAGER access row missing it', async () => {
    const manager = await legacyAccess(TicketsRole.MANAGER, [
      TicketsPermission.CREATE_EVENT,
      TicketsPermission.EDIT_EVENT,
    ]);

    // Before backfill: the persisted array predates the enum value.
    expect(manager.permissions).not.toContain(TicketsPermission.EDIT_BRAND);

    const result = await backfillEditBrandPermission();
    expect(result.updated).toBe(1);

    const refreshed = await TicketsUserAccess.findById(manager._id).lean();
    expect(refreshed?.permissions).toContain(TicketsPermission.EDIT_BRAND);
  });

  it('does NOT grant EDIT_BRAND to a SALES access row', async () => {
    const sales = await legacyAccess(TicketsRole.SALES, [
      TicketsPermission.VIEW_EVENTS,
      TicketsPermission.SELL_TICKETS,
    ]);

    const result = await backfillEditBrandPermission();
    expect(result.updated).toBe(0);

    const refreshed = await TicketsUserAccess.findById(sales._id).lean();
    expect(refreshed?.permissions).not.toContain(TicketsPermission.EDIT_BRAND);
  });

  it('does NOT grant EDIT_BRAND to a SCANNER access row', async () => {
    const scanner = await legacyAccess(TicketsRole.SCANNER, [
      TicketsPermission.VIEW_EVENTS,
      TicketsPermission.SCAN_TICKETS,
    ]);

    const result = await backfillEditBrandPermission();
    expect(result.updated).toBe(0);

    const refreshed = await TicketsUserAccess.findById(scanner._id).lean();
    expect(refreshed?.permissions).not.toContain(TicketsPermission.EDIT_BRAND);
  });

  it('is idempotent: a second run touches nothing', async () => {
    await legacyAccess(TicketsRole.MANAGER, [TicketsPermission.CREATE_EVENT]);
    await legacyAccess(TicketsRole.SALES, [TicketsPermission.SELL_TICKETS]);

    const first = await backfillEditBrandPermission();
    expect(first.updated).toBe(1);

    const second = await backfillEditBrandPermission();
    expect(second.updated).toBe(0);
  });

  it('is a no-op for a MANAGER row that already has EDIT_BRAND', async () => {
    await legacyAccess(TicketsRole.MANAGER, [
      TicketsPermission.CREATE_EVENT,
      TicketsPermission.EDIT_BRAND,
    ]);

    const result = await backfillEditBrandPermission();
    expect(result.updated).toBe(0);
  });
});
