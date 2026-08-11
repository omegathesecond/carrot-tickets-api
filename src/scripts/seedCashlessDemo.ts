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
import { WalletService } from '../services/wallet.service';
import { EventStatus } from '../interfaces/event.interface';

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

  console.log('\n✅ Cashless demo enriched.');
  console.log('   Cashier login (POS): code %s · PIN %s', cashier.loginCode, DEMO_PIN);
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ seedCashlessDemo failed:', e);
  process.exit(1);
});
