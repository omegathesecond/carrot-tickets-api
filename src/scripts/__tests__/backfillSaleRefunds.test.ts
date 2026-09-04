import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { PaymentMethod, PaymentStatus, TicketStatus, SalesChannel } from '@interfaces/ticket.interface';
import { backfillSaleRefunds } from '../backfillSaleRefunds';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const vendorId = new mongoose.Types.ObjectId();
const eventId = new mongoose.Types.ObjectId();

async function saleDoc(quantity: number, totalAmount: number) {
  return TicketSale.create({
    eventId, vendorId, ticketIds: [], quantity,
    customerName: 'B', customerPhone: '+26878422613',
    totalAmount, amountCharged: totalAmount,
    paymentMethod: PaymentMethod.CASH, paymentStatus: PaymentStatus.COMPLETED,
    soldBy: vendorId, soldByType: 'Vendor', channel: SalesChannel.BOX_OFFICE,
    faceAmount: totalAmount, platformFeeAmount: 0, organizerProceeds: totalAmount, resellerCommission: 0,
    fundsCustody: 'carrot', soldAt: new Date(),
  });
}

async function ticketDoc(saleId: any, price: number, status: TicketStatus) {
  return Ticket.create({
    eventId, vendorId, ticketId: 'T' + Math.random().toString(36).slice(2, 10),
    customerPhone: '+26878422613', customerName: 'B', ticketType: 'General', price, status, saleId,
  });
}

describe('backfillSaleRefunds', () => {
  it('sets refundedQuantity/refundedAmount on sales whose tickets were refunded before the counters existed', async () => {
    // Legacy shape: tickets refunded, sale untouched (no counters at all).
    const refundedSale = await saleDoc(3, 300);
    await ticketDoc(refundedSale._id, 100, TicketStatus.REFUNDED);
    await ticketDoc(refundedSale._id, 100, TicketStatus.REFUNDED);
    await ticketDoc(refundedSale._id, 100, TicketStatus.SOLD);
    await TicketSale.updateOne({ _id: refundedSale._id }, { $unset: { refundedQuantity: 1, refundedAmount: 1 } });

    const cleanSale = await saleDoc(1, 150);
    await ticketDoc(cleanSale._id, 150, TicketStatus.CHECKED_IN);

    const result = await backfillSaleRefunds();

    expect(result).toEqual({ salesUpdated: 1, refundedTickets: 2 });
    const refreshed = await TicketSale.findById(refundedSale._id).lean();
    expect(refreshed?.refundedQuantity).toBe(2);
    expect(refreshed?.refundedAmount).toBe(200);
    const untouched = await TicketSale.findById(cleanSale._id).lean();
    expect(untouched?.refundedQuantity).toBe(0);
    expect(untouched?.refundedAmount).toBe(0);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const sale = await saleDoc(2, 200);
    await ticketDoc(sale._id, 100, TicketStatus.REFUNDED);

    await backfillSaleRefunds();
    const second = await backfillSaleRefunds();

    expect(second).toEqual({ salesUpdated: 0, refundedTickets: 1 });
  });

  it('corrects a counter that drifted from the tickets', async () => {
    const sale = await saleDoc(2, 200);
    await ticketDoc(sale._id, 100, TicketStatus.REFUNDED);
    await ticketDoc(sale._id, 100, TicketStatus.REFUNDED);
    await TicketSale.updateOne({ _id: sale._id }, { $set: { refundedQuantity: 1, refundedAmount: 100 } });

    const result = await backfillSaleRefunds();

    expect(result.salesUpdated).toBe(1);
    const refreshed = await TicketSale.findById(sale._id).lean();
    expect(refreshed?.refundedQuantity).toBe(2);
    expect(refreshed?.refundedAmount).toBe(200);
  });
});
