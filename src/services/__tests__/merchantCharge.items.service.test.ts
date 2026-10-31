import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { MerchantService } from '@services/merchant.service';
import { StockDeclinedError, StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { Wallet } from '@models/wallet.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { StockMovement } from '@models/stockMovement.model';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType } from '@interfaces/ledger.interface';
import { MerchantReversalService } from '@services/merchantReversal.service';
import { Event } from '@models/event.model';
import { StockReportService } from '@services/stockReport.service';
import { StockCountService } from '@services/stockCount.service';
import { PosCatalogService } from '@services/posCatalog.service';

const eventId = new mongoose.Types.ObjectId();
let __loginCodeSeq = 0;

async function seed({ balance = 100000, beerStock = 100, waterStock = 100, commissionPercent = 0 } = {}) {
  await seedPublishedEvent({ eventId });
  const merchant = await Merchant.create({ name: 'Bar 1', eventId, commissionPercent } as any);
  const operator = await new MerchantOperator({
    fullName: 'Sipho Nkosi', merchantId: merchant._id, eventId, loginCode: `4KZ9P${__loginCodeSeq++ % 10}`, pin: '111111',
  }).save();
  const beer = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 });
  const water = await Product.create({ eventId, name: 'Water', category: 'water', price: 1500 });
  const wallet = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), bandUid: '04aabbccddee', balance, cashFundedBalance: balance, status: 'active', currency: 'ZAR' } as any);
  const by = String(merchant._id);
  if (beerStock) await StockService.applyMovement({ eventId, merchantId: merchant._id, productId: beer._id, delta: beerStock, reason: StockMovementReason.RECEIVE, byType: 'Merchant', by });
  if (waterStock) await StockService.applyMovement({ eventId, merchantId: merchant._id, productId: water._id, delta: waterStock, reason: StockMovementReason.RECEIVE, byType: 'Merchant', by });
  return { merchant, operator, beer, water, wallet };
}
// merchantOperatorId/operatorName default to the merchant's seeded operator —
// callers only need to override them to exercise a DIFFERENT operator.
const chargeArgs = (m: any, w: any, extra: any, op?: any) => ({
  merchantId: String(m._id), eventId: String(eventId), walletId: String(w._id), bandUid: w.bandUid, clientTxnId: 'c1',
  ...(op ? { merchantOperatorId: String(op._id), operatorName: op.fullName } : {}),
  ...extra,
});

describe('MerchantService.charge — itemised', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function uncounted(merchantId: any) {
    const product = await Product.create({ eventId, name: 'Made-to-order plate', category: 'food', price: 5000, stockTracked: false });
    await ProductStock.create({ eventId, merchantId, productId: product._id, onHand: 0 });
    return product;
  }

  it('charges allocated uncounted products, replays once, and refunds without inventing stock', async () => {
    const { merchant, operator, wallet } = await seed();
    await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
    const product = await uncounted(merchant._id);
    const args = chargeArgs(merchant, wallet, { items: [{ productId: String(product._id), qty: 2 }], quotedTotal: 10000 }, operator);
    const first = await MerchantService.charge(args);
    const replay = await MerchantService.charge(args);
    expect(String(replay.charge._id)).toBe(String(first.charge._id));
    expect((await Wallet.findById(wallet._id))!.balance).toBe(90000);
    expect(first.charge.items![0]).toMatchObject({ qty: 2, unitPrice: 5000, lineTotal: 10000 });
    expect(await LedgerService.totalOwed(String(eventId), LedgerAccountType.MERCHANT)).toBe(10000);
    const tiles = await PosCatalogService.forMerchant(String(merchant._id), String(eventId));
    expect(tiles.find(p => p.productId === String(product._id))).toMatchObject({ status: 'untracked', onHand: 0, price: 5000 });
    const board = await StockReportService.board(String(eventId));
    expect(board.byProduct.find(p => p.productId === String(product._id))).toMatchObject({ stockTracked: false, status: 'UNTRACKED', unitsSold: 2, revenue: 10000 });
    const recon = await StockReportService.reconciliation(String(eventId), new Date());
    expect(recon.byProduct.find(p => p.productId === String(product._id))).toMatchObject({ stockTracked: false, sold: 2, salesRevenue: 10000, physicalCount: null, variance: null });
    const dashboard = await StockReportService.dashboard(String(eventId));
    expect(dashboard.peakTimes.reduce((n, p) => n + p.units, 0)).toBe(2);
    await expect(StockService.applyMovement({ eventId, merchantId: merchant._id, productId: product._id, delta: 10, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'test' })).rejects.toThrow('does not track inventory');
    await expect(StockCountService.recordCount({ eventId: String(eventId), merchantId: String(merchant._id), productId: String(product._id), countedOnHand: 0, byType: 'Organizer', by: 'test' })).rejects.toThrow('does not track inventory');
    await MerchantReversalService.reverse({ chargeId: String(first.charge._id), eventId: String(eventId), merchantId: String(merchant._id), merchantOperatorId: String(operator._id), bandUid: wallet.bandUid!, pin: '111111', reason: 'Customer return', restock: true });
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
    expect(await LedgerService.totalOwed(String(eventId), LedgerAccountType.MERCHANT)).toBe(0);
    expect((await ProductStock.findOne({ productId: product._id }))!.onHand).toBe(0);
    expect(await StockMovement.countDocuments({ productId: product._id })).toBe(0);
  });

  it('refuses an unallocated uncounted product and rolls back the wallet', async () => {
    const { merchant, operator, wallet } = await seed();
    const product = await Product.create({ eventId, name: 'Other stall meal', category: 'food', price: 5000, stockTracked: false });
    await expect(MerchantService.charge(chargeArgs(merchant, wallet, { items: [{ productId: String(product._id), qty: 1 }], quotedTotal: 5000 }, operator))).rejects.toThrow('product not sold at that stall');
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
    expect(await MerchantCharge.countDocuments()).toBe(0);
  });

  it('still declines a mixed basket when its counted product runs out', async () => {
    const { merchant, operator, beer, wallet } = await seed({ beerStock: 1 });
    const product = await uncounted(merchant._id);
    await expect(MerchantService.charge(chargeArgs(merchant, wallet, { items: [{ productId: String(product._id), qty: 1 }, { productId: String(beer._id), qty: 2 }], quotedTotal: 10000 }, operator))).rejects.toBeInstanceOf(StockDeclinedError);
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
    expect(await MerchantCharge.countDocuments()).toBe(0);
  });

  it.each([[1, 3500], [5, 17500], [6, 19000], [7, 22500], [10, 33000], [12, 38000], [13, 41500]])(
    'charges %i base units at %i cents and deducts that exact stock quantity', async (qty, total) => {
      const { merchant, operator, beer, wallet } = await seed();
      beer.price = 3500;
      beer.bundlePrice = { quantity: 6, price: 19000 };
      await beer.save();
      const items = [{ productId: String(beer._id), qty }];
      const quote = await MerchantService.quote({ eventId: String(eventId), items });
      expect(quote.subtotal).toBe(total);
      const args = chargeArgs(merchant, wallet, { items, quotedTotal: quote.total }, operator);
      const first = await MerchantService.charge(args);
      const replay = await MerchantService.charge(args);
      expect(String(replay.charge._id)).toBe(String(first.charge._id));
      expect(first.charge.items![0]).toMatchObject({ qty, unitPrice: 3500, lineTotal: total });
      expect(first.charge.items![0]!.pricing).toMatchObject({
        regularUnits: qty % 6, specialUnits: Math.floor(qty / 6) * 6,
        specialBundles: Math.floor(qty / 6), bundleQuantity: 6, bundlePrice: 19000,
        discountAmount: qty * 3500 - total,
      });
      expect(first.wallet.balance).toBe(100000 - total);
      expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(100 - qty);
      expect(await LedgerService.totalOwed(String(eventId), LedgerAccountType.MERCHANT)).toBe(total);
    },
  );

  it.each(['active', 'historical', 'restocked refund', 'kept refund', 'refund after opening'])('reconciles a ten-unit special sale: %s', async (scenario) => {
    const { merchant, operator, beer, wallet } = await seed();
    await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
    beer.price = 3500; beer.bundlePrice = { quantity: 6, price: 19000 }; await beer.save();
    const { charge } = await MerchantService.charge(chargeArgs(merchant, wallet, {
      items: [{ productId: String(beer._id), qty: 10 }], quotedTotal: 33000,
    }, operator));
    // Catalogue changes must never reprice or reclassify a completed sale.
    beer.price = 4000; beer.bundlePrice = { quantity: 6, price: 22000 }; await beer.save();
    if (scenario === 'historical') await MerchantCharge.updateOne({ _id: charge._id }, { $unset: { 'items.0.pricing': 1 } });
    if (scenario === 'refund after opening') {
      await MerchantCharge.updateOne({ _id: charge._id }, { $set: { createdAt: new Date('2020-01-01') } }, { timestamps: false });
      await StockCountService.recordCount({ eventId: String(eventId), merchantId: String(merchant._id), productId: String(beer._id),
        countedOnHand: 90, phase: 'opening', byType: 'Organizer', by: 'test' });
    }
    if (scenario.includes('refund')) await MerchantReversalService.reverse({ chargeId: String(charge._id),
      eventId: String(eventId), merchantId: String(merchant._id), merchantOperatorId: String(operator._id),
      bandUid: wallet.bandUid!, pin: '111111', reason: 'Customer return', restock: scenario !== 'kept refund' });
    const report = await StockReportService.reconciliation(String(eventId), new Date());
    const row = report.perBar.find(r => r.productId === String(beer._id))!;
    const sign = scenario === 'refund after opening' ? -1 : scenario.includes('refund') ? 0 : 1;
    expect(row).toMatchObject({ regularUnits: scenario === 'historical' ? 0 : sign * 4,
      specialUnits: scenario === 'historical' ? 0 : sign * 6,
      specialBundles: scenario === 'historical' ? 0 : sign,
      unclassifiedUnits: scenario === 'historical' ? 10 : 0,
      discountAmount: sign * 2000, regularValue: sign * 35000, salesRevenue: sign * 33000,
      refundedNotRestockedUnits: scenario === 'kept refund' ? 10 : 0 });
    expect(row.regularUnits + row.specialUnits + row.unclassifiedUnits + row.refundedNotRestockedUnits).toBe(row.sold);
    expect(row.regularValue - row.discountAmount).toBe(row.salesRevenue);
    expect(report.total.salesRevenue).toBe(row.salesRevenue);
    expect(report.byProduct.find(r => r.productId === row.productId)!.discountAmount).toBe(row.discountAmount);
  });

  it('combines duplicate lines before applying the six-unit price', async () => {
    const { beer } = await seed();
    beer.bundlePrice = { quantity: 6, price: 14000 };
    await beer.save();
    const quote = await MerchantService.quote({ eventId: String(eventId), items: [
      { productId: String(beer._id), qty: 3 }, { productId: String(beer._id), qty: 3 },
    ] });
    expect(quote.subtotal).toBe(14000);
  });

  it('keeps the listed single price for six units of a product without a lower price line', async () => {
    const { water } = await seed();
    const quote = await MerchantService.quote({ eventId: String(eventId), items: [{ productId: String(water._id), qty: 6 }] });
    expect(quote.subtotal).toBe(9000);
  });

  it('rejects a six-unit sale when only five remain, rolling money and stock back', async () => {
    const { merchant, operator, beer, wallet } = await seed({ beerStock: 5 });
    beer.bundlePrice = { quantity: 6, price: 14000 };
    await beer.save();
    await expect(MerchantService.charge(chargeArgs(merchant, wallet, {
      items: [{ productId: String(beer._id), qty: 6 }], quotedTotal: 14000,
    }, operator))).rejects.toBeInstanceOf(StockDeclinedError);
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(5);
    expect(await MerchantCharge.countDocuments()).toBe(0);
  });

  it('refunds the stored discounted amount and returns six units once after catalogue repricing', async () => {
    const { merchant, operator, beer, wallet } = await seed();
    await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
    beer.bundlePrice = { quantity: 6, price: 14000 };
    await beer.save();
    const { charge } = await MerchantService.charge(chargeArgs(merchant, wallet, {
      items: [{ productId: String(beer._id), qty: 6 }], quotedTotal: 14000,
    }, operator));
    beer.bundlePrice = { quantity: 6, price: 13000 };
    await beer.save();
    const args = { chargeId: String(charge._id), eventId: String(eventId), merchantId: String(merchant._id),
      merchantOperatorId: String(operator._id), bandUid: wallet.bandUid!, pin: '111111', reason: 'Customer return', restock: true };
    await MerchantReversalService.reverse(args);
    await MerchantReversalService.reverse(args);
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(100);
  });

  it('prices from the catalogue, debits once, and decrements each product', async () => {
    const { merchant, operator, beer, water, wallet } = await seed();
    const { wallet: w, charge } = await MerchantService.charge(chargeArgs(merchant, wallet, {
      items: [{ productId: String(beer._id), qty: 2 }, { productId: String(water._id), qty: 1 }],
      // A client-supplied staffName must not reach the record — the operator's
      // own name (from the token, mirrored here via chargeArgs' 4th arg) wins.
      staffName: 'Somebody Else',
    }, operator));
    expect(charge.amount).toBe(2 * 2500 + 1500);         // server-priced = 6500
    expect(w.balance).toBe(100000 - 6500);                // debited once
    expect(charge.items).toHaveLength(2);
    expect(charge.staffName).toBe(operator.fullName);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(98);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: water._id }))!.onHand).toBe(99);
    // money ledger unchanged in shape
    expect(await LedgerService.totalOwed(String(eventId), LedgerAccountType.MERCHANT)).toBe(6500);

    // Stock-movement attribution moved to the PERSON too (merchant.service.ts's
    // StockService.applyMovement call for a sale posts `by: merchantOperatorId`,
    // NOT `by: merchantId`) — assert both halves, the same way the ledger test
    // discriminates, so this cannot pass by coincidence.
    const saleMovement = await StockMovement.findOne({ merchantId: merchant._id, productId: beer._id, reason: StockMovementReason.SALE });
    expect(saleMovement!.by).toBe(String(operator._id));
    expect(saleMovement!.by).not.toBe(String(merchant._id));
  });

  it('hard-blocks an out-of-stock line and rolls EVERYTHING back', async () => {
    const { merchant, operator, beer, water, wallet } = await seed({ waterStock: 0 });
    await expect(MerchantService.charge(chargeArgs(merchant, wallet, {
      items: [{ productId: String(beer._id), qty: 1 }, { productId: String(water._id), qty: 1 }],
    }, operator))).rejects.toBeInstanceOf(StockDeclinedError);
    // nothing committed: wallet full, beer NOT decremented, no charge row
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(100);
    expect(await MerchantCharge.countDocuments({ merchantId: merchant._id })).toBe(0);
  });

  it('N concurrent itemised taps on the last 5 beers: exactly 5 succeed, no oversell', async () => {
    const { merchant, operator, beer } = await seed({ beerStock: 5, waterStock: 0 });
    // one funded wallet per tap
    const wallets = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), bandUid: `04aabbccdd${String(i).padStart(2, '0')}`, balance: 100000, cashFundedBalance: 100000, status: 'active', currency: 'ZAR' } as any)));
    const results = await Promise.all(wallets.map((w, i) =>
      MerchantService.charge({
        merchantId: String(merchant._id), merchantOperatorId: String(operator._id), operatorName: operator.fullName,
        eventId: String(eventId), walletId: String(w._id), bandUid: w.bandUid!, clientTxnId: `c${i}`, items: [{ productId: String(beer._id), qty: 1 }],
      })
        .then(() => 'ok').catch((e) => e instanceof StockDeclinedError ? 'declined' : Promise.reject(e))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(0);
  });

  it('is idempotent on {merchantId, clientTxnId}: stock + money apply once', async () => {
    const { merchant, operator, beer, wallet } = await seed();
    const args = chargeArgs(merchant, wallet, { items: [{ productId: String(beer._id), qty: 3 }] }, operator);
    const first = await MerchantService.charge(args);
    const second = await MerchantService.charge(args);
    expect(String(second.charge._id)).toBe(String(first.charge._id));
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(97); // −3 once
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000 - 3 * 2500);
  });

  it('preserves the amount-only path (no items, no stock touched)', async () => {
    const { merchant, operator, beer, wallet } = await seed();
    const { charge } = await MerchantService.charge(chargeArgs(merchant, wallet, { amount: 300 }, operator));
    expect(charge.amount).toBe(300);
    expect(charge.items).toBeUndefined();
    expect((await ProductStock.findOne({ merchantId: merchant._id, productId: beer._id }))!.onHand).toBe(100); // untouched
  });

  it('rejects a product from a different event, writing nothing', async () => {
    const { merchant, operator, wallet } = await seed();
    const foreign = await Product.create({ eventId: new mongoose.Types.ObjectId(), name: 'Nope', category: 'beer', price: 100 });
    await expect(MerchantService.charge(chargeArgs(merchant, wallet, { items: [{ productId: String(foreign._id), qty: 1 }] }, operator))).rejects.toThrow();
    expect((await Wallet.findById(wallet._id))!.balance).toBe(100000);
  });
});
