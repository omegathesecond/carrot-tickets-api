import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('accepts channel "wristband" on a TicketSale', async () => {
  const sale = await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 0,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'Vendor',
    channel: SalesChannel.WRISTBAND,
    soldAt: new Date(),
  });
  expect(sale.channel).toBe('wristband');
});
