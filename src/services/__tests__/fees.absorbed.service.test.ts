/**
 * Fees reporting when the ORGANIZER covers the booking fee. The money still
 * belongs to Carrot — only the payer changed — so it must appear in the Fees
 * page take. Reported on its own line rather than merged into bookingFees so
 * "what buyers paid us" stays distinct from "what organizers owe us".
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FeesService } from '@services/fees.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

let mongod: MongoMemoryServer;
const event = new mongoose.Types.ObjectId();
const vendor = new mongoose.Types.ObjectId();
const SOLD = new Date('2026-08-01T00:00:00Z');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await mongoose.connection.collection('events').insertOne({ _id: event, name: 'Absorbed Fest', vendorId: vendor });
  const base = {
    vendorId: vendor, ticketIds: [], soldBy: vendor, soldByType: 'Vendor', eventId: event,
    paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE, soldAt: SOLD,
  };
  await mongoose.connection.collection('ticketsales').insertMany([
    // Organizer absorbed E10 across 2 tickets; buyer paid face, so serviceFeeAmount is 0.
    { ...base, saleId: 'S-1', paymentMethod: PaymentMethod.MTN_MOMO, quantity: 2, totalAmount: 200, serviceFeeAmount: 0, absorbedServiceFeeAmount: 10, platformFeeAmount: 0 },
    // An ordinary buyer-paid sale on the same event, for contrast.
    { ...base, saleId: 'S-2', paymentMethod: PaymentMethod.PEACH_CARD, quantity: 1, totalAmount: 100, serviceFeeAmount: 10, absorbedServiceFeeAmount: 0, platformFeeAmount: 5 },
  ]);
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

describe('FeesService.getFeesByEvent — organizer-absorbed fees', () => {
  it('reports absorbed fees separately from buyer-paid booking fees', async () => {
    const { events } = await FeesService.getFeesByEvent({});
    const row = events[0]!;
    expect(row.bookingFees).toBe(10);   // buyer-paid, card sale only
    expect(row.absorbedFees).toBe(10);  // organizer-paid, momo sale only
  });

  it('counts absorbed fees as Carrot revenue in the event total', async () => {
    const { events } = await FeesService.getFeesByEvent({});
    // 10 booking + 10 absorbed + 5 platform
    expect(events[0]!.totalFees).toBe(25);
  });

  it('attributes the absorbed fee to the method the buyer actually used', async () => {
    const { events } = await FeesService.getFeesByEvent({});
    const momo = events[0]!.byMethod.find(m => m.method === PaymentMethod.MTN_MOMO)!;
    expect(momo.absorbedFees).toBe(10);
    expect(momo.bookingFees).toBe(0);
  });

  it('rolls absorbed fees into the grand totals', async () => {
    const { totals } = await FeesService.getFeesByEvent({});
    expect(totals.absorbedFees).toBe(10);
    expect(totals.totalFees).toBe(25);
  });
});
