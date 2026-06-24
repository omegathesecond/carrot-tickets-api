import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { SettlementService } from '@services/settlement.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const mk = (o: any) => TicketSale.create({
  eventId: new mongoose.Types.ObjectId(), ticketIds: [new mongoose.Types.ObjectId()],
  quantity: 1, paymentStatus: 'completed', soldBy: new mongoose.Types.ObjectId(), ...o,
});

it('aggregates both ledgers correctly', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  const vendorId = new mongoose.Types.ObjectId();
  // reseller cash sale: reseller owes 92, organizer proceeds 92 (held by reseller, not remitted)
  await mk({ vendorId, resellerId, soldByType: 'ResellerOperator', paymentMethod: 'cash',
    totalAmount: 100, faceAmount: 100, resellerCommissionAmount: 8, platformFeeAmount: 0,
    organizerProceeds: 92, fundsCustody: 'reseller', resellerRemitted: false });
  // reseller electronic sale: carrot holds; commission 8 owed to reseller; proceeds 92 available
  await mk({ vendorId, resellerId, soldByType: 'ResellerOperator', paymentMethod: 'mtn_momo',
    totalAmount: 100, faceAmount: 100, resellerCommissionAmount: 8, platformFeeAmount: 0,
    organizerProceeds: 92, fundsCustody: 'carrot' });

  const from = new Date('2000-01-01'); const to = new Date('2999-01-01');
  const a = await SettlementService.previewResellerSettlement(resellerId.toString(), from, to);
  expect(a.cashOwedToCarrot).toBe(92);
  expect(a.commissionOwedByCarrot).toBe(8); // still reported for display
  expect(a.netAmount).toBe(92);             // net = cash only; commission paid via wallet

  const b = await SettlementService.previewOrganizerPayout(vendorId.toString(), from, to);
  expect(b.proceedsOwed).toBe(184);          // 92 + 92
  expect(b.availableProceeds).toBe(92);       // only the carrot-held one
});
