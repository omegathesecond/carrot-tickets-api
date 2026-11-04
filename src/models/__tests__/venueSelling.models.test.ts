import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Waiter } from '@models/waiter.model';
import { Table } from '@models/table.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { VenuePayment } from '@models/venuePayment.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const oid = () => new mongoose.Types.ObjectId();
const waiter = (extra: Record<string, unknown>) => ({
  fullName: 'Sipho', loginCode: `W${Math.random().toString(36).slice(2, 7).toUpperCase()}`, pin: '123456', scope: 'organizer', vendorId: oid(), ...extra,
});
const errorsOf = (doc: mongoose.Document) => Object.keys(doc.validateSync()?.errors ?? {});
// validateSync() skips pre('validate') hooks, which is where the owner rule and
// the payment-totals rule live — assert those through the full async validate().
const hookErrorsOf = async (doc: mongoose.Document): Promise<Record<string, { message: string }>> => {
  try { await doc.validate(); return {}; } catch (e: any) { return e?.errors ?? {}; }
};

describe('Waiter — event or venue', () => {
  it('accepts an organizer waiter owned by a venue and no event', async () => {
    const venueId = oid();
    const w = await Waiter.create(waiter({ venueId }));
    expect(String(w.venueId)).toBe(String(venueId));
    expect(w.eventId).toBeUndefined();
  });
  it('still requires an owner for an organizer waiter', () => {
    expect(errorsOf(new Waiter(waiter({})))).toContain('eventId');
  });
  it('refuses a waiter with both an event and a venue', async () => {
    const doc = new Waiter(waiter({ eventId: oid(), venueId: oid() }));
    expect((await hookErrorsOf(doc))['venueId']?.message).toBe('exactly one of eventId or venueId is required');
  });
  it('keeps a platform waiter ownerless, and refuses to give it a venue', async () => {
    await expect(Waiter.create({ ...waiter({}), scope: 'platform', vendorId: undefined })).resolves.toBeTruthy();
    const doc = new Waiter({ ...waiter({ venueId: oid() }), scope: 'platform' });
    expect((await hookErrorsOf(doc))['venueId']?.message).toBe('a platform waiter cannot belong to a venue');
  });
  it('never moves a waiter to another venue', async () => {
    const w = await Waiter.create(waiter({ venueId: oid() }));
    const before = String(w.venueId);
    w.venueId = oid();
    await w.save();
    expect(String((await Waiter.findById(w._id))!.venueId)).toBe(before);
  });
});

describe('Table — event or venue', () => {
  const table = (extra: Record<string, unknown>) => ({ label: '7', status: 'open', openedBy: 'w1', items: [], subtotal: 0, ...extra });

  it('needs exactly one owner', async () => {
    expect((await hookErrorsOf(new Table(table({}))))['venueId']?.message).toBe('exactly one of eventId or venueId is required');
    expect((await hookErrorsOf(new Table(table({ eventId: oid(), venueId: oid() }))))['venueId']?.message).toBe('exactly one of eventId or venueId is required');
  });
  it('lets two venues, and an event, each have an open table 7 — but not one venue twice', async () => {
    const [a, b] = [oid(), oid()];
    await Table.create(table({ venueId: a, orders: [], paidTotal: 0 }));
    await Table.create(table({ venueId: b, orders: [], paidTotal: 0 }));
    await Table.create(table({ eventId: oid() }));
    await expect(Table.create(table({ venueId: a, orders: [], paidTotal: 0 }))).rejects.toMatchObject({ code: 11000 });
  });
  it('frees a venue label once the table is no longer open', async () => {
    const venueId = oid();
    const first = await Table.create(table({ venueId, orders: [], paidTotal: 0 }));
    await Table.updateOne({ _id: first._id }, { $set: { status: 'settled' } });
    await expect(Table.create(table({ venueId, orders: [], paidTotal: 0 }))).resolves.toBeTruthy();
  });
  it('leaves an event table without the venue-only fields', async () => {
    const t = (await Table.create(table({ eventId: oid() }))).toObject();
    expect(t.orders).toBeUndefined();
    expect(t.paidTotal).toBeUndefined();
  });
  it('stores a round: an order row and lines that point at it', async () => {
    const orderId = oid();
    const merchantId = oid();
    const t = await Table.create(table({
      venueId: oid(), paidTotal: 0,
      items: [{ merchantId, productId: oid(), name: 'Castle', unitPrice: 2500, qty: 2, addedBy: 'w1', orderId, paidQty: 0 }],
      orders: [{ _id: orderId, merchantId, lineIds: [], clientTxnId: 'r1', sentAt: new Date(), sentBy: 'w1' }],
      subtotal: 5000,
    }));
    expect(t.orders![0]!.status).toBe('sent');
    expect(String(t.items[0]!.orderId)).toBe(String(orderId));
    expect(new Table(table({ venueId: oid(), orders: [{ merchantId, clientTxnId: 'r1', sentAt: new Date(), sentBy: 'w1', status: 'paid' }] }))
      .validateSync()?.errors['orders.0.status']).toBeTruthy();
  });
});

describe('MerchantCharge — event or venue', () => {
  const charge = (extra: Record<string, unknown>) => ({ merchantId: oid(), amount: 5000, fee: 0, netAmount: 5000, clientTxnId: 'c1', staffName: 'Nomsa', ...extra });

  it('accepts a venue charge with no wallet and no band', async () => {
    const c = await MerchantCharge.create(charge({ venueId: oid() }));
    expect(c.walletId).toBeUndefined();
    expect(c.bandUid).toBeUndefined();
  });
  it('still requires a wallet and a band on an event charge', () => {
    const errors = errorsOf(new MerchantCharge(charge({ eventId: oid() })));
    expect(errors).toEqual(expect.arrayContaining(['walletId', 'bandUid']));
  });
  it('needs exactly one owner', async () => {
    expect((await hookErrorsOf(new MerchantCharge(charge({}))))['venueId']?.message).toBe('exactly one of eventId or venueId is required');
  });
});

describe('VenuePayment', () => {
  const venueId = oid();
  const payment = (extra: Record<string, unknown>) => ({
    venueId, source: 'table', tableId: oid(), tableLabel: '7', merchantIds: [oid()], clientTxnId: 'p1',
    tenders: [{ method: 'cash', amount: 3000, tip: 0 }, { method: 'card', amount: 4500, tip: 500, reference: '0192' }],
    applied: 7500, tips: 500, takenBy: 'w1', takenByType: 'Waiter', staffName: 'Sipho', at: new Date(), ...extra,
  });

  it('stores mixed tenders with a tip on one of them', async () => {
    const p = await VenuePayment.create(payment({}));
    expect(p.tenders.map((t) => t.method)).toEqual(['cash', 'card']);
    expect(p.tenders[1]!.reference).toBe('0192');
  });
  it('refuses totals that do not match the tenders', async () => {
    expect((await hookErrorsOf(new VenuePayment(payment({ applied: 7000 }))))['applied']?.message).toBe('applied must equal the sum of tender amounts');
    expect((await hookErrorsOf(new VenuePayment(payment({ tips: 0 }))))['tips']?.message).toBe('tips must equal the sum of tender tips');
  });
  it('refuses a payment that takes nothing off the bill', () => {
    expect(errorsOf(new VenuePayment(payment({ tenders: [{ method: 'cash', amount: 0, tip: 500 }], applied: 0, tips: 500 })))).toContain('applied');
  });
  it('needs a table for a table payment and a stall charge for a counter sale', () => {
    expect(errorsOf(new VenuePayment(payment({ tableId: undefined })))).toContain('tableId');
    expect(errorsOf(new VenuePayment(payment({ source: 'counter', tableId: undefined, tableLabel: undefined })))).toEqual(expect.arrayContaining(['merchantChargeId', 'merchantName']));
  });
  it('is unique per venue and client transaction id', async () => {
    await VenuePayment.create(payment({}));
    await expect(VenuePayment.create(payment({}))).rejects.toMatchObject({ code: 11000 });
    await expect(VenuePayment.create(payment({ venueId: oid() }))).resolves.toBeTruthy();
  });
});
