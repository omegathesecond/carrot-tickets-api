import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FeesService } from '@services/fees.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

let mongod: MongoMemoryServer;

const eventA = new mongoose.Types.ObjectId();
const eventB = new mongoose.Types.ObjectId();
const vendor = new mongoose.Types.ObjectId();
const OLD = new Date('2026-01-01T00:00:00Z');
const NEW = new Date('2026-08-01T00:00:00Z');

// Insert straight into the collections so we bypass schema-required fields and
// the saleId pre-save hook — this test only cares about the fee/aggregation math.
async function seed() {
  await mongoose.connection.collection('events').insertMany([
    { _id: eventA, name: 'Alpha Fest', vendorId: vendor },
    { _id: eventB, name: 'Beta Bash', vendorId: vendor },
  ]);
  const base = { vendorId: vendor, ticketIds: [], soldBy: vendor, soldByType: 'Vendor' };
  const rows = [
    // Event A — counts
    { ...base, eventId: eventA, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE, quantity: 2, totalAmount: 200, serviceFeeAmount: 10, platformFeeAmount: 20, soldAt: NEW },
    { ...base, eventId: eventA, paymentMethod: PaymentMethod.PEACH_CARD, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE, quantity: 1, totalAmount: 100, serviceFeeAmount: 10, platformFeeAmount: 10, soldAt: NEW },
    { ...base, eventId: eventA, paymentMethod: PaymentMethod.CASH, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.BOX_OFFICE, quantity: 3, totalAmount: 300, serviceFeeAmount: 0, platformFeeAmount: 30, soldAt: NEW },
    // Event B — counts (older date, for the date-filter test)
    { ...base, eventId: eventB, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE, quantity: 1, totalAmount: 100, serviceFeeAmount: 5, platformFeeAmount: 10, soldAt: OLD },
    // Excluded — refunded + pending
    { ...base, eventId: eventB, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.REFUNDED, channel: SalesChannel.ONLINE, quantity: 1, totalAmount: 100, serviceFeeAmount: 5, platformFeeAmount: 10, soldAt: NEW },
    { ...base, eventId: eventA, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.PENDING, channel: SalesChannel.ONLINE, quantity: 1, totalAmount: 100, serviceFeeAmount: 5, platformFeeAmount: 10, soldAt: NEW },
  ].map((r, i) => ({ ...r, saleId: `SALE-TEST-${i}` }));   // unique saleId — collection has a unique index
  await mongoose.connection.collection('ticketsales').insertMany(rows);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seed();
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('FeesService.getFeesByEvent', () => {
  it('sums booking + platform fees per event, highest total first', async () => {
    const res = await FeesService.getFeesByEvent({});
    expect(res.events).toHaveLength(2);

    const a = res.events[0]!;
    expect(a.eventId).toBe(eventA.toString());
    expect(a.eventName).toBe('Alpha Fest');
    expect(a.bookingFees).toBe(20);
    expect(a.platformFees).toBe(60);
    expect(a.totalFees).toBe(80);
    expect(a.faceValue).toBe(600);
    expect(a.ticketsSold).toBe(6);

    const b = res.events[1]!;
    expect(b.eventId).toBe(eventB.toString());
    expect(b.totalFees).toBe(15);
  });

  it('breaks each event down by payment method', async () => {
    const res = await FeesService.getFeesByEvent({});
    const a = res.events.find((e) => e.eventId === eventA.toString())!;
    const momo = a.byMethod.find((m) => m.method === PaymentMethod.MTN_MOMO)!;
    expect(momo).toMatchObject({ bookingFees: 10, platformFees: 20, totalFees: 30, ticketsSold: 2 });
    const cash = a.byMethod.find((m) => m.method === PaymentMethod.CASH)!;
    expect(cash).toMatchObject({ bookingFees: 0, platformFees: 30, totalFees: 30, ticketsSold: 3 });
    expect(a.byMethod).toHaveLength(3);
  });

  it('excludes refunded and pending sales from the totals', async () => {
    const res = await FeesService.getFeesByEvent({});
    expect(res.totals).toMatchObject({
      eventCount: 2, ticketsSold: 7, faceValue: 700,
      bookingFees: 25, platformFees: 70, totalFees: 95,
    });
  });

  it('filters to a single event via eventId', async () => {
    const res = await FeesService.getFeesByEvent({ eventId: eventB.toString() });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.eventId).toBe(eventB.toString());
    expect(res.totals.eventCount).toBe(1);
    expect(res.totals.totalFees).toBe(15);
  });

  it('bounds by soldAt date range', async () => {
    const res = await FeesService.getFeesByEvent({ startDate: new Date('2026-06-01T00:00:00Z') });
    expect(res.events).toHaveLength(1);            // only Event A (NEW), Event B is OLD
    expect(res.events[0]!.eventId).toBe(eventA.toString());
  });

  it('filters by event name search', async () => {
    const res = await FeesService.getFeesByEvent({ search: 'beta' });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.eventName).toBe('Beta Bash');
  });
});
