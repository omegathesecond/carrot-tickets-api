import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
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
