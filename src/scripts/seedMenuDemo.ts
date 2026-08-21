/**
 * Seed the DEV environment with a bar + vendor Menu for an existing demo
 * event, plus a couple of preorders, so the "Menu" tab (organizer dashboard
 * AND public event page) has something real to look at on first view — this
 * answers "where do we put the menu / how do we preorder" by giving a live
 * example rather than an empty tab.
 *
 * SAFETY — same guard as seedDevEnvironment.ts: refuses to run against any
 * database whose name isn't exactly `carrot-tickets-dev`. Non-destructive and
 * idempotent (upserts MenuItems by natural key, orders by a fixed orderId) —
 * safe to re-run.
 *
 * Requires the target event to already exist and own a vendor (it needs one
 * to own the menu) — e.g. the `npm run seed:dev` event, or any other
 * published demo event such as the cashless one from `npm run seed:cashless`.
 * Defaults to the Bushfire dev demo; point it at a different event with
 * MENU_DEMO_EVENT_NAME (case-insensitive substring match).
 *
 * Usage:
 *   MONGODB_URI='<dev uri>' npx ts-node -r tsconfig-paths/register src/scripts/seedMenuDemo.ts
 *   MONGODB_URI='<dev uri>' MENU_DEMO_EVENT_NAME='Cashless NFC Tap Test Fest' npx ts-node -r tsconfig-paths/register src/scripts/seedMenuDemo.ts
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Event } from '../models/event.model';
import { Buyer } from '../models/buyer.model';
import { MenuItem, MenuSection } from '../models/menuItem.model';
import { MenuOrder, MenuOrderFulfillmentStatus } from '../models/menuOrder.model';
import { EventStatus } from '../interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '../interfaces/ticket.interface';
import { PaymentConfigService } from '../services/paymentConfig.service';
import { computeMenuServiceFee } from '../utils/menuServiceFee.util';

dotenv.config();

/** The ONLY database this script may touch. */
const ALLOWED_DB_NAME = 'carrot-tickets-dev';

const DEMO_EVENT_NAME = process.env['MENU_DEMO_EVENT_NAME']
  ? new RegExp(process.env['MENU_DEMO_EVENT_NAME'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  : /Bushfire Warm-Up Session/i;

interface SeedMenuItem {
  section: MenuSection;
  vendorName?: string;
  category: string;
  name: string;
  description?: string;
  price: number; // integer cents
  displayOrder: number;
}

const BAR_ITEMS: SeedMenuItem[] = [
  { section: MenuSection.BAR, category: 'Beer', name: 'Castle Lite 330ml', price: 2500, displayOrder: 1 },
  { section: MenuSection.BAR, category: 'Beer', name: 'Heineken 330ml', price: 3000, displayOrder: 2 },
  { section: MenuSection.BAR, category: 'Spirits', name: 'Hennessy VS (single)', price: 8500, displayOrder: 1 },
  { section: MenuSection.BAR, category: 'Spirits', name: 'Jameson (single)', price: 6500, displayOrder: 2 },
  { section: MenuSection.BAR, category: 'Soft Drinks', name: 'Coca-Cola 300ml', price: 1800, displayOrder: 1 },
  { section: MenuSection.BAR, category: 'Soft Drinks', name: 'Still Water 500ml', price: 1500, displayOrder: 2 },
];

const VENDOR_ITEMS: SeedMenuItem[] = [
  { section: MenuSection.VENDOR, vendorName: "Mama Thandi's Kitchen", category: 'Starters', name: 'Chicken Wings (6)', description: 'Peri-peri or BBQ.', price: 4500, displayOrder: 1 },
  { section: MenuSection.VENDOR, vendorName: "Mama Thandi's Kitchen", category: 'Starters', name: 'Boerewors Roll', price: 3500, displayOrder: 2 },
  { section: MenuSection.VENDOR, vendorName: "Mama Thandi's Kitchen", category: 'Mains', name: 'Beef Burger & Chips', price: 8000, displayOrder: 1 },
  { section: MenuSection.VENDOR, vendorName: "Mama Thandi's Kitchen", category: 'Mains', name: 'Veggie Wrap', price: 6000, displayOrder: 2 },
  { section: MenuSection.VENDOR, vendorName: 'Sunset Grill', category: 'Mains', name: 'Grilled Chicken Platter', price: 9500, displayOrder: 1 },
  { section: MenuSection.VENDOR, vendorName: 'Sunset Grill', category: 'Mains', name: 'Ribs Combo', price: 12000, displayOrder: 2 },
  { section: MenuSection.VENDOR, vendorName: 'Sunset Grill', category: 'Sides', name: 'Loaded Chips', price: 3000, displayOrder: 1 },
];

async function seedMenuItems(eventId: mongoose.Types.ObjectId): Promise<Map<string, any>> {
  const all = [...BAR_ITEMS, ...VENDOR_ITEMS];
  const byKey = new Map<string, any>();
  let created = 0;
  for (const item of all) {
    const key = `${item.section}::${item.vendorName ?? ''}::${item.category}::${item.name}`;
    const filter = { eventId, section: item.section, vendorName: item.vendorName, category: item.category, name: item.name };
    let doc = await MenuItem.findOne(filter);
    if (!doc) {
      doc = await MenuItem.create({ ...item, eventId, active: true });
      created++;
    }
    byKey.set(key, doc);
  }
  console.log(`🍔 ${created} menu item(s) created (${all.length - created} already present); ${all.length} total.`);
  return byKey;
}

async function seedOrder(opts: {
  orderId: string;
  event: any;
  buyerId: mongoose.Types.ObjectId;
  buyerName: string;
  lines: Array<{ item: any; quantity: number }>;
  fulfillmentStatus: MenuOrderFulfillmentStatus;
  serviceFeePercent: number;
}): Promise<void> {
  const existing = await MenuOrder.findOne({ orderId: opts.orderId });
  if (existing) {
    console.log(`   • order ${opts.orderId} — already present, left alone`);
    return;
  }
  const items = opts.lines.map(({ item, quantity }) => ({
    menuItemId: item._id,
    name: item.name,
    unitPrice: item.price,
    quantity,
    lineTotal: item.price * quantity,
  }));
  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  const { serviceFeeAmount, amountCharged } = computeMenuServiceFee(subtotal, opts.serviceFeePercent);

  await MenuOrder.create({
    orderId: opts.orderId,
    eventId: opts.event._id,
    vendorId: opts.event.vendorId,
    buyerId: opts.buyerId,
    buyerName: opts.buyerName,
    items,
    subtotal,
    serviceFeeAmount,
    amountCharged,
    paymentMethod: PaymentMethod.KESHLESS_WALLET,
    paymentStatus: PaymentStatus.COMPLETED,
    walletTransactionId: `seed-${opts.orderId}`,
    fulfillmentStatus: opts.fulfillmentStatus,
    paidAt: new Date(),
  });
  console.log(`   • order ${opts.orderId} — created (${opts.fulfillmentStatus}, subtotal ${subtotal}c + fee ${serviceFeeAmount}c = ${amountCharged}c)`);
}

async function seed(): Promise<void> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is required — refusing to guess.');

  await mongoose.connect(uri);

  const dbName = mongoose.connection.db?.databaseName;
  if (dbName !== ALLOWED_DB_NAME) {
    await mongoose.disconnect();
    throw new Error(
      `REFUSING TO SEED: connected to database "${dbName}", but this script only ` +
        `runs against "${ALLOWED_DB_NAME}". Check MONGODB_URI.`
    );
  }
  console.log(`✅ Connected to ${dbName} (guard passed)\n`);

  const event = await Event.findOne({ name: DEMO_EVENT_NAME, status: EventStatus.PUBLISHED });
  if (!event) {
    await mongoose.disconnect();
    throw new Error(
      `Demo event not found (${DEMO_EVENT_NAME}). Run "npm run seed:dev" first to create it.`
    );
  }
  if (!event.vendorId) {
    await mongoose.disconnect();
    throw new Error(`Demo event "${event.name}" has no vendorId — cannot own a menu. Re-seed with seed:dev.`);
  }
  console.log(`🎪 Event: ${event.name} (${event._id})`);

  // Per-event so seeding two different demo events never collides on a
  // shared buyer phone or fixed orderId (both must stay globally unique).
  const eventIdSuffix = String(event._id).slice(-4);
  const eventIdDigits = String(parseInt(eventIdSuffix, 16)).padStart(5, '0').slice(-5);
  const demoBuyerPhone = `+2687800${eventIdDigits}`;
  const orderIdPrefix = `MENU-SEED-${eventIdSuffix}`;

  const byKey = await seedMenuItems(event._id as mongoose.Types.ObjectId);

  // ── Demo buyer (find-or-create, no login creds needed for a seeded order) ──
  let buyer = await Buyer.findOne({ phone: demoBuyerPhone });
  if (!buyer) {
    buyer = await Buyer.create({ phone: demoBuyerPhone, name: 'Menu Demo Buyer', password: 'seed-only-not-a-real-login' });
    console.log(`🎟️  Buyer ready: ${demoBuyerPhone} (id ${buyer._id})`);
  } else {
    console.log(`🎟️  Buyer reused: ${demoBuyerPhone} (id ${buyer._id})`);
  }

  const config = await PaymentConfigService.get();
  const percent = config.menuServiceFeePercent;

  const wings = byKey.get(`vendor::Mama Thandi's Kitchen::Starters::Chicken Wings (6)`);
  const burger = byKey.get(`vendor::Mama Thandi's Kitchen::Mains::Beef Burger & Chips`);
  const castle = byKey.get(`bar::::Beer::Castle Lite 330ml`);
  const ribs = byKey.get(`vendor::Sunset Grill::Mains::Ribs Combo`);

  if (wings && burger && castle && ribs) {
    await seedOrder({
      orderId: `${orderIdPrefix}-1`,
      event, buyerId: buyer._id as mongoose.Types.ObjectId, buyerName: buyer.name || 'Menu Demo Buyer',
      lines: [{ item: wings, quantity: 1 }, { item: burger, quantity: 1 }, { item: castle, quantity: 2 }],
      fulfillmentStatus: MenuOrderFulfillmentStatus.NEW,
      serviceFeePercent: percent,
    });
    await seedOrder({
      orderId: `${orderIdPrefix}-2`,
      event, buyerId: buyer._id as mongoose.Types.ObjectId, buyerName: buyer.name || 'Menu Demo Buyer',
      lines: [{ item: ribs, quantity: 1 }],
      fulfillmentStatus: MenuOrderFulfillmentStatus.READY,
      serviceFeePercent: percent,
    });
  } else {
    console.warn('⚠️  could not resolve seed items for demo orders — skipping order seed.');
  }

  console.log('\n✅ Menu demo seeded.');
  console.log(`   Public: browse/preorder from the "Menu" tab on the event page for "${event.name}".`);
  console.log('   Organizer: manage items and review orders from the "Menu" tab on the event details page.');
  await mongoose.disconnect();
}

seed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ Seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
