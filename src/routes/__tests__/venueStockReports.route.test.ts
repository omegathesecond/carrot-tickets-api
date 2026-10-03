import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 0;
async function ownedVenue() {
  seq += 1;
  const venueName = `Lounge ${seq}`;
  const vendor = await Vendor.create({ businessName: venueName, email: `reports${seq}@x.co`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name: venueName, currency: 'SZL', activatedBy: 'admin' });
  const vendorId = String(vendor._id);
  const tokenWith = (permissions: TicketsPermission[]) => `Bearer ${signVendorToken(vendorId, { permissions })}`;
  return {
    venueId: String(venue._id),
    venueName,
    auth: tokenWith([TicketsPermission.MANAGE_STOCK, TicketsPermission.VIEW_REVENUE]),
    stockOnly: tokenWith([TicketsPermission.MANAGE_STOCK]),
  };
}
const CASTLE = { name: 'Castle Lite 330ml', category: 'beer', price: 2500, barcode: '6001240100015', unitsPerPack: 24, packLabel: 'case' };

/** A venue with one stall and one product, with 6 units received through the real route. */
async function stockedVenue() {
  const v = await ownedVenue();
  const stall = await Merchant.create({ name: 'Main Bar', venueId: v.venueId });
  const product = await Product.create({ ...CASTLE, venueId: v.venueId });
  const received = await request(app).post('/api/tickets/venue/stock/receive').set('Authorization', v.auth)
    .send({ merchantId: String(stall._id), productId: String(product._id), quantity: 6, unit: 'unit' });
  expect(received.status).toBe(200);
  return { ...v, stall, product };
}

describe('venue stock reports', () => {
  it('board lists its own stock only, tagged with the venue', async () => {
    const a = await stockedVenue();
    // Another venue has stock of its own, which must not leak into A's board.
    const b = await ownedVenue();
    const bStall = await Merchant.create({ name: 'B Bar', venueId: b.venueId });
    const bProduct = await Product.create({ name: 'Savanna Dry', category: 'beer', price: 2800, venueId: b.venueId });
    await ProductStock.create({ venueId: b.venueId, merchantId: bStall._id, productId: bProduct._id, onHand: 9 });

    const res = await request(app).get('/api/tickets/venue/stock/board').set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.venue).toEqual({ id: a.venueId, name: a.venueName });
    expect(res.body.data.perBar.map((r: any) => r.productName)).toEqual(['Castle Lite 330ml']);
  });

  it('reconciliation defaults to today and counts a receive made now as added', async () => {
    const a = await stockedVenue();
    const res = await request(app).get('/api/tickets/venue/stock/reconciliation').set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.venue).toEqual({ id: a.venueId, name: a.venueName });
    expect(res.body.data.perBar[0]).toMatchObject({ opening: 0, added: 6, expectedClosing: 6 });
  });

  it('rejects a bad or inverted range', async () => {
    const a = await ownedVenue();
    const bad = await request(app).get('/api/tickets/venue/stock/reconciliation?from=nope').set('Authorization', a.auth);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('from and to must be ISO dates');
    const inverted = await request(app)
      .get('/api/tickets/venue/stock/reconciliation?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')
      .set('Authorization', a.auth);
    expect(inverted.status).toBe(400);
    expect(inverted.body.message).toBe('from must be before to');
  });

  it('serves the reconciliation PDF named after the venue', async () => {
    const a = await stockedVenue();
    const res = await request(app).get('/api/tickets/venue/stock/reconciliation.pdf').set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('stock-reconciliation-Lounge-');
  });

  it('movements and dashboard answer for the venue; reports need tickets:view_revenue', async () => {
    const a = await stockedVenue();
    const movements = await request(app).get('/api/tickets/venue/stock/movements').set('Authorization', a.auth);
    expect(movements.status).toBe(200);
    expect(movements.body.data.movements).toHaveLength(1);
    expect(movements.body.data.movements[0]).toMatchObject({ delta: 6, reason: 'receive', balanceAfter: 6 });
    expect((await request(app).get('/api/tickets/venue/stock/dashboard').set('Authorization', a.auth)).status).toBe(200);
    // A token holding only MANAGE_STOCK may write stock but not read the reports.
    expect((await request(app).get('/api/tickets/venue/stock/board').set('Authorization', a.stockOnly)).status).toBe(403);
  });
});
