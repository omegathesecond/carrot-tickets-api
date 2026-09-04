import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { AnalyticsService } from '../analytics.service';
import { TicketService } from '../ticket.service';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus, TicketStatus, SalesChannel } from '@interfaces/ticket.interface';

const vendorId = new mongoose.Types.ObjectId();
const resellerId = new mongoose.Types.ObjectId();
const hubId = new mongoose.Types.ObjectId();

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

async function ticketDoc(eventId: any, price: number, saleId: any) {
  return Ticket.create({
    eventId, vendorId, ticketId: 'T' + Math.random().toString(36).slice(2, 10),
    customerPhone: '+26878422613', customerName: 'B', ticketType: 'General', price, status: TicketStatus.SOLD,
    saleId,
  });
}

/**
 * Gross: 10 cash tickets (E1000) + 1 card ticket (E150) + 2 wallet-paid
 * reseller-POS tickets (E200) = 13 tickets, E1350, plus 20 printed wristbands
 * (never a sale — excluded from every figure but tagsPrinted).
 * Then 3 cash refunds and 1 reseller-POS refund through the real refund path.
 * Net: 9 tickets, E950 — cash E700, card E150, reseller-POS E100.
 */
async function seedRefundScenario() {
  const event = await Event.create({
    vendorId, name: 'Piano Republic Showcase', venue: 'V',
    eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 50, sold: 13 }],
    totalRevenue: 1350,
  });
  const eventId = event._id;
  const ticketTypeId = event.ticketTypes[0]?._id?.toString() ?? '';

  const cashSale = await saleDoc(eventId, { quantity: 10, totalAmount: 1000, amountCharged: 1000, faceAmount: 1000, organizerProceeds: 1000 });
  const cardSale = await saleDoc(eventId, { totalAmount: 150, amountCharged: 150, faceAmount: 150, organizerProceeds: 150, paymentMethod: PaymentMethod.PEACH_CARD });
  const posSale = await saleDoc(eventId, { quantity: 2, totalAmount: 200, amountCharged: 200, faceAmount: 200, organizerProceeds: 200, channel: SalesChannel.RESELLER_POS, paymentMethod: PaymentMethod.KESHLESS_WALLET, resellerId, hubId });

  const cashTickets = [];
  for (let i = 0; i < 10; i++) cashTickets.push(await ticketDoc(eventId, 100, cashSale._id));
  await ticketDoc(eventId, 150, cardSale._id);
  const posTickets = [await ticketDoc(eventId, 100, posSale._id), await ticketDoc(eventId, 100, posSale._id)];

  await TicketService.issueWristbandBatch({ eventId: eventId.toString(), ticketTypeId, quantity: 20 });

  for (const t of cashTickets.slice(0, 3)) await TicketService.refundTicket(t.ticketId, vendorId.toString(), 'changed plans');
  await TicketService.refundTicket(posTickets[0]!.ticketId, vendorId.toString(), 'changed plans');

  return { eventId, cashSale, cardSale, posSale };
}

describe('refunds are recorded on the parent sale', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('refundTicket increments refundedQuantity/refundedAmount on the sale it came from, and only that sale', async () => {
    const { cashSale, cardSale, posSale } = await seedRefundScenario();

    const cash = await TicketSale.findById(cashSale._id);
    const card = await TicketSale.findById(cardSale._id);
    const pos = await TicketSale.findById(posSale._id);

    expect(cash?.refundedQuantity).toBe(3);
    expect(cash?.refundedAmount).toBe(300);
    expect(pos?.refundedQuantity).toBe(1);
    expect(pos?.refundedAmount).toBe(100);
    expect(card?.refundedQuantity).toBe(0);
    expect(card?.refundedAmount).toBe(0);
    // The sale itself stays COMPLETED — the money that was collected was collected.
    expect(cash?.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });
});

describe('vendor-wide stats exclude refunded tickets', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('getDashboardStats reports net revenue, net tickets sold and net cash revenue', async () => {
    await seedRefundScenario();
    const stats = await AnalyticsService.getDashboardStats({ vendorId: vendorId.toString() });

    expect(stats.totalRevenue).toBe(950);
    expect(stats.ticketsSold).toBe(9);
    expect(stats.tickets.totalRevenue).toBe(950);
    expect(stats.sales.cashRevenue).toBe(700);
    expect(stats.sales.cashSales).toBe(1);   // still one cash SALE — counts are sale counts
  });

  it('getSalesStats reports net totals, net per-method revenue and net per-event figures', async () => {
    const { eventId } = await seedRefundScenario();
    const stats = await AnalyticsService.getSalesStats({ vendorId: vendorId.toString() });

    expect(stats.totalRevenue).toBe(950);
    expect(stats.ticketsSold).toBe(9);
    expect(stats.totalSales).toBe(3);
    expect(stats.salesByPaymentMethod.cash).toEqual({ count: 1, revenue: 700 });
    expect(stats.salesByEvent).toEqual([{ eventId: eventId.toString(), eventName: 'Piano Republic Showcase', ticketsSold: 9, revenue: 950 }]);
  });

  it('getRevenueStats reports net figures in every breakdown — period, event, method, channel and reseller source', async () => {
    const { eventId } = await seedRefundScenario();
    const stats = await AnalyticsService.getRevenueStats({ vendorId: vendorId.toString() });

    expect(stats.totalRevenue).toBe(950);
    expect(stats.ticketsSold).toBe(9);
    expect(stats.dailyRevenue).toHaveLength(1);
    expect(stats.dailyRevenue?.[0]).toMatchObject({ revenue: 950, ticketsSold: 9 });
    expect(stats.revenueByEvent).toEqual([{ eventId: eventId.toString(), eventName: 'Piano Republic Showcase', revenue: 950, ticketsSold: 9 }]);
    expect(stats.revenueByPaymentMethod.find(m => m.method === PaymentMethod.CASH)).toEqual({ method: PaymentMethod.CASH, amount: 700, count: 1 });
    expect(stats.revenueByChannel).toEqual([
      { channel: SalesChannel.BOX_OFFICE, amount: 850, count: 2 },
      { channel: SalesChannel.RESELLER_POS, amount: 100, count: 1 },
    ]);
    expect(stats.topResellerSources).toEqual([{ resellerName: 'Unknown reseller', hubName: 'Unknown hub', amount: 100, count: 1 }]);
  });
});

describe('per-ticket-type revenue excludes refunded tickets', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('getEventAnalytics.ticketTypes[].revenue only counts tickets still held, and agrees with sales.totalRevenue', async () => {
    const { eventId } = await seedRefundScenario();
    const res = await AnalyticsService.getEventAnalytics(eventId.toString(), vendorId.toString());

    expect(res.ticketTypes).toEqual([expect.objectContaining({ name: 'General', sold: 9, revenue: 950 })]);
    expect(res.sales.totalRevenue).toBe(950);
    expect(res.sales.cashSales).toBe(700);
    expect(res.sales.ticketsSold).toBe(9);
    expect(res.sales.tagsPrinted).toBe(20);
  });
});
