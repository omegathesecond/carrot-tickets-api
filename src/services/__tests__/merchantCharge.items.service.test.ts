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

const eventId = new mongoose.Types.ObjectId();
let __loginCodeSeq = 0;

async function seed({ balance = 100000, beerStock = 100, waterStock = 100, commissionPercent = 0 } = {}) {
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
