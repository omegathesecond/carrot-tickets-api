// src/services/__tests__/stockReport.dashboard.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';

const eventId = new mongoose.Types.ObjectId();
let seq = 520000;

async function bar(name: string) { return Merchant.create({ name, eventId, loginCode: String(seq++), pin: '000000' } as any); }
async function prod(name: string, category = 'beer') { return Product.create({ eventId, name, category, price: 2500 } as any); }

async function itemisedCharge(merchantId: any, productId: any, name: string, unitPrice: number, qty: number, staffName?: string, clientTxnId = String(new mongoose.Types.ObjectId())) {
  const lineTotal = unitPrice * qty;
  return MerchantCharge.create({
    merchantId, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b1',
    amount: lineTotal, fee: 0, netAmount: lineTotal, clientTxnId, status: 'completed',
    items: [{ productId, name, unitPrice, qty, lineTotal }], ...(staffName ? { staffName } : {}),
  } as any);
}
async function amountOnlyCharge(merchantId: any, amount: number, clientTxnId = String(new mongoose.Types.ObjectId())) {
  // NO items field at all — mirrors MerchantService.charge amount-only path (default:undefined).
  return MerchantCharge.create({
    merchantId, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b2',
    amount, fee: 0, netAmount: amount, clientTxnId, status: 'completed',
  } as any);
}

describe('StockReportService.dashboard', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('splits itemised vs un-itemised by items.0 existence (not the items field)', async () => {
    const b = await bar('Bar 1');
    const p = await prod('Castle Lite');
    await itemisedCharge(b._id, p._id, 'Castle Lite', 2500, 2);   // 5000 itemised
    await amountOnlyCharge(b._id, 1500);                          // 1500 un-itemised

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.itemisedSplit.itemised.gross).toBe(5000);
    expect(d.itemisedSplit.itemised.count).toBe(1);
    expect(d.itemisedSplit.unitemised.gross).toBe(1500);         // the amount-only charge
    expect(d.itemisedSplit.unitemised.count).toBe(1);
    expect(d.itemisedSplit.itemised.gross + d.itemisedSplit.unitemised.gross).toBe(6500);
    expect(d.revenueByProduct[0]).toMatchObject({ productName: 'Castle Lite', revenue: 5000, units: 2 });
  });

  it('groups sales by bar and by employee (null -> Unattributed)', async () => {
    const b = await bar('Bar 1');
    const p = await prod('Savanna', 'wine');
    await itemisedCharge(b._id, p._id, 'Savanna', 3000, 1, 'Thandi');
    await amountOnlyCharge(b._id, 2000);                          // no staffName -> Unattributed

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.salesByBar[0]).toMatchObject({ merchantName: 'Bar 1', gross: 5000, count: 2 });
    const unattributed = d.salesByEmployee.find((e) => e.staffName === null)!;
    expect(unattributed.label).toBe('Unattributed');
    expect(unattributed.gross).toBe(2000);
    const thandi = d.salesByEmployee.find((e) => e.staffName === 'Thandi')!;
    expect(thandi.gross).toBe(3000);
  });
});
