/**
 * Enrich the existing dev cashless demo with a CASHIER + a couple of real
 * sample cash-outs, so the organizer report and the cashier "my transactions"
 * have data on first view. Idempotent — safe to re-run.
 *
 * It does NOT recreate the demo event / reseller / vendor / gate: those already
 * exist on dev (created earlier). This ENRICHES them, per "enrich the seed we
 * had". Point MONGODB_URI at the dev database and run:
 *
 *   MONGODB_URI='<dev uri>' npm run seed:cashless
 */
import mongoose from 'mongoose';
import { getDatabaseURI } from '../config/database.config';
import { Event } from '../models/event.model';
import { Wallet } from '../models/wallet.model';
import { Cashier } from '../models/cashier.model';
import { ResellerOperator } from '../models/resellerOperator.model';
import { GateOperator } from '../models/gateOperator.model';
import { Merchant } from '../models/merchant.model';
import { Product } from '../models/product.model';
import { ProductStock } from '../models/productStock.model';
import { StockMovement } from '../models/stockMovement.model';
import { StockTransfer } from '../models/stockTransfer.model';
import { StockCount } from '../models/stockCount.model';
import { WalletService } from '../services/wallet.service';
import { MerchantService } from '../services/merchant.service';
import { StockService } from '../services/stock.service';
import { StockTransferService } from '../services/stockTransfer.service';
import { StockCountService } from '../services/stockCount.service';
import { EventStatus } from '../interfaces/event.interface';
import { ProductCategory, StockMovementReason } from '../interfaces/stock.interface';

const DEMO_EVENT_NAME = /Cashless NFC Tap Test Fest/i;
const DEMO_CASHIER_NAME = 'Demo Cashier';
const PREFERRED_LOGIN_CODE = '502413';
const DEMO_PIN = '618240';

/** True if a login code is already taken by a NON-cashier population (would break login routing). */
async function codeTakenElsewhere(code: string): Promise<boolean> {
  const [r, g, m] = await Promise.all([
    ResellerOperator.exists({ loginCode: code }),
    GateOperator.exists({ loginCode: code }),
    Merchant.exists({ loginCode: code }),
  ]);
  return !!(r || g || m);
}

/**
 * Enrich the demo event with a realistic STOCK story (Slice 7): a product
 * catalogue, per-bar opening stock, a transfer, a few itemised + one amount-only
 * sale (with staffName), and opening/closing counts (one short → visible
 * shrinkage). Everything goes through the real services so every invariant holds
 * (onHand == Σ deltas, money ledger, itemised charges deduct stock). Idempotent:
 * find-or-create products; existence-guarded receive/transfer/count; charges +
 * top-ups keyed by fixed clientTxnIds. Sales are best-effort — with no funded
 * band it warns and skips them rather than fabricating a wallet balance.
 */
export async function seedStock(event: any, opts: { vendorId: string | null; cashierId: string }) {
  const eventId = String(event._id);
  const by = opts.vendorId ?? 'platform';
  const doorsOpen = event.startTime ? new Date(event.startTime) : new Date();
  const preDoors = new Date(doorsOpen.getTime() - 60 * 60 * 1000); // 1h before doors → reads as Opening

  // ── bars (≥2) ──────────────────────────────────────────────────────────────
  const wantBars = [
    { name: 'Main Bar', loginCode: '701001' },
    { name: 'VIP Bar', loginCode: '701002' },
  ];
  for (const b of wantBars) {
    const exists = await Merchant.exists({ eventId: event._id, name: b.name });
    if (!exists) {
      const code = (await codeTakenElsewhere(b.loginCode))
        ? String(700000 + Math.floor(Math.random() * 9000))
        : b.loginCode;
      await Merchant.create({ name: b.name, eventId: event._id, loginCode: code, pin: '000000' });
      console.log(`🏪 Created bar "${b.name}" (login ${code})`);
    }
  }
  const bars = await Merchant.find({ eventId: event._id }).lean();
  if (bars.length < 2) { console.warn('⚠️  need ≥2 bars for the stock demo; skipping stock seed'); return; }
  const mainBar = bars.find((b) => b.name === 'Main Bar') ?? bars[0]!;
  const vipBar = bars.find((b) => b.name === 'VIP Bar') ?? bars[1]!;

  // ── catalogue (find-or-create) ─────────────────────────────────────────────
  const CATALOGUE: Array<{ name: string; category: ProductCategory; price: number; barcode?: string; unitsPerPack?: number; packLabel?: string }> = [
    { name: 'Castle Lite 330ml', category: ProductCategory.BEER, price: 2500, barcode: '6001240100015', unitsPerPack: 24, packLabel: 'case' },
    { name: 'Heineken 330ml', category: ProductCategory.BEER, price: 3000, barcode: '8712000023005', unitsPerPack: 24, packLabel: 'case' },
    { name: 'Savanna Dry 330ml', category: ProductCategory.WINE, price: 3500, barcode: '6001495000018', unitsPerPack: 24, packLabel: 'case' },
    { name: 'Coca-Cola 300ml', category: ProductCategory.SOFT_DRINK, price: 1800, barcode: '5449000000996', unitsPerPack: 24, packLabel: 'case' },
    { name: 'Still Water 500ml', category: ProductCategory.WATER, price: 1500, unitsPerPack: 24, packLabel: 'case' },
    { name: 'Red Bull 250ml', category: ProductCategory.SOFT_DRINK, price: 2800, barcode: '9002490100084', unitsPerPack: 24, packLabel: 'case' },
    { name: 'Ice 2kg', category: ProductCategory.OTHER, price: 2000 },
  ];
  const products: Record<string, any> = {};
  for (const p of CATALOGUE) {
    products[p.name] = (await Product.findOne({ eventId: event._id, name: p.name }))
      ?? (await Product.create({ eventId: event._id, ...p }));
  }
  console.log(`📦 catalogue: ${CATALOGUE.length} products`);

  // ── opening stock per bar (guarded; backdated so it reads as Opening) ──────
  const OPENING: Array<{ bar: any; loads: Array<[string, number]> }> = [
    { bar: mainBar, loads: [['Castle Lite 330ml', 120], ['Heineken 330ml', 96], ['Savanna Dry 330ml', 72], ['Coca-Cola 300ml', 48], ['Still Water 500ml', 60], ['Red Bull 250ml', 36], ['Ice 2kg', 40]] },
    { bar: vipBar, loads: [['Castle Lite 330ml', 60], ['Heineken 330ml', 48], ['Savanna Dry 330ml', 48], ['Red Bull 250ml', 24]] },
  ];
  for (const { bar, loads } of OPENING) {
    for (const [name, qty] of loads) {
      const prod = products[name];
      if (await ProductStock.exists({ merchantId: bar._id, productId: prod._id })) continue; // already loaded
      const { movement } = await StockService.applyMovement({
        eventId, merchantId: String(bar._id), productId: String(prod._id),
        delta: qty, reason: StockMovementReason.RECEIVE,
        refType: 'seed', refId: `seed-open-${bar._id}-${prod._id}`, byType: 'Organizer', by,
      });
      await StockMovement.updateOne({ _id: movement._id }, { $set: { at: preDoors } });
    }
  }
  console.log('📥 opening stock received');

  // ── low-stock thresholds ───────────────────────────────────────────────────
  await ProductStock.updateOne({ merchantId: mainBar._id, productId: products['Red Bull 250ml']._id }, { $set: { lowStockThreshold: 40 } });
  await ProductStock.updateOne({ merchantId: vipBar._id, productId: products['Savanna Dry 330ml']._id }, { $set: { lowStockThreshold: 50 } });

  // ── one bar→bar transfer (guarded) ─────────────────────────────────────────
  const castle = products['Castle Lite 330ml'];
  if (!(await StockTransfer.exists({ eventId: event._id, productId: castle._id, fromMerchantId: mainBar._id, toMerchantId: vipBar._id }))) {
    await StockTransferService.transfer({
      eventId, productId: String(castle._id), fromMerchantId: String(mainBar._id), toMerchantId: String(vipBar._id),
      qty: 24, byType: 'Organizer', by, note: 'seed demo transfer',
    });
    console.log('🔁 transferred 24 Castle Lite: Main Bar → VIP Bar');
  }

  // ── sales (best-effort — needs a funded band) ──────────────────────────────
  const wallets = await Wallet.find({ eventId: event._id, bandUid: { $ne: null } }).limit(2).lean();
  if (wallets.length === 0) {
    console.warn('⚠️  no band-wallet on the demo event — skipping demo sales. Top up a band for the revenue/best-sellers/peak-time demo.');
  } else {
    for (const w of wallets) {
      try {
        await WalletService.topUpCash({ walletId: String(w._id), eventId, amount: 50000, recordedBy: opts.cashierId, recordedByType: 'Cashier', clientTxnId: `seed-topup-${w._id}` });
      } catch (e: any) { console.warn(`   top-up skipped for band ${w.bandUid}: ${e.message}`); }
    }
    const w0 = wallets[0]!;
    const SALES: Array<{ items?: Array<{ productId: string; qty: number }>; amount?: number; staffName: string; txn: string }> = [
      { items: [{ productId: String(castle._id), qty: 2 }], staffName: 'Thandi', txn: 'seed-sale-1' },
      { items: [{ productId: String(products['Heineken 330ml']._id), qty: 1 }, { productId: String(products['Coca-Cola 300ml']._id), qty: 1 }], staffName: 'Thandi', txn: 'seed-sale-2' },
      { items: [{ productId: String(products['Red Bull 250ml']._id), qty: 3 }], staffName: 'Sipho', txn: 'seed-sale-3' },
      { amount: 1500, staffName: 'Sipho', txn: 'seed-sale-amt' }, // un-itemised
    ];
    let sold = 0;
    for (const s of SALES) {
      try {
        await MerchantService.charge({
          merchantId: String(mainBar._id), eventId, walletId: String(w0._id), bandUid: w0.bandUid!,
          clientTxnId: s.txn, staffName: s.staffName,
          ...(s.items ? { items: s.items } : { amount: s.amount }),
        });
        sold++;
      } catch (e: any) { console.warn(`   sale ${s.txn} skipped: ${e.message}`); }
    }
    console.log(`🛒 ${sold} demo sale(s) rung up on Main Bar`);
  }

  // ── closing count a few units short → visible shrinkage in reconciliation ──
  // (Opening is derived from the backdated opening receives, so we deliberately
  // do NOT record an `opening` count — that would OVERRIDE Opening with a
  // post-sales on-hand and misreport the reconciliation baseline.)
  const shrinkProd = products['Savanna Dry 330ml'];
  if (!(await StockCount.exists({ eventId: event._id, merchantId: vipBar._id, productId: shrinkProd._id, phase: 'closing' }))) {
    const ps = await ProductStock.findOne({ merchantId: vipBar._id, productId: shrinkProd._id }).lean();
    if (ps) {
      const counted = Math.max(0, ps.onHand - 5);
      await StockCountService.recordCount({ eventId, merchantId: String(vipBar._id), productId: String(shrinkProd._id), countedOnHand: counted, phase: 'closing', byType: 'Organizer', by });
      console.log(`🔢 closing count VIP Bar Savanna: counted ${counted} (−5 shrinkage)`);
    }
  }

  console.log('✅ Stock demo seeded (catalogue · stock · transfer · sales · counts).');
}

async function main() {
  await mongoose.connect(getDatabaseURI());
  console.log(`📦 Connected to ${mongoose.connection.name}`);

  const event = await Event.findOne({ name: DEMO_EVENT_NAME }).lean();
  if (!event) {
    throw new Error(`Demo event not found (${DEMO_EVENT_NAME}). This script enriches an EXISTING demo — seed the base demo first.`);
  }
  if (!event.cashless || event.status !== EventStatus.PUBLISHED) {
    throw new Error('Demo event is not a published cashless event.');
  }
  const eventId = String(event._id);
  const vendorId = event.vendorId ? String(event.vendorId) : null;
  console.log(`🎪 Event: ${event.name} (${eventId}) — organizer(Vendor)=${vendorId ?? 'none → platform-scoped cashier'}`);

  // ── Upsert the demo cashier (organizer-scoped to the event owner) ──────────
  let cashier = await Cashier.findOne({ fullName: DEMO_CASHIER_NAME, ...(vendorId ? { vendorId } : { scope: 'platform' }) }).select('+pin');
  const loginCode = (await codeTakenElsewhere(PREFERRED_LOGIN_CODE)) ? undefined : PREFERRED_LOGIN_CODE;
  if (!loginCode) console.warn(`⚠️  ${PREFERRED_LOGIN_CODE} is taken by another operator — generating a fresh code for the cashier.`);

  if (!cashier) {
    cashier = await Cashier.create({
      fullName: DEMO_CASHIER_NAME,
      scope: vendorId ? 'organizer' : 'platform',
      ...(vendorId ? { vendorId } : {}),
      loginCode: loginCode ?? String(500000 + Math.floor(Math.random() * 400000)),
      pin: DEMO_PIN,
      isActive: true,
    });
    console.log(`👤 Created cashier "${DEMO_CASHIER_NAME}" — login ${cashier.loginCode} / PIN ${DEMO_PIN}`);
  } else {
    // Keep the demo creds stable across re-runs.
    if (loginCode) cashier.loginCode = loginCode;
    cashier.pin = DEMO_PIN;
    cashier.isActive = true;
    cashier.failedPinAttempts = 0;
    cashier.lockedUntil = null;
    await cashier.save();
    console.log(`👤 Reused cashier "${DEMO_CASHIER_NAME}" — login ${cashier.loginCode} / PIN ${DEMO_PIN} (reset)`);
  }
  const cashierId = String(cashier._id);

  // ── A couple of real sample cash-outs (idempotent via fixed clientTxnId) ───
  const funded = await Wallet.find({ eventId: event._id, status: 'active', bandUid: { $ne: null }, balance: { $gte: 2000 } })
    .sort({ balance: -1 }).limit(2).lean();

  const samples = [
    { wallet: funded[0], amount: 2000, clientTxnId: 'seed-cashout-1' },
    { wallet: funded[1], amount: 1500, clientTxnId: 'seed-cashout-2' },
  ].filter((s) => s.wallet);

  for (const s of samples) {
    const w = s.wallet!;
    const { withdrawal, wallet } = await WalletService.withdrawCash({
      walletId: String(w._id), eventId, amount: s.amount, recordedBy: cashierId, clientTxnId: s.clientTxnId,
    });
    console.log(`💸 Cash-out R${(withdrawal.amount / 100).toFixed(2)} from band ${w.bandUid} → new balance R${(wallet.balance / 100).toFixed(2)}`);
  }
  if (samples.length === 0) console.warn('⚠️  No funded band found to cash out — top up a band first for a richer demo.');

  // ── Stock story (Slice 7): catalogue, per-bar stock, transfer, sales, counts ──
  await seedStock(event, { vendorId, cashierId });

  console.log('\n✅ Cashless demo enriched.');
  console.log('   Cashier login (POS): code %s · PIN %s', cashier.loginCode, DEMO_PIN);
  process.exit(0);
}

// Only auto-run when invoked as a script (`npm run seed:cashless`), so the
// module can be imported (e.g. by a smoke test) without running main().
if (require.main === module) {
  main().catch((e) => {
    console.error('❌ seedCashlessDemo failed:', e);
    process.exit(1);
  });
}
