import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { AnalyticsService } from '../analytics.service';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus, TicketStatus, SalesChannel } from '@interfaces/ticket.interface';

const vendorId = new mongoose.Types.ObjectId();
const resellerId = new mongoose.Types.ObjectId();

async function saleDoc(eventId: any, over: Partial<any>) {
  return TicketSale.create({
    eventId, vendorId, ticketIds: [], quantity: 1,
    customerName: 'B', customerPhone: '+26878422613',
    totalAmount: 100, amountCharged: 100,
    paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED,
    soldBy: vendorId, soldByType: 'Vendor', channel: SalesChannel.ONLINE,
    faceAmount: 100, platformFeeAmount: 0, organizerProceeds: 100, resellerCommission: 0,
    fundsCustody: 'carrot', soldAt: new Date(),
    ...over,
  });
}

async function ticketDoc(eventId: any, ticketType: string, price: number) {
  return Ticket.create({
    eventId, vendorId, ticketId: 'T' + Math.random().toString(36).slice(2, 10),
    customerPhone: '+26878422613', customerName: 'B', ticketType, price, status: TicketStatus.SOLD,
  });
}

describe('getEventAnalytics — organizer revenue excludes allocation, seats still count', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('reports organizer revenue without the allocation sale, but counts both seats', async () => {
    const event = await Event.create({
      vendorId, name: 'Farmers Market', venue: 'V',
      eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
      status: EventStatus.PUBLISHED,
      ticketTypes: [
        { name: 'General', price: 100, quantity: 50 },
        { name: 'General Ticket - DeltaPay Exclusive', price: 260, quantity: 100,
          resellerId, isAllocation: true, restrictToMethod: PaymentMethod.DELTAPAY },
      ],
    });
    const eventId = event._id;

    // One ordinary sale (E100) and one allocation sale (E260, DeltaPay, isAllocation).
    await saleDoc(eventId, { totalAmount: 100, amountCharged: 100 });
    await saleDoc(eventId, {
      totalAmount: 260, amountCharged: 260, paymentMethod: PaymentMethod.DELTAPAY,
      resellerId, isAllocation: true, organizerProceeds: 0,
    });
    // Two minted tickets — both are real attendees.
    await ticketDoc(eventId, 'General', 100);
    await ticketDoc(eventId, 'General Ticket - DeltaPay Exclusive', 260);

    const res = await AnalyticsService.getEventAnalytics(eventId.toString(), vendorId.toString());

    expect(res.sales.totalRevenue).toBe(100); // E260 allocation excluded
    expect(res.sales.ticketsSold).toBe(2);     // both seats counted
    expect(res.sales.totalSales).toBe(2);      // both completed sales counted
  });
});
