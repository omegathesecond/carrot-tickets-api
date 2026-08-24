import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Request, Response } from 'express';
import { TicketsController } from '@controllers/tickets.controller';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

let mongod: MongoMemoryServer;
const event = new mongoose.Types.ObjectId();
const vendor = new mongoose.Types.ObjectId();
const otherVendor = new mongoose.Types.ObjectId();

function mockRes() {
  const res: Partial<Response> & { body?: any; code?: number } = {};
  // ApiResponseUtil reads res.req.originalUrl for the response `path` field.
  res.req = { originalUrl: `/api/tickets/stats/events/${event}/financials` } as any;
  res.status = ((c: number) => { res.code = c; return res; }) as any;
  res.json = ((b: any) => { res.body = b; return res; }) as any;
  return res as Response & { body: any; code?: number };
}

function reqAs(v: mongoose.Types.ObjectId, isSuperAdmin = false) {
  return {
    params: { eventId: event.toString() },
    ticketsUser: { vendorId: v.toString(), isSuperAdmin },
  } as unknown as Request;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await mongoose.connection
    .collection('events')
    .insertOne({ _id: event, name: 'Piano Republic : Marked Money', vendorId: vendor, currency: 'SZL' });
  await mongoose.connection.collection('ticketsales').insertOne({
    saleId: 'SALE-FIN-0',
    eventId: event, vendorId: vendor, ticketIds: [], soldBy: vendor, soldByType: 'Vendor',
    paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED,
    channel: SalesChannel.ONLINE, quantity: 40, totalAmount: 7490,
    serviceFeeAmount: 320, organizerProceeds: 7490, fundsCustody: 'carrot', soldAt: new Date(),
  });
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

it('returns the financials payload wrapped in the success envelope', async () => {
  const res = mockRes();
  await TicketsController.getEventFinancials(reqAs(vendor), res);

  expect(res.body.success).toBe(true);
  expect(res.body.data.currency).toBe('SZL');
  expect(res.body.data.byMethod).toEqual([
    expect.objectContaining({ method: 'mtn_momo', face: 7490, bookingFee: 320, charged: 7810 }),
  ]);
  expect(res.body.data.custody.withCarrot).toBe(7490);
});

it("answers 404, not 500, for an event the caller's vendor does not own", async () => {
  const res = mockRes();
  await TicketsController.getEventFinancials(reqAs(otherVendor), res);

  expect(res.code).toBe(404);
  expect(res.body.success).toBe(false);
});

it('lets a super-admin read any event', async () => {
  const res = mockRes();
  await TicketsController.getEventFinancials(reqAs(otherVendor, true), res);

  expect(res.body.success).toBe(true);
  expect(res.body.data.totals.face).toBe(7490);
});
