import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { addVenueProduct, lowStockNotices, seedVenue, seedVenueStall, seedVenueTill, seedVenueWaiter, setLowStockThreshold } from '@/__tests__/helpers/venueFloor';
import { EVENT, seedStall } from '@/__tests__/helpers/tables';
import { MerchantCharge } from '@models/merchantCharge.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { Venue } from '@models/venue.model';
import { VenuePayment } from '@models/venuePayment.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockService } from '@services/stock.service';
import { VenueSaleService } from '@services/venueSale.service';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { MAX_CHARGE_CENTS } from '@services/merchant.service';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function counter() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const wine = await addVenueProduct(venue.venueId, bar.merchantId, { name: 'Wine', price: 4000, onHand: 1 });
  const till = await seedVenueTill(venue, bar.merchantId, { fullName: 'Nomsa' });
  const sell = (body: unknown, auth = till.auth) => request(app).post('/api/merchant/sales').set('Authorization', auth).send(body as object);
  return { venue, bar, wine, till, sell };
}
const onHand = (merchantId: string, productId: string) => StockService.getOnHand(merchantId, productId);

/** What a sale writes: a charge, a payment and a sale movement per line. */
const written = async () => ({
  charges: await MerchantCharge.countDocuments(),
  payments: await VenuePayment.countDocuments(),
  sales: await StockMovement.countDocuments({ reason: 'sale' }),
});
const NOTHING = { charges: 0, payments: 0, sales: 0 };

/** A waiter takes a table for one beer and pays it in full under `clientTxnId`: a payment AND the stall's `<id>:<merchantId>` charge. */
async function tablePaid(c: Awaited<ReturnType<typeof counter>>, clientTxnId: string) {
  const waiter = await seedVenueWaiter(c.venue);
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  await request(app).post(`/api/waiter/tables/${tableId}/orders`).set('Authorization', waiter.auth)
    .send({ clientTxnId: 'r1', items: [{ merchantId: c.bar.merchantId, productId: c.bar.productId, qty: 1 }] });
  const paid = await request(app).post(`/api/waiter/tables/${tableId}/payments`).set('Authorization', waiter.auth)
    .send({ clientTxnId, tenders: [{ method: 'cash', amount: 2500 }] });
  expect(paid.status).toBe(200);
}
const beer = (c: Awaited<ReturnType<typeof counter>>, qty = 1) => ({ productId: c.bar.productId, qty });
const cashFor = (amount: number) => ({ tenders: [{ method: 'cash', amount }] });
const reasonOf = (res: request.Response) => JSON.parse(res.body.error).reason;

describe('venue counter sale', () => {
  it('sells from the till for cash: stock leaves, the stall is credited, the payment is recorded', async () => {
    const c = await counter();
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 2 }], payment: { tenders: [{ method: 'cash', amount: 5000 }] } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ amount: 5000, tips: 0, payment: { applied: 5000, tips: 0, tenders: [{ method: 'cash', amount: 5000, tip: 0 }] } });
    expect(res.body.data.items).toEqual([expect.objectContaining({ name: 'Castle Lite', qty: 2, unitPrice: 2500, lineTotal: 5000 })]);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(8);

    const charge = (await MerchantCharge.findOne({ clientTxnId: 's1' }).lean())!;
    expect(charge).toMatchObject({ amount: 5000, fee: 0, netAmount: 5000, staffName: 'Nomsa' });
    expect(String(charge.venueId)).toBe(c.venue.venueId);
    expect(String(charge.merchantOperatorId)).toBe(c.till.merchantOperatorId);
    expect(charge.walletId).toBeUndefined();

    const payment = (await VenuePayment.findOne({ clientTxnId: 's1' }).lean())!;
    expect(payment).toMatchObject({ source: 'counter', merchantName: 'Main Bar', applied: 5000, takenBy: c.till.merchantOperatorId, takenByType: 'MerchantOperator', staffName: 'Nomsa' });
    expect(String(payment.merchantChargeId)).toBe(String(charge._id));
    expect(payment.merchantIds.map(String)).toEqual([c.bar.merchantId]);

    const sale = await StockMovement.findOne({ productId: c.bar.productId, reason: 'sale' }).lean();
    expect(sale).toMatchObject({ delta: -2, refType: 'merchant_charge', refId: 's1', byType: 'Merchant', by: c.till.merchantOperatorId });
  });

  it('takes card and cash together, with a tip that is not part of the sale', async () => {
    const c = await counter();
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 3 }], payment: { tenders: [{ method: 'card', amount: 5000, tip: 500, reference: '7731' }, { method: 'cash', amount: 2500 }] } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ amount: 7500, tips: 500 });
    expect((await MerchantCharge.findOne({ clientTxnId: 's1' }).lean())!.amount).toBe(7500);
    expect(await VenuePayment.findOne({ clientTxnId: 's1' }).lean()).toMatchObject({ applied: 7500, tips: 500 });
  });

  it('must be paid in full — no more, no less', async () => {
    const c = await counter();
    for (const amount of [4000, 6000]) {
      const res = await c.sell({ clientTxnId: `s${amount}`, items: [{ productId: c.bar.productId, qty: 2 }], payment: { tenders: [{ method: 'cash', amount }] } });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('the payment must equal the basket total');
      expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'payment_mismatch', total: 5000, applied: amount });
    }
    expect(await written()).toEqual(NOTHING);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(10);
  });

  it('one item out of stock rolls the whole sale back', async () => {
    const c = await counter();
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 1 }, { productId: c.wine, qty: 2 }], payment: { tenders: [{ method: 'cash', amount: 10500 }] } });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Out of stock');
    expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'insufficient_stock', productId: c.wine, available: 1 });
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(10);
    expect(await written()).toEqual(NOTHING);
  });

  it('a retried sale is made once; the same id for a different basket is refused', async () => {
    const c = await counter();
    const body = { clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 2 }], payment: { tenders: [{ method: 'cash', amount: 5000 }] } };
    const first = await c.sell(body);
    const again = await c.sell(body);
    expect(again.status).toBe(200);
    expect(again.body.data.payment.id).toBe(first.body.data.payment.id);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(8);
    expect(await MerchantCharge.countDocuments()).toBe(1);
    const different = await c.sell({ ...body, items: [{ productId: c.bar.productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 2500 }] } });
    expect(different.status).toBe(409);
    expect(JSON.parse(different.body.error)).toMatchObject({ reason: 'idempotency_mismatch' });
  });

  it('an UPPER-CASE product id sells exactly like the lower-case one', async () => {
    const c = await counter();
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.bar.productId.toUpperCase(), qty: 2 }], payment: { tenders: [{ method: 'cash', amount: 5000 }] } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ amount: 5000, tips: 0 });
    expect(res.body.data.items).toEqual([expect.objectContaining({ name: 'Castle Lite', qty: 2, lineTotal: 5000 })]);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(8);
    expect(await StockMovement.countDocuments({ productId: c.bar.productId, reason: 'sale' })).toBe(1);
    expect(await MerchantCharge.countDocuments()).toBe(1);
    expect(await VenuePayment.countDocuments()).toBe(1);
  });

  it('a retry that races its original is answered with the original sale, even when the original took the last unit', async () => {
    const c = await counter();
    const body = { clientTxnId: 's1', items: [{ productId: c.wine, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 4000 }] } };
    const realFind = Product.find.bind(Product) as (...args: unknown[]) => any;
    let fired = false;
    let original: Awaited<ReturnType<typeof VenueSaleService.counterSale>> | undefined;
    // The request's replay pre-read has found nothing. Just before its transaction (its
    // first Product.find), the original commits — selling the last unit of wine.
    const spy = jest.spyOn(Product, 'find').mockImplementation(((...args: unknown[]) => {
      const query = realFind(...args);
      if (fired) return query;
      fired = true;
      const exec = query.exec.bind(query);
      query.exec = async (...a: unknown[]) => {
        original = await VenueSaleService.counterSale({
          venueId: c.venue.venueId, merchantId: c.bar.merchantId, merchantName: 'Main Bar',
          merchantOperatorId: c.till.merchantOperatorId, operatorName: 'Nomsa',
          clientTxnId: 's1', items: [{ productId: c.wine, qty: 1 }], tenders: [{ method: 'cash', amount: 4000 }],
        });
        return exec(...a);
      };
      return query;
    }) as never);
    let res: request.Response;
    try {
      res = await c.sell(body);
      expect(fired).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(original).toBeDefined();
    expect(res.status).toBe(200);
    expect(res.body.data.payment.id).toBe(String(original!.payment._id));
    expect(res.body.data).toMatchObject({ amount: 4000, tips: 0 });
    expect(await MerchantCharge.countDocuments({ clientTxnId: 's1' })).toBe(1);
    expect(await VenuePayment.countDocuments({ clientTxnId: 's1' })).toBe(1);
    expect(await StockMovement.countDocuments({ productId: c.wine, reason: 'sale' })).toBe(1);
    expect(await onHand(c.bar.merchantId, c.wine)).toBe(0);
  });

  it("refuses another venue's or an event's product, and an invalid body", async () => {
    const c = await counter();
    const other = await seedVenueStall((await seedVenue()).venueId, { price: 100, onHand: 5 });
    const eventStall = await seedStall({ price: 100, onHand: 5 });
    for (const productId of [other.productId, eventStall.productId]) {
      const res = await c.sell({ clientTxnId: `x${productId}`, items: [{ productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 100 }] } });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("one or more products are not on this venue's menu");
      expect(reasonOf(res)).toBe('product_not_found');
    }
    for (const body of [
      { items: [{ productId: c.bar.productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 2500 }] } },
      { clientTxnId: 's1', items: [], payment: { tenders: [{ method: 'cash', amount: 0 }] } },
      { clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 1 }] },
    ]) {
      expect((await c.sell(body)).status).toBe(400);
    }
    expect(await written()).toEqual(NOTHING);
  });

  it('is a venue till feature: an event till is refused, and a venue till still cannot tag-charge', async () => {
    const c = await counter();
    const stall = await seedStall({ price: 100, onHand: 1 });
    const op = await MerchantOperator.create({ fullName: 'Op', merchantId: stall.merchantId, eventId: EVENT, loginCode: 'EVT002', pin: '111111' });
    const eventTill = `Bearer ${jwt.sign({ scope: 'merchant', merchantId: stall.merchantId, merchantOperatorId: String(op._id), operatorName: 'Op', eventId: String(EVENT), name: 'Bar', permissions: [MerchantPermission.CHARGE] }, JWT_SECRET)}`;
    const refused = await c.sell({ clientTxnId: 's1', items: [{ productId: stall.productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 100 }] } }, eventTill);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe('That is a venue feature');
    expect(await written()).toEqual(NOTHING);
    expect(await onHand(stall.merchantId, stall.productId)).toBe(1);
    const tag = await request(app).post('/api/merchant/charge').set('Authorization', c.till.auth).send({ bandUid: '04a1b2c3', clientTxnId: 'c1', amount: 100 });
    expect(tag.status).toBe(403);
    expect(tag.body.message).toBe("Tag payments aren't used at venues");
  });

  it('a suspended venue sells nothing', async () => {
    const c = await counter();
    await Venue.updateOne({ _id: c.venue.venueId }, { $set: { status: 'suspended' } });
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.bar.productId, qty: 1 }], payment: { tenders: [{ method: 'cash', amount: 2500 }] } });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Venue trading is suspended');
    expect(await written()).toEqual(NOTHING);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(10);
  });

  it('rings the lines up in the order they were rung', async () => {
    const c = await counter();
    // Wine was created after the beer: ringing it up first must keep it first.
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.wine, qty: 1 }, beer(c)], payment: cashFor(6500) });
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { name: string }) => i.name)).toEqual(['Wine', 'Castle Lite']);
    expect((await MerchantCharge.findOne({ clientTxnId: 's1' }).lean())!.items!.map((i) => i.name)).toEqual(['Wine', 'Castle Lite']);
  });

  it('an inactive product is not on the menu: refused, nothing written', async () => {
    const c = await counter();
    await Product.updateOne({ _id: c.bar.productId }, { $set: { active: false } });
    const res = await c.sell({ clientTxnId: 's1', items: [beer(c)], payment: cashFor(2500) });
    expect(res.status).toBe(400);
    expect(reasonOf(res)).toBe('product_not_found');
    expect(await written()).toEqual(NOTHING);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(10);
  });

  it('a basket worth more than the maximum charge is refused: too_large, nothing written', async () => {
    const c = await counter();
    const gold = await addVenueProduct(c.venue.venueId, c.bar.merchantId, { name: 'Magnum', price: MAX_CHARGE_CENTS / 2 + 1, onHand: 2 });
    const res = await c.sell({ clientTxnId: 's1', items: [{ productId: gold, qty: 2 }], payment: cashFor(100) });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('amount exceeds the maximum allowed charge');
    expect(reasonOf(res)).toBe('too_large');
    expect(await written()).toEqual(NOTHING);
    expect(await onHand(c.bar.merchantId, gold)).toBe(2);
  });

  it('a retry that sends the same basket reordered, or split across two lines, is the original sale', async () => {
    const c = await counter();
    const first = await c.sell({ clientTxnId: 's1', items: [beer(c, 2), { productId: c.wine, qty: 1 }], payment: cashFor(9000) });
    expect(first.status).toBe(200);
    const after = await written();
    for (const items of [
      [{ productId: c.wine, qty: 1 }, beer(c, 2)],
      [beer(c), { productId: c.wine, qty: 1 }, beer(c)],
    ]) {
      const again = await c.sell({ clientTxnId: 's1', items, payment: cashFor(9000) });
      expect(again.status).toBe(200);
      expect(again.body.data.payment.id).toBe(first.body.data.payment.id);
    }
    expect(await written()).toEqual(after);
    expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(8);
    expect(await onHand(c.bar.merchantId, c.wine)).toBe(0);
  });

  it('a retry whose original commits while the menu is edited is still the original sale, not a refusal', async () => {
    const c = await counter();
    const realFind = Product.find.bind(Product) as (...args: unknown[]) => any;
    let fired = false;
    let original: Awaited<ReturnType<typeof VenueSaleService.counterSale>> | undefined;
    const spy = jest.spyOn(Product, 'find').mockImplementation(((...args: unknown[]) => {
      const query = realFind(...args);
      if (fired) return query;
      fired = true;
      const exec = query.exec.bind(query);
      query.exec = async (...a: unknown[]) => {
        original = await VenueSaleService.counterSale({
          venueId: c.venue.venueId, merchantId: c.bar.merchantId, merchantName: 'Main Bar',
          merchantOperatorId: c.till.merchantOperatorId, operatorName: 'Nomsa',
          clientTxnId: 's1', items: [beer(c, 2)], tenders: [{ method: 'cash', amount: 5000 }],
        });
        await Product.updateOne({ _id: c.bar.productId }, { $set: { active: false } });
        return exec(...a);
      };
      return query;
    }) as never);
    let res: request.Response;
    try {
      res = await c.sell({ clientTxnId: 's1', items: [beer(c, 2)], payment: cashFor(5000) });
      expect(fired).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(res.body.data.payment.id).toBe(String(original!.payment._id));
    expect(await written()).toEqual({ charges: 1, payments: 1, sales: 1 });
  });

  it("a failure that hides the replay check is logged first, then the replay's own failure is the answer", async () => {
    const c = await counter();
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const realFindOne = MerchantCharge.findOne.bind(MerchantCharge) as (...args: unknown[]) => any;
    let reads = 0;
    // The pre-read is the first read of the charge; the replay check after the failed attempt is the second.
    const spy = jest.spyOn(MerchantCharge, 'findOne').mockImplementation(((...args: unknown[]) => {
      reads += 1;
      return reads === 1 ? realFindOne(...args) : Promise.reject(new Error('replay read failed'));
    }) as never);
    let res: request.Response;
    try {
      res = await c.sell({ clientTxnId: 's1', items: [{ productId: c.wine, qty: 2 }], payment: cashFor(8000) });
    } finally {
      spy.mockRestore();
    }
    const logged = quiet.mock.calls.find(([msg]) => msg === 'Counter sale failed before its replay check');
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('replay read failed');
    expect(logged?.[1]).toMatchObject({ reason: 'insufficient_stock' });
    expect(await written()).toEqual(NOTHING);
  });

  describe('the id of a sale is the venue\'s — an id taken by something else is a 409', () => {
    const expectRefused = async (c: Awaited<ReturnType<typeof counter>>, res: request.Response, before: Awaited<ReturnType<typeof written>>, stock: number) => {
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('clientTxnId already used for a different charge');
      expect(reasonOf(res)).toBe('idempotency_mismatch');
      expect(await written()).toEqual(before);
      expect(await onHand(c.bar.merchantId, c.bar.productId)).toBe(stock);
    };

    it("a table payment's id reused at the counter", async () => {
      const c = await counter();
      await tablePaid(c, 'p1');
      const before = await written();
      const stock = await onHand(c.bar.merchantId, c.bar.productId);
      await expectRefused(c, await c.sell({ clientTxnId: 'p1', items: [beer(c)], payment: cashFor(2500) }), before, stock);
    });

    it("another stall's counter-sale id reused at this stall", async () => {
      const c = await counter();
      const kitchen = await seedVenueStall(c.venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
      const kitchenTill = await seedVenueTill(c.venue, kitchen.merchantId, { fullName: 'Lindiwe' });
      const theirs = await c.sell({ clientTxnId: 's1', items: [{ productId: kitchen.productId, qty: 1 }], payment: cashFor(9000) }, kitchenTill.auth);
      expect(theirs.status).toBe(200);
      const before = await written();
      const stock = await onHand(c.bar.merchantId, c.bar.productId);
      await expectRefused(c, await c.sell({ clientTxnId: 's1', items: [beer(c)], payment: cashFor(2500) }), before, stock);
    });

    it("the id of a table's closing stall charge, `<paymentId>:<merchantId>`, is not a sale of this counter", async () => {
      const c = await counter();
      await tablePaid(c, 'p1');
      const crafted = `p1:${c.bar.merchantId}`;
      expect(await MerchantCharge.countDocuments({ merchantId: c.bar.merchantId, clientTxnId: crafted })).toBe(1);
      const before = await written();
      const stock = await onHand(c.bar.merchantId, c.bar.productId);
      // The very same basket the table's charge holds: it must still not be mistaken for a replay.
      await expectRefused(c, await c.sell({ clientTxnId: crafted, items: [beer(c)], payment: cashFor(2500) }), before, stock);
    });

    it("a payment that is not this sale's own, filed under the same id as this stall's charge, is never replayed as the sale", async () => {
      const c = await counter();
      await tablePaid(c, 'p1'); // stall charge `p1:<bar>`
      const crafted = `p1:${c.bar.merchantId}`;
      await tablePaid(c, crafted); // and a table payment whose id IS that stall charge's id
      const before = await written();
      const stock = await onHand(c.bar.merchantId, c.bar.productId);
      await expectRefused(c, await c.sell({ clientTxnId: crafted, items: [beer(c)], payment: cashFor(2500) }), before, stock);
    });
  });

  it('a counter sale across the low-stock threshold alerts the venue owner once, and stays quiet while armed', async () => {
    const c = await counter();
    await setLowStockThreshold(c.bar.merchantId, c.bar.productId, 8);
    expect((await c.sell({ clientTxnId: 's1', items: [beer(c, 2)], payment: cashFor(5000) })).status).toBe(200); // 10 -> 8, crosses
    const notices = await lowStockNotices(c.venue.vendorId);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.data).toMatchObject({ merchantId: c.bar.merchantId, productId: c.bar.productId, onHand: 8, threshold: 8 });
    expect((await c.sell({ clientTxnId: 's2', items: [beer(c)], payment: cashFor(2500) })).status).toBe(200); // 8 -> 7, still armed
    expect(await lowStockNotices(c.venue.vendorId)).toHaveLength(1);
  });
});
