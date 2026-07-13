import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { BookingSale } from '@models/transport/bookingSale.model';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('BookingSale model', () => {
  it('auto-generates saleRef and defaults paymentStatus PENDING', async () => {
    const sale = await BookingSale.create({
      tripId: new mongoose.Types.ObjectId(),
      vendorId: new mongoose.Types.ObjectId(),
      bookingIds: [new mongoose.Types.ObjectId()],
      quantity: 1,
      totalAmount: 35,
      paymentMethod: PaymentMethod.CASH,
      soldBy: new mongoose.Types.ObjectId(),
      soldByType: 'ResellerOperator',
      channel: SalesChannel.RESELLER_POS,
    });
    expect(sale.saleRef).toMatch(/^BSALE-/);
    expect(sale.paymentStatus).toBe(PaymentStatus.PENDING);
  });
});
