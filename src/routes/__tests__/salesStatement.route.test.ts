import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { signVendorSessionToken, signAdminSessionToken, signStaffSessionToken } from '@/__tests__/helpers/auth';
import { extractPdfText } from '@/__tests__/helpers/pdfText';
import { Vendor } from '@models/vendor.model';
import { TicketSale } from '@models/ticketSale.model';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge } from '@models/merchantCharge.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);
const auth = async (vendorId: string) => {
  if (!await Vendor.exists({ _id: vendorId })) {
    await Vendor.create({ _id: vendorId, businessName: 'Organiser', password: 'secret123' });
  }
  return `Bearer ${await signVendorSessionToken(vendorId)}`;
};

async function sale(eventId: string, vendorId: string, status = 'completed') {
  return TicketSale.create({
    eventId, vendorId, ticketIds: [new mongoose.Types.ObjectId()], quantity: 3, totalAmount: 300,
    refundedQuantity: 1, refundedAmount: 100, soldBy: new mongoose.Types.ObjectId(), soldByType: 'Vendor',
    paymentMethod: 'cash', paymentStatus: status, soldAt: new Date('2026-10-10T10:00:00Z'), customerName: '=SUM(1,2)',
  });
}

it('event CSV includes the full event, net of refunds, and excludes other events and unsuccessful attempts', async () => {
  const event = await seedPublishedEvent();
  const other = await seedPublishedEvent();
  const completed = await sale(event.eventId, event.vendorId);
  const pending = await sale(event.eventId, event.vendorId, 'pending');
  const outside = await sale(other.eventId, other.vendorId);
  const res = await request(app).get(`/api/tickets/events/${event.eventId}/sales-statement`).set('Authorization', await auth(event.vendorId));
  expect(res.status).toBe(200);
  expect(res.headers['content-disposition']).toContain('.csv');
  expect(res.text).toContain('Net Ticket Revenue,200.00');
  expect(res.text).toContain('Refunded Tickets,1');
  expect(res.text).toContain('2026-10-10T10:00:00.000Z');
  expect(res.text).toContain(String(completed.saleId));
  expect(res.text).not.toContain(String(pending.saleId));
  expect(res.text).not.toContain(String(outside.saleId));
  expect(res.text).toContain("'\u003dSUM(1,2)");
});

it('event PDF has the same refund totals and sale details, including for a platform admin', async () => {
  const event = await seedPublishedEvent();
  const completed = await sale(event.eventId, event.vendorId);
  const res = await request(app).get(`/api/tickets/events/${event.eventId}/sales-statement?format=pdf`).set('Authorization', `Bearer ${await signAdminSessionToken()}`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/pdf');
  const text = extractPdfText(res.body);
  expect(text).toContain('Net Ticket Revenue: 200.00');
  expect(text).toContain(String(completed.saleId));
  expect(text).toContain('Page 1 of 1');
  expect(res.body.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
});

async function merchantFixture() {
  const event = await seedPublishedEvent();
  const merchant = await Merchant.create({ name: 'Test Stall', eventId: event.eventId, commissionPercent: 10 });
  const createCharge = (clientTxnId: string, status: 'completed' | 'reversed' = 'completed') => ({
    merchantId: merchant._id, merchantOperatorId: new mongoose.Types.ObjectId(), eventId: event.eventId,
    walletId: new mongoose.Types.ObjectId(), bandUid: '04abcd123456', amount: 1100, purchaseChargeAmount: 100,
    fee: 100, netAmount: 900, clientTxnId, staffName: 'Test Operator', status,
  });
  return { ...event, merchant, createCharge };
}

it('vendor CSV exports beyond the 500-row page cap and excludes reversals from net owed', async () => {
  const f = await merchantFixture();
  const charges = await MerchantCharge.insertMany([
    ...Array.from({ length: 502 }, (_, i) => f.createCharge(`sale-${i}`)), f.createCharge('reversed', 'reversed'),
  ]);
  const otherMerchant = await Merchant.create({ name: 'Other Stall', eventId: f.eventId });
  const outside = await MerchantCharge.create({ ...f.createCharge('outside'), merchantId: otherMerchant._id });
  const res = await request(app).get(`/api/tickets/merchants/${f.merchant._id}/sales-statement`).set('Authorization', await auth(f.vendorId));
  expect(res.status).toBe(200);
  expect(res.text).toContain('Completed Sales,502');
  expect(res.text).toContain('Net Owed,4518.00');
  expect(res.text).toContain('Reversed Sales,1');
  for (const charge of charges) expect(res.text).toContain(String(charge._id));
  expect(res.text).not.toContain(String(outside._id));
});

it('vendor PDF carries the operator and reversal explanation', async () => {
  const f = await merchantFixture();
  await MerchantCharge.create(f.createCharge('completed'));
  await MerchantCharge.create({ ...f.createCharge('reversed', 'reversed'), reversal: {
    by: new mongoose.Types.ObjectId(), staffName: 'Test Operator', reason: 'Duplicate purchase',
    at: new Date(), restocked: false, ledgerTxnId: 'reverse-1',
  } });
  const res = await request(app).get(`/api/tickets/merchants/${f.merchant._id}/sales-statement?format=pdf`).set('Authorization', await auth(f.vendorId));
  expect(res.status).toBe(200);
  const text = extractPdfText(res.body);
  expect(text).toContain('Net Owed: 9.00');
  expect(text).toContain('Test Operator');
  expect(text).toContain('Duplicate purchase');
});

it('requires authentication, export permission, event ownership and a valid format for both downloads', async () => {
  const f = await merchantFixture();
  const outside = await seedPublishedEvent();
  await auth(f.vendorId);
  for (const endpoint of [`events/${f.eventId}`, `merchants/${f.merchant._id}`]) {
    const path = `/api/tickets/${endpoint}/sales-statement`;
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path).set('Authorization', `Bearer ${await signStaffSessionToken(f.vendorId, [])}`)).status).toBe(403);
    expect((await request(app).get(path).set('Authorization', await auth(outside.vendorId))).status).toBe(403);
    expect((await request(app).get(`${path}?format=exe`).set('Authorization', await auth(f.vendorId))).status).toBe(400);
  }
  expect((await request(app).get('/api/tickets/events/invalid/sales-statement').set('Authorization', await auth(f.vendorId))).status).toBe(400);
});

it('empty statements preserve zero totals', async () => {
  const f = await merchantFixture();
  const res = await request(app).get(`/api/tickets/merchants/${f.merchant._id}/sales-statement`).set('Authorization', await auth(f.vendorId));
  expect(res.status).toBe(200);
  expect(res.text).toContain('Completed Sales,0');
  expect(res.text).toContain('Net Owed,0.00');
});
