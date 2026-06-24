import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { TicketService } from '@services/ticket.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function sale(channel: SalesChannel) {
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 50,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'Vendor',
    channel,
    soldAt: new Date(),
  });
}

describe('getSales channel filter', () => {
  it('returns only sales matching the channel filter (superadmin scope)', async () => {
    await sale(SalesChannel.ONLINE);
    await sale(SalesChannel.BOX_OFFICE);
    await sale(SalesChannel.BOX_OFFICE);

    const res = await TicketService.getSales({
      vendorId: '', isSuperAdmin: true, channel: SalesChannel.BOX_OFFICE,
    });
    expect(res.data).toHaveLength(2);
    expect(res.data.every((s: any) => s.channel === 'box_office')).toBe(true);
  });

  it('returns channel on every row when no filter', async () => {
    await sale(SalesChannel.ONLINE);
    const res = await TicketService.getSales({ vendorId: '', isSuperAdmin: true });
    expect(res.data[0]!.channel).toBe('online');
  });
});
