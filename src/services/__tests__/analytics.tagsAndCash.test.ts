import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { AnalyticsService } from '../analytics.service';
import { TicketService } from '../ticket.service';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus, TicketStatus, SalesChannel } from '@interfaces/ticket.interface';

const vendorId = new mongoose.Types.ObjectId();

async function saleDoc(eventId: any, over: Partial<any>) {
  return TicketSale.create({
    eventId, vendorId, ticketIds: [], quantity: 1,
    customerName: 'B', customerPhone: '+26878422613',
    totalAmount: 100, amountCharged: 100,
    paymentMethod: PaymentMethod.CASH, paymentStatus: PaymentStatus.COMPLETED,
    soldBy: vendorId, soldByType: 'Vendor', channel: SalesChannel.BOX_OFFICE,
    faceAmount: 100, platformFeeAmount: 0, organizerProceeds: 100, resellerCommission: 0,
    fundsCustody: 'carrot', soldAt: new Date(),
    ...over,
  });
}

async function ticketDoc(eventId: any, ticketType: string, price: number, saleId?: any) {
  return Ticket.create({
    eventId, vendorId, ticketId: 'T' + Math.random().toString(36).slice(2, 10),
    customerPhone: '+26878422613', customerName: 'B', ticketType, price, status: TicketStatus.SOLD,
    ...(saleId ? { saleId } : {}),
  });
}

describe('getEventAnalytics — printed tags are reported separately from ticket sales, cash sales value is surfaced', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('excludes wristband batches from ticketsSold/totalSales and reports tagsPrinted + cashSales', async () => {
    const event = await Event.create({
      vendorId, name: 'Piano Republic Showcase', venue: 'V',
      eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
      status: EventStatus.PUBLISHED,
      ticketTypes: [
        { name: 'General', price: 100, quantity: 50 },
      ],
    });
    const eventId = event._id;
    const ticketTypeId = event.ticketTypes[0]?._id?.toString() ?? '';

    // One real cash sale (E100) and one real card sale (E150).
    const cashSale = await saleDoc(eventId, { totalAmount: 100, amountCharged: 100, paymentMethod: PaymentMethod.CASH });
    const cardSale = await saleDoc(eventId, { totalAmount: 150, amountCharged: 150, paymentMethod: PaymentMethod.PEACH_CARD, organizerProceeds: 150 });
    await ticketDoc(eventId, 'General', 100, cashSale._id);
    await ticketDoc(eventId, 'General', 150, cardSale._id);

    // A batch of 20 platform-printed wristbands (tags) — zero-amount, not a sale.
    await TicketService.issueWristbandBatch({ eventId: eventId.toString(), ticketTypeId, quantity: 20 });

    const res = await AnalyticsService.getEventAnalytics(eventId.toString(), vendorId.toString());

    expect(res.sales.ticketsSold).toBe(2);      // wristband tickets excluded
    expect(res.sales.totalSales).toBe(2);       // wristband sale excluded
    expect(res.sales.tagsPrinted).toBe(20);     // reported on its own
    expect(res.sales.cashSales).toBe(100);      // only the cash sale, not the card sale or the (zero) wristband amount
    expect(res.sales.totalRevenue).toBe(250);   // real sales revenue unaffected (was already correct)
    expect(res.ticketTypes[0]?.sold).toBe(2);   // per-type breakdown also excludes wristband tags
  });
});

describe('getEventSalesSummary — live figures for the event detail / ticket-config page', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('excludes wristband tags from ticketsSold, keeps checked-in tickets counted as sold, and reports cash sales + per-type breakdown', async () => {
    const event = await Event.create({
      vendorId, name: 'Piano Republic Showcase', venue: 'V',
      eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
      status: EventStatus.PUBLISHED,
      ticketTypes: [
        { name: 'General', price: 100, quantity: 50 },
      ],
    });
    const eventId = event._id;
    const ticketTypeId = event.ticketTypes[0]?._id?.toString() ?? '';

    const cashSale = await saleDoc(eventId, { totalAmount: 100, amountCharged: 100, paymentMethod: PaymentMethod.CASH });
    const cardSale = await saleDoc(eventId, { totalAmount: 150, amountCharged: 150, paymentMethod: PaymentMethod.PEACH_CARD, organizerProceeds: 150 });
    await ticketDoc(eventId, 'General', 100, cashSale._id);
    // This one has already been scanned at the gate — must still count as sold.
    const checkedInTicket = await ticketDoc(eventId, 'General', 150, cardSale._id);
    checkedInTicket.status = TicketStatus.CHECKED_IN;
    await checkedInTicket.save();

    await TicketService.issueWristbandBatch({ eventId: eventId.toString(), ticketTypeId, quantity: 20 });

    const summary = await AnalyticsService.getEventSalesSummary(eventId.toString(), vendorId.toString());

    expect(summary.ticketsSold).toBe(2);
    expect(summary.tagsPrinted).toBe(20);
    expect(summary.cashSales).toBe(100);
    expect(summary.ticketTypes).toEqual([{ name: 'General', sold: 2 }]);
    expect(summary.tagsPrintedByType).toEqual([{ name: 'General', count: 20 }]);
  });
});
