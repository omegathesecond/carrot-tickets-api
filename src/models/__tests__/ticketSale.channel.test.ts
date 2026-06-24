import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { SalesChannel, PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

function baseSale(channel: SalesChannel) {
  return {
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 50,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'Vendor' as const,
    channel,
    soldAt: new Date(),
  };
}

describe('TicketSale.channel', () => {
  it('persists a valid channel value', async () => {
    const sale = await TicketSale.create(baseSale(SalesChannel.RESELLER_POS));
    expect(sale.channel).toBe('reseller_pos');
  });

  it('rejects an invalid channel value', async () => {
    await expect(
      TicketSale.create({ ...baseSale(SalesChannel.ONLINE), channel: 'bogus' as any }),
    ).rejects.toThrow();
  });
});
