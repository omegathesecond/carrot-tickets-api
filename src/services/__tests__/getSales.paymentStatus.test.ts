import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { TicketService } from '@services/ticket.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function sale(vendorId: mongoose.Types.ObjectId, paymentStatus: PaymentStatus) {
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId,
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 50,
    paymentMethod: PaymentMethod.MTN_MOMO,
    paymentStatus,
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'Vendor',
    channel: SalesChannel.ONLINE,
    soldAt: new Date(),
  });
}

describe('getSales paymentStatus visibility', () => {
  it('organizers only see completed sales', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    await sale(vendorId, PaymentStatus.COMPLETED);
    await sale(vendorId, PaymentStatus.FAILED);
    await sale(vendorId, PaymentStatus.PENDING);

    const res = await TicketService.getSales({ vendorId: vendorId.toString() });
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.paymentStatus).toBe('completed');
  });

  it('organizers cannot opt back in to failed sales via the paymentStatus filter', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    await sale(vendorId, PaymentStatus.COMPLETED);
    await sale(vendorId, PaymentStatus.FAILED);

    const res = await TicketService.getSales({
      vendorId: vendorId.toString(),
      paymentStatus: PaymentStatus.FAILED,
    });
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.paymentStatus).toBe('completed');
  });

  it('super-admins see every payment status and can filter to failed', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    await sale(vendorId, PaymentStatus.COMPLETED);
    await sale(vendorId, PaymentStatus.FAILED);
    await sale(vendorId, PaymentStatus.PENDING);

    const all = await TicketService.getSales({ vendorId: '', isSuperAdmin: true });
    expect(all.data).toHaveLength(3);

    const failed = await TicketService.getSales({
      vendorId: '',
      isSuperAdmin: true,
      paymentStatus: PaymentStatus.FAILED,
    });
    expect(failed.data).toHaveLength(1);
    expect(failed.data[0]!.paymentStatus).toBe('failed');
  });
});
