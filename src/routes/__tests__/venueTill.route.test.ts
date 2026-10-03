import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockCount } from '@models/stockCount.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockTransfer } from '@models/stockTransfer.model';
import { ProductCategory } from '@interfaces/stock.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 950001;

async function venueTill() {
  const vendor = await Vendor.create({ businessName: 'Kwa-Linda', email: `till${seq}@x.co`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name: 'Kwa-Linda Lounge', currency: 'SZL', activatedBy: 'admin' });
  const stall = await Merchant.create({ name: 'Main Bar', venueId: venue._id });
  await Merchant.create({ name: 'Store Room', venueId: venue._id });
  const loginCode = String(seq++);
  await MerchantOperator.create({
    fullName: 'Nomsa', merchantId: stall._id, venueId: venue._id, loginCode, pin: '111111',
    grants: [OperatorGrant.MANAGE_STOCK],
  });
  const product = await Product.create({
    venueId: venue._id, name: 'Castle Lite 330ml', category: ProductCategory.BEER, price: 2500, unitsPerPack: 24, packLabel: 'case',
  });
  await ProductStock.create({ venueId: venue._id, merchantId: stall._id, productId: product._id, onHand: 10 });
  const login = await request(app).post('/api/operator/login').send({ loginCode, pin: '111111' });
  return { venue, stall, product, loginCode, login, auth: `Bearer ${login.body.data?.accessToken}` };
}

describe('venue till', () => {
  it('signs in carrying the venue, not an event', async () => {
    const t = await venueTill();
    expect(t.login.status).toBe(200);
    expect(t.login.body.data.type).toBe('merchant');
    expect(t.login.body.data.operator).toMatchObject({ venueId: String(t.venue._id), venueName: 'Kwa-Linda Lounge' });
    expect(t.login.body.data.operator.eventId).toBeUndefined();
    const decoded = jwt.verify(t.login.body.data.accessToken, JWT_SECRET) as Record<string, unknown>;
    expect(decoded['venueId']).toBe(String(t.venue._id));
    expect(decoded['eventId']).toBeUndefined();
  });

  it('sees its stall stock and counts it; the count is venue-owned', async () => {
    const t = await venueTill();
    const stock = await request(app).get('/api/merchant/stock').set('Authorization', t.auth);
    expect(stock.status).toBe(200);
    expect(JSON.stringify(stock.body.data)).toContain('Castle Lite 330ml');
    const count = await request(app).post('/api/merchant/stock/count').set('Authorization', t.auth)
      .send({ productId: String(t.product._id), countedOnHand: 8 });
    expect(count.status).toBe(200);
    expect(count.body.data).toMatchObject({ expectedOnHand: 10, countedOnHand: 8, variance: -2 });
    expect(String((await StockCount.findOne({ merchantId: t.stall._id }).lean())?.venueId)).toBe(String(t.venue._id));
  });

  it('receives a case into its stall and lists only its venue stalls', async () => {
    const t = await venueTill();
    const rec = await request(app).post('/api/merchant/stock/receive').set('Authorization', t.auth)
      .send({ productId: String(t.product._id), quantity: 1, unit: 'pack' });
    expect(rec.status).toBe(200);
    expect(String((await StockMovement.findOne({ merchantId: t.stall._id }).lean())?.venueId)).toBe(String(t.venue._id));
    await Merchant.create({ name: 'Other Venue Bar', venueId: (await Venue.create({ vendorId: (await Vendor.create({ businessName: 'X', email: 'x@x.co', password: 'secret1' }))._id, name: 'X', currency: 'ZAR', activatedBy: 'admin' }))._id });
    const stalls = await request(app).get('/api/merchant/stalls').set('Authorization', t.auth);
    expect(stalls.status).toBe(200);
    expect(JSON.stringify(stalls.body.data)).toContain('Store Room');
    expect(JSON.stringify(stalls.body.data)).not.toContain('Other Venue Bar');
  });

  it("refuses another venue's product", async () => {
    const t = await venueTill();
    const other = await Product.create({ venueId: (await Venue.create({ vendorId: (await Vendor.create({ businessName: 'Y', email: 'y@y.co', password: 'secret1' }))._id, name: 'Y', currency: 'ZAR', activatedBy: 'admin' }))._id, name: 'Coke', category: ProductCategory.SOFT_DRINK, price: 1500 });
    const res = await request(app).post('/api/merchant/stock/count').set('Authorization', t.auth)
      .send({ productId: String(other._id), countedOnHand: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('product does not belong to this venue');
  });

  describe('tenant boundaries: a refusal writes nothing', () => {
    type Till = Awaited<ReturnType<typeof venueTill>>;
    const otherVenueStall = async () => {
      const vendor = await Vendor.create({ businessName: 'Other', email: `other${seq++}@x.co`, password: 'secret1', businessType: 'venue' });
      const venue = await Venue.create({ vendorId: vendor._id, name: 'Other Lounge', currency: 'SZL', activatedBy: 'admin' });
      return Merchant.create({ name: 'Other Venue Bar', venueId: venue._id });
    };
    const eventStall = () => Merchant.create({ name: 'Event Bar', eventId: new mongoose.Types.ObjectId() });
    const eventProduct = () => Product.create({ eventId: new mongoose.Types.ObjectId(), name: 'Event Beer', category: ProductCategory.BEER, price: 2000 });

    /** The till's own stall still holds its 10, and no stock record of any kind was added. */
    async function expectNothingWritten(t: Till) {
      expect(await StockTransfer.countDocuments({})).toBe(0);
      expect(await StockMovement.countDocuments({})).toBe(0);
      expect(await StockCount.countDocuments({})).toBe(0);
      expect(await ProductStock.countDocuments({})).toBe(1);
      expect((await ProductStock.findOne({ merchantId: t.stall._id, productId: t.product._id }).lean())?.onHand).toBe(10);
    }

    async function transferTo(t: Till, toMerchantId: unknown) {
      return request(app).post('/api/merchant/stock/transfer').set('Authorization', t.auth)
        .send({ productId: String(t.product._id), toMerchantId: String(toMerchantId), quantity: 2 });
    }

    it("refuses a transfer to another venue's stall", async () => {
      const t = await venueTill();
      const res = await transferTo(t, (await otherVenueStall())._id);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('destination stall is not an active stall at this venue');
      await expectNothingWritten(t);
    });

    it('refuses a transfer to an event stall', async () => {
      const t = await venueTill();
      const res = await transferTo(t, (await eventStall())._id);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('destination stall is not an active stall at this venue');
      await expectNothingWritten(t);
    });

    it('refuses to count an event product', async () => {
      const t = await venueTill();
      const res = await request(app).post('/api/merchant/stock/count').set('Authorization', t.auth)
        .send({ productId: String((await eventProduct())._id), countedOnHand: 3 });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('product does not belong to this venue');
      await expectNothingWritten(t);
    });

    it('refuses to write off an event product', async () => {
      const t = await venueTill();
      const res = await request(app).post('/api/merchant/stock/waste').set('Authorization', t.auth)
        .send({ productId: String((await eventProduct())._id), quantity: 1 });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('product does not belong to this venue');
      await expectNothingWritten(t);
    });
  });

  it('refuses tag charges and table service at a venue till', async () => {
    const t = await venueTill();
    const charge = await request(app).post('/api/merchant/charge').set('Authorization', t.auth)
      .send({ bandUid: '04A1B2C3', amount: 2500, clientTxnId: 'x1' });
    expect(charge.status).toBe(403);
    expect(charge.body.message).toBe("Tag payments aren't used at venues");
    const tables = await request(app).get('/api/merchant/tables').set('Authorization', t.auth);
    expect(tables.status).toBe(403);
    expect(tables.body.message).toBe('Venue table service is not available yet');
  });

  it('a suspended venue refuses sign-in and every request from an issued token', async () => {
    const t = await venueTill();
    await Venue.updateOne({ _id: t.venue._id }, { $set: { status: 'suspended' } });
    const again = await request(app).post('/api/operator/login').send({ loginCode: t.loginCode, pin: '111111' });
    expect(again.status).toBe(401);
    expect(again.body.message).toBe('Venue trading is suspended');
    const stock = await request(app).get('/api/merchant/stock').set('Authorization', t.auth);
    expect(stock.status).toBe(401);
    expect(stock.body.message).toBe('Venue trading is suspended');
  });
});
