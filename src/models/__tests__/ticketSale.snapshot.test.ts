import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('persists economic snapshot + reseller attribution', async () => {
  const sale = await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 100,
    paymentMethod: 'cash',
    paymentStatus: 'completed',
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'ResellerOperator',
    resellerId: new mongoose.Types.ObjectId(),
    hubId: new mongoose.Types.ObjectId(),
    faceAmount: 100,
    resellerCommissionPercent: 8,
    resellerCommissionAmount: 8,
    platformFeePercent: 0,
    platformFeeAmount: 0,
    organizerProceeds: 92,
    fundsCustody: 'reseller',
  });
  expect(sale.soldByType).toBe('ResellerOperator');
  expect(sale.fundsCustody).toBe('reseller');
  expect(sale.resellerRemitted).toBe(false);
});
