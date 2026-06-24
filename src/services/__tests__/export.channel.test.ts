import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { ExportService } from '@services/export.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import '@models/vendor.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('sales CSV export channel column', () => {
  it('includes Channel/Reseller/Hub headers', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    await TicketSale.create({
      eventId: new mongoose.Types.ObjectId(),
      vendorId,
      ticketIds: [new mongoose.Types.ObjectId()],
      quantity: 1, totalAmount: 50,
      paymentMethod: PaymentMethod.CASH, paymentStatus: PaymentStatus.COMPLETED,
      soldBy: new mongoose.Types.ObjectId(), soldByType: 'Vendor',
      channel: SalesChannel.ONLINE, soldAt: new Date(),
    });
    // exportSalesToCSV is the actual method name; pass vendorId as string
    const csv = await ExportService.exportSalesToCSV({ vendorId: vendorId.toString() });
    const header = csv.split('\n')[0];
    expect(header).toContain('Channel');
    expect(header).toContain('Reseller');
    expect(header).toContain('Hub');
  });
});
