import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Request, Response } from 'express';
import { AdminFeesController } from '@controllers/adminFees.controller';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

let mongod: MongoMemoryServer;
const eventA = new mongoose.Types.ObjectId();
const vendor = new mongoose.Types.ObjectId();

function mockRes() {
  const res: Partial<Response> & { body?: any; code?: number } = {};
  // ApiResponseUtil reads res.req.originalUrl for the response `path` field.
  res.req = { originalUrl: '/api/tickets/admin/fees' } as any;
  res.status = ((c: number) => { res.code = c; return res; }) as any;
  res.json = ((b: any) => { res.body = b; return res; }) as any;
  return res as Response & { body: any; code?: number };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await mongoose.connection.collection('events').insertOne({ _id: eventA, name: 'Alpha Fest', vendorId: vendor });
  await mongoose.connection.collection('ticketsales').insertOne({
    saleId: 'SALE-CTRL-0',
    eventId: eventA, vendorId: vendor, ticketIds: [], soldBy: vendor, soldByType: 'Vendor',
    paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED, channel: SalesChannel.ONLINE,
    quantity: 2, totalAmount: 200, serviceFeeAmount: 10, platformFeeAmount: 20, soldAt: new Date(),
  });
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

it('returns the fees payload wrapped in the success envelope', async () => {
  const req = { query: {} } as unknown as Request;
  const res = mockRes();
  await AdminFeesController.getFees(req, res);
  expect(res.body.success).toBe(true);
  expect(res.body.data.events).toHaveLength(1);
  expect(res.body.data.events[0].totalFees).toBe(30);
  expect(res.body.data.totals.totalFees).toBe(30);
  expect(res.body.data.pagination).toMatchObject({ page: 1, total: 1 });
});

it('passes eventId + date query params through to the service', async () => {
  const req = { query: { eventId: eventA.toString(), startDate: '2020-01-01', page: '1', limit: '25' } } as unknown as Request;
  const res = mockRes();
  await AdminFeesController.getFees(req, res);
  expect(res.body.data.events).toHaveLength(1);
  expect(res.body.data.events[0].eventId).toBe(eventA.toString());
});
