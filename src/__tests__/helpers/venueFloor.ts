/**
 * Fixtures for venue selling tests (venue trading Phase 3): a venue, its
 * stalls and stock, a waiter, a till — and tokens signed the way the real
 * login signs them. Stock moves through StockService, so a suite using
 * seedVenueStall / addVenueProduct needs connectLedgerTestDb (replica set).
 */
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { JWT_SECRET } from '@config/jwt.config';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { Waiter } from '@models/waiter.model';
import { ProductStock } from '@models/productStock.model';
import { Notification } from '@models/notification.model';
import { Event } from '@models/event.model';
import { StockService } from '@services/stock.service';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';
import { EventStatus } from '@interfaces/event.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { seedVendorSessionToken } from './auth';

let seq = 0;
const next = () => (seq += 1);
const code = (prefix: string) => `${prefix}${String(next()).padStart(4, '0')}`;

export interface SeededVenue { vendorId: string; venueId: string; venueName: string; currency: 'SZL' | 'ZAR' }

export async function seedVenue(opts: { name?: string; currency?: 'SZL' | 'ZAR' } = {}): Promise<SeededVenue> {
  const n = next();
  const name = opts.name ?? `Lounge ${n}`;
  const vendor = await Vendor.create({ businessName: name, email: `lounge${n}@floor.test`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name, currency: opts.currency ?? 'SZL', activatedBy: 'fixture' });
  return { vendorId: String(vendor._id), venueId: String(venue._id), venueName: name, currency: venue.currency };
}

/** A product on the venue's catalogue, stocked `onHand` at `merchantId`. Returns its id. */
export async function addVenueProduct(venueId: string, merchantId: string, opts: { name: string; price: number; onHand: number }): Promise<string> {
  const product = await Product.create({ venueId, name: opts.name, category: ProductCategory.BEER, price: opts.price });
  if (opts.onHand) {
    await StockService.applyMovement({
      venueId, merchantId, productId: product._id, delta: opts.onHand,
      reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'fixture',
    });
  }
  return String(product._id);
}

/** A stall at the venue selling one product. */
export async function seedVenueStall(venueId: string, opts: { name?: string; product?: string; price: number; onHand: number }): Promise<{ merchantId: string; productId: string }> {
  const merchant = await Merchant.create({ name: opts.name ?? 'Main Bar', venueId });
  const productId = await addVenueProduct(venueId, String(merchant._id), { name: opts.product ?? 'Castle Lite', price: opts.price, onHand: opts.onHand });
  return { merchantId: String(merchant._id), productId };
}

/** A venue waiter (able to take payment unless `grants` says otherwise) and its token. */
export async function seedVenueWaiter(venue: SeededVenue, opts: { fullName?: string; grants?: OperatorGrant[] } = {}) {
  const fullName = opts.fullName ?? 'Sipho';
  const waiter = await Waiter.create({
    fullName, loginCode: code('VW'), pin: '123456', scope: 'organizer',
    vendorId: venue.vendorId, venueId: venue.venueId, grants: opts.grants ?? [OperatorGrant.SETTLE_TABLES],
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id), role: 'waiter',
    permissions: [], isSuperAdmin: false, fullName, vendorId: venue.vendorId, venueId: venue.venueId,
  }, JWT_SECRET);
  return { waiterId: String(waiter._id), loginCode: waiter.loginCode, auth: `Bearer ${token}` };
}

/**
 * An EVENT waiter (organizer scope, bound to an event) and its token — the
 * counter-case for "That is a venue feature". `grants` adds per-person switches
 * (an event waiter has no take-payment switch unless it is granted).
 */
export async function seedEventWaiter(opts: { grants?: OperatorGrant[] } = {}) {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({ vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [] });
  const waiter = await Waiter.create({ fullName: 'Thabo', loginCode: 'EW0001', pin: '123456', scope: 'organizer', vendorId, eventId: event._id, ...(opts.grants ? { grants: opts.grants } : {}) });
  const token = jwt.sign({ scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id), role: 'waiter', permissions: [], isSuperAdmin: false, fullName: 'Thabo', vendorId: String(vendorId), eventId: String(event._id) }, JWT_SECRET);
  return { auth: `Bearer ${token}`, loginCode: 'EW0001' };
}

/** A till operator on a venue stall and its token. */
export async function seedVenueTill(venue: SeededVenue, merchantId: string, opts: { fullName?: string; grants?: OperatorGrant[] } = {}) {
  const fullName = opts.fullName ?? 'Nomsa';
  const operator = await MerchantOperator.create({
    fullName, merchantId, venueId: venue.venueId, loginCode: code('VT'), pin: '111111', grants: opts.grants ?? [],
  });
  const merchant = await Merchant.findById(merchantId).select('name').lean();
  const token = jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId: String(operator._id), operatorName: fullName,
    name: merchant?.name, venueId: venue.venueId, venueName: venue.venueName, permissions: [MerchantPermission.CHARGE],
  }, JWT_SECRET);
  return { merchantOperatorId: String(operator._id), loginCode: operator.loginCode, auth: `Bearer ${token}` };
}

/** A dashboard token for the venue's vendor. Default: every venue permission. */
export const venueDashboardAuth = async (venue: SeededVenue, permissions?: string[]) =>
  `Bearer ${await seedVendorSessionToken(venue.vendorId, permissions ? { permissions } : {})}`;

/** Arm the low-stock alert for one stall's product: it fires once when on-hand falls to `lowStockThreshold`. */
export const setLowStockThreshold = (merchantId: string, productId: string, lowStockThreshold: number) =>
  ProductStock.updateOne({ merchantId, productId }, { $set: { lowStockThreshold, lowStockAlertedAt: null } });

/** The low_stock notifications a vendor has. The alert is fire-and-forget, so give it a moment to land first. */
export async function lowStockNotices(vendorId: string) {
  await new Promise((r) => setTimeout(r, 200));
  return Notification.find({ recipientType: 'vendor', recipientId: vendorId, type: 'low_stock' }).lean();
}
