import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { ResellerSettlement } from '@models/resellerSettlement.model';
import { OrganizerPayout } from '@models/organizerPayout.model';
import { SettlementService } from '@services/settlement.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('marking reseller settlement paid flips covered sales to remitted, freeing organizer proceeds', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  const vendorId = new mongoose.Types.ObjectId();
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(), vendorId, resellerId,
    ticketIds: [new mongoose.Types.ObjectId()], quantity: 1, paymentStatus: 'completed',
    soldBy: new mongoose.Types.ObjectId(), soldByType: 'ResellerOperator', paymentMethod: 'cash',
    totalAmount: 100, faceAmount: 100, resellerCommissionAmount: 8, platformFeeAmount: 0,
    organizerProceeds: 92, fundsCustody: 'reseller', resellerRemitted: false,
  });

  const from = new Date('2000-01-01');
  const to = new Date('2999-01-01');
  const s = await SettlementService.closeResellerSettlement(resellerId.toString(), from, to, 'admin1');
  expect(s.status).toBe('pending_payment');
  await SettlementService.markResellerSettlementPaid((s as any)._id.toString(), 'admin1', 'EFT-001');

  const b = await SettlementService.previewOrganizerPayout(vendorId.toString(), from, to);
  expect(b.availableProceeds).toBe(92); // now remitted -> available
});

it('vendor-cash sale contributes feeOwedByVendor and netAmount = proceedsOwed − feeOwedByVendor', async () => {
  const vendorId = new mongoose.Types.ObjectId();
  // Direct vendor-cash sale: custody is 'vendor', platformFee goes to Carrot
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(), vendorId,
    ticketIds: [new mongoose.Types.ObjectId()], quantity: 1, paymentStatus: 'completed',
    soldBy: new mongoose.Types.ObjectId(), soldByType: 'Vendor', paymentMethod: 'cash',
    totalAmount: 100, faceAmount: 100, resellerCommissionAmount: 0, platformFeeAmount: 5,
    organizerProceeds: 95, fundsCustody: 'vendor', resellerRemitted: false,
  });

  const from = new Date('2000-01-01');
  const to = new Date('2999-01-01');
  const b = await SettlementService.previewOrganizerPayout(vendorId.toString(), from, to);
  expect(b.feeOwedByVendor).toBe(5);
  expect(b.netAmount).toBe(b.proceedsOwed - b.feeOwedByVendor);
});

// ---------------------------------------------------------------------------
// I1 — crash-safe stamp-then-flip tests
// ---------------------------------------------------------------------------

function makeResellerSale(
  resellerId: mongoose.Types.ObjectId,
  vendorId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {},
) {
  return TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId,
    resellerId,
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    paymentStatus: 'completed',
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'ResellerOperator',
    paymentMethod: 'cash',
    totalAmount: 100,
    faceAmount: 100,
    resellerCommissionAmount: 10,
    platformFeeAmount: 0,
    organizerProceeds: 90,
    fundsCustody: 'reseller',
    resellerRemitted: false,
    ...overrides,
  });
}

it('markResellerSettlementPaid stamps covered sales BEFORE flipping to settled', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  const vendorId = new mongoose.Types.ObjectId();
  const sale = await makeResellerSale(resellerId, vendorId);

  const from = new Date('2000-01-01');
  const to = new Date('2999-01-01');
  const s = await SettlementService.closeResellerSettlement(
    resellerId.toString(), from, to, 'admin1',
  );

  await SettlementService.markResellerSettlementPaid(
    (s as any)._id.toString(), 'admin1', 'EFT-I1',
  );

  // Sale must be stamped resellerRemitted:true
  const updatedSale = await TicketSale.findById((sale as any)._id);
  expect(updatedSale?.resellerRemitted).toBe(true);

  // Settlement must be settled
  const updatedSettlement = await ResellerSettlement.findById((s as any)._id);
  expect(updatedSettlement?.status).toBe('settled');
});

it('markResellerSettlementPaid second call throws "already settled"', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  const vendorId = new mongoose.Types.ObjectId();
  await makeResellerSale(resellerId, vendorId);

  const from = new Date('2001-01-01');
  const to = new Date('2001-12-31');
  const s = await SettlementService.closeResellerSettlement(
    resellerId.toString(), from, to, 'admin1',
  );

  const id = (s as any)._id.toString();
  await SettlementService.markResellerSettlementPaid(id, 'admin1', 'EFT-001');

  await expect(
    SettlementService.markResellerSettlementPaid(id, 'admin1', 'EFT-002'),
  ).rejects.toThrow(/already settled/i);
});

it('markResellerSettlementPaid on unknown id throws "Settlement not found"', async () => {
  const unknownId = new mongoose.Types.ObjectId().toString();
  await expect(
    SettlementService.markResellerSettlementPaid(unknownId, 'admin1'),
  ).rejects.toThrow(/not found/i);
});

// ---------------------------------------------------------------------------
// I2 — overlap guard tests for ResellerSettlement
// ---------------------------------------------------------------------------

it('closeResellerSettlement same period twice throws overlap error', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  const vendorId = new mongoose.Types.ObjectId();
  await makeResellerSale(resellerId, vendorId, { soldAt: new Date('2023-01-15') });

  const from = new Date('2023-01-01');
  const to = new Date('2023-01-31');
  await SettlementService.closeResellerSettlement(resellerId.toString(), from, to, 'admin1');

  await expect(
    SettlementService.closeResellerSettlement(resellerId.toString(), from, to, 'admin1'),
  ).rejects.toThrow(/overlapping/i);
});

it('closeResellerSettlement partially overlapping period throws overlap error', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  const vendorId = new mongoose.Types.ObjectId();
  await makeResellerSale(resellerId, vendorId, { soldAt: new Date('2023-02-15') });

  const from1 = new Date('2023-02-01');
  const to1 = new Date('2023-02-28');
  await SettlementService.closeResellerSettlement(resellerId.toString(), from1, to1, 'admin1');

  // Overlaps Feb 15 – Feb 28
  const from2 = new Date('2023-02-15');
  const to2 = new Date('2023-03-15');
  await expect(
    SettlementService.closeResellerSettlement(resellerId.toString(), from2, to2, 'admin1'),
  ).rejects.toThrow(/overlapping/i);
});

it('closeResellerSettlement non-overlapping later period succeeds', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  const vendorId = new mongoose.Types.ObjectId();
  await makeResellerSale(resellerId, vendorId, { soldAt: new Date('2023-03-15') });

  const from1 = new Date('2023-03-01');
  const to1 = new Date('2023-03-31');
  await SettlementService.closeResellerSettlement(resellerId.toString(), from1, to1, 'admin1');

  // Non-overlapping: April
  const from2 = new Date('2023-04-01');
  const to2 = new Date('2023-04-30');
  const result = await SettlementService.closeResellerSettlement(
    resellerId.toString(), from2, to2, 'admin1',
  );
  expect(result).toBeDefined();
  expect(result.status).toBe('pending_payment');
});

// ---------------------------------------------------------------------------
// I2 — overlap guard tests for OrganizerPayout
// ---------------------------------------------------------------------------

it('closeOrganizerPayout same period twice throws overlap error', async () => {
  const vendorId = new mongoose.Types.ObjectId();

  const from = new Date('2023-05-01');
  const to = new Date('2023-05-31');
  await SettlementService.closeOrganizerPayout(vendorId.toString(), from, to, 'admin1');

  await expect(
    SettlementService.closeOrganizerPayout(vendorId.toString(), from, to, 'admin1'),
  ).rejects.toThrow(/overlapping/i);
});

it('closeOrganizerPayout partially overlapping period throws overlap error', async () => {
  const vendorId = new mongoose.Types.ObjectId();

  const from1 = new Date('2023-06-01');
  const to1 = new Date('2023-06-30');
  await SettlementService.closeOrganizerPayout(vendorId.toString(), from1, to1, 'admin1');

  const from2 = new Date('2023-06-15');
  const to2 = new Date('2023-07-15');
  await expect(
    SettlementService.closeOrganizerPayout(vendorId.toString(), from2, to2, 'admin1'),
  ).rejects.toThrow(/overlapping/i);
});

it('closeOrganizerPayout non-overlapping later period succeeds', async () => {
  const vendorId = new mongoose.Types.ObjectId();

  const from1 = new Date('2023-07-01');
  const to1 = new Date('2023-07-31');
  await SettlementService.closeOrganizerPayout(vendorId.toString(), from1, to1, 'admin1');

  const from2 = new Date('2023-08-01');
  const to2 = new Date('2023-08-31');
  const result = await SettlementService.closeOrganizerPayout(
    vendorId.toString(), from2, to2, 'admin1',
  );
  expect(result).toBeDefined();
  expect(result.status).toBe('pending_payment');
});
