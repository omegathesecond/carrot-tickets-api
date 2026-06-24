import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { backfillSalesChannel } from '../backfillSalesChannel';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// Insert a channel-less sale directly, bypassing schema defaults, to mimic
// historical docs written before the channel field existed.
async function legacySale(extra: Record<string, any>) {
  await TicketSale.collection.insertOne({
    saleId: `SALE-${Date.now()}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`,
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 50,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(),
    soldAt: new Date(),
    ...extra,
  });
}

describe('backfillSalesChannel', () => {
  it('labels reseller / app-buyer / plain vendor sales and is idempotent', async () => {
    await legacySale({ soldByType: 'ResellerOperator', resellerId: new mongoose.Types.ObjectId() });
    await legacySale({ soldByType: 'Vendor', customerUserId: new mongoose.Types.ObjectId() });
    await legacySale({ soldByType: 'Vendor' });

    const counts = await backfillSalesChannel();
    expect(counts).toEqual({ reseller_pos: 1, online: 1, box_office: 1 });

    const channels = (await TicketSale.find().lean()).map((s) => (s as any).channel).sort();
    expect(channels).toEqual(['box_office', 'online', 'reseller_pos']);

    // Idempotent: a second run touches nothing.
    const second = await backfillSalesChannel();
    expect(second).toEqual({ reseller_pos: 0, online: 0, box_office: 0 });
  });
});
