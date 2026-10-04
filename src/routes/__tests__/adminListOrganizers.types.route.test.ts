import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

type Row = { id: string; businessName: string; type: string; verificationStatus: string };

let n = 0;
async function seed(businessName: string, extra: Record<string, unknown> = {}) {
  n += 1;
  return Vendor.create({
    businessName,
    phoneNumber: `+268762${String(n).padStart(5, '0')}`,
    password: 'secret1',
    ...extra,
  });
}

async function venueFor(vendorId: unknown, status: 'active' | 'suspended' = 'active') {
  return Venue.create({ vendorId, name: 'Premises', currency: 'SZL', activatedBy: 'admin', status });
}

function list(qs = '') {
  return request(app).get(`/api/tickets/admin/organizers${qs}`).set('Authorization', `Bearer ${signSuperAdminToken()}`);
}

const names = (res: request.Response) => (res.body.data.organizers as Row[]).map((r) => r.businessName);

/** One account of every shape the type rules care about. */
async function seedMixed() {
  const out: Record<string, Awaited<ReturnType<typeof seed>>> = {};
  out['ev'] = await seed('Big Concerts', { operatorType: 'events', verificationStatus: 'verified' });
  out['both'] = await seed('Bus And Gigs', { operatorType: 'both' });
  out['tr'] = await seed('Swazi Coaches', { operatorType: 'transport', verificationStatus: 'verified' });
  out['sv1'] = await seed('Cater Kings', { operatorType: 'services', serviceCategory: 'catering', verificationStatus: 'verified' });
  out['sv2'] = await seed('Snap Studio', { operatorType: 'services', serviceCategory: 'photography' });
  // A services account that ALSO says it is a venue: services wins.
  out['svVenue'] = await seed('Hall Caterers', { operatorType: 'services', serviceCategory: 'catering', businessType: 'venue', verificationStatus: 'rejected' });
  out['vnOn'] = await seed('Rooftop Bar', { businessType: 'venue', verificationStatus: 'verified' });
  out['vnSusp'] = await seed('Garden Hall', { businessType: 'venue' });
  out['vnNone'] = await seed('Riverside Lodge', { businessType: 'venue' });
  // An events account that has been given a Venue record: venues wins.
  out['evVenue'] = await seed('Club Roofline', { operatorType: 'events', verificationStatus: 'suspended' });
  // A transport account with a Venue record: venues beats transport.
  out['trVenue'] = await seed('Depot Cafe', { operatorType: 'transport' });
  await venueFor(out['vnOn']!._id, 'active');
  await venueFor(out['vnSusp']!._id, 'suspended');
  await venueFor(out['evVenue']!._id, 'active');
  await venueFor(out['trVenue']!._id, 'active');
  return out;
}

const TYPE_OF: Record<string, string> = {
  'Big Concerts': 'events',
  'Bus And Gigs': 'events',
  'Swazi Coaches': 'transport',
  'Cater Kings': 'services',
  'Snap Studio': 'services',
  'Hall Caterers': 'services',
  'Rooftop Bar': 'venues',
  'Garden Hall': 'venues',
  'Riverside Lodge': 'venues',
  'Club Roofline': 'venues',
  'Depot Cafe': 'venues',
};
const namesOfType = (t: string) => Object.keys(TYPE_OF).filter((k) => TYPE_OF[k] === t).sort();

describe('GET /api/tickets/admin/organizers — account types', () => {
  it('classifies every row with exactly one type, in precedence order', async () => {
    await seedMixed();
    const res = await list('?limit=100');
    expect(res.status).toBe(200);
    const rows = res.body.data.organizers as Row[];
    expect(rows).toHaveLength(11);
    for (const r of rows) expect(r.type).toBe(TYPE_OF[r.businessName]);
  });

  it('a missing operatorType is an events account', async () => {
    const v = await seed('Legacy Promoter');
    await Vendor.collection.updateOne({ _id: v._id }, { $unset: { operatorType: '' } });
    const res = await list('?type=events');
    expect(names(res)).toEqual(['Legacy Promoter']);
    expect(res.body.data.organizers[0].type).toBe('events');
  });

  it.each(['events', 'venues', 'services', 'transport'])('?type=%s returns only that type, and pagination.total matches', async (type) => {
    await seedMixed();
    const res = await list(`?type=${type}&limit=100`);
    expect(res.status).toBe(200);
    expect(names(res).sort()).toEqual(namesOfType(type));
    for (const r of res.body.data.organizers as Row[]) expect(r.type).toBe(type);
    expect(res.body.data.pagination.total).toBe(namesOfType(type).length);
  });

  it('an empty ?type= means all types', async () => {
    await seedMixed();
    const res = await list('?type=&limit=100');
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(11);
  });

  it('keeps the existing per-row fields', async () => {
    await seedMixed();
    const res = await list('?type=venues&search=rooftop');
    const row = res.body.data.organizers[0];
    expect(row).toMatchObject({
      businessName: 'Rooftop Bar',
      businessType: 'venue',
      verificationStatus: 'verified',
      eventCount: 0,
      ticketsSold: 0,
      revenue: 0,
      venue: { name: 'Premises', currency: 'SZL', status: 'active' },
    });
    expect(Object.keys(row)).toEqual(expect.arrayContaining([
      'id', 'email', 'phoneNumber', 'primaryContact', 'operatorType', 'serviceCategory',
      'verifiedAt', 'rejectionReason', 'isActive', 'createdAt', 'type',
    ]));
  });

  it('search composes with the venue rule instead of clobbering it', async () => {
    await seedMixed();
    // Both the venue rule and the search use $or internally; a naive merge would
    // let one overwrite the other.
    const res = await list('?type=venues&search=roof');
    expect(names(res).sort()).toEqual(['Club Roofline', 'Rooftop Bar']);
    const ev = await list('?type=events&search=roof');
    expect(names(ev)).toEqual([]);
    const all = await list('?search=hall');
    expect(names(all).sort()).toEqual(['Garden Hall', 'Hall Caterers']);
  });

  it('?status filters verification status within a type', async () => {
    await seedMixed();
    const res = await list('?type=services&status=verified');
    expect(names(res)).toEqual(['Cater Kings']);
  });
});

describe('typeCounts', () => {
  it('counts accounts per type; all is the sum', async () => {
    await seedMixed();
    const res = await list();
    expect(res.body.data.typeCounts).toEqual({ all: 11, events: 2, venues: 5, services: 3, transport: 1 });
  });

  it('ignores status, search and type', async () => {
    await seedMixed();
    const base = (await list()).body.data.typeCounts;
    for (const qs of ['?type=services', '?status=verified', '?search=zzzz-nothing', '?type=venues&venueTrading=on&status=suspended', '?type=services&category=catering&search=cater']) {
      expect((await list(qs)).body.data.typeCounts).toEqual(base);
    }
  });

  it('is all zeros on an empty directory', async () => {
    const res = await list();
    expect(res.body.data.typeCounts).toEqual({ all: 0, events: 0, venues: 0, services: 0, transport: 0 });
    expect(res.body.data.statusCounts).toEqual({});
    expect(res.body.data.serviceCategories).toEqual([]);
    expect(res.body.data.pagination).toMatchObject({ total: 0, totalPages: 0 });
  });
});

describe('statusCounts', () => {
  it('covers all types when no type is requested', async () => {
    await seedMixed();
    const res = await list();
    // verified: Big Concerts, Swazi Coaches, Cater Kings, Rooftop Bar; rejected: Hall Caterers;
    // suspended: Club Roofline; the other five default to pending.
    expect(res.body.data.statusCounts).toEqual({ verified: 4, rejected: 1, suspended: 1, pending: 5 });
  });

  it('is scoped to the requested type', async () => {
    await seedMixed();
    expect((await list('?type=services')).body.data.statusCounts).toEqual({ verified: 1, rejected: 1, pending: 1 });
    expect((await list('?type=venues')).body.data.statusCounts).toEqual({ verified: 1, suspended: 1, pending: 3 });
    expect((await list('?type=events')).body.data.statusCounts).toEqual({ verified: 1, pending: 1 });
    expect((await list('?type=transport')).body.data.statusCounts).toEqual({ verified: 1 });
  });

  it('ignores status, search, venueTrading and category so the chips stay stable', async () => {
    await seedMixed();
    const services = (await list('?type=services')).body.data.statusCounts;
    expect((await list('?type=services&status=pending&category=catering&search=snap')).body.data.statusCounts).toEqual(services);
    const venues = (await list('?type=venues')).body.data.statusCounts;
    expect((await list('?type=venues&venueTrading=none&status=verified')).body.data.statusCounts).toEqual(venues);
  });
});

describe('venueTrading', () => {
  it('on = Venue active, suspended = Venue suspended, none = venue account with no Venue record', async () => {
    await seedMixed();
    expect(names(await list('?type=venues&venueTrading=on')).sort()).toEqual(['Club Roofline', 'Depot Cafe', 'Rooftop Bar']);
    expect(names(await list('?type=venues&venueTrading=suspended'))).toEqual(['Garden Hall']);
    expect(names(await list('?type=venues&venueTrading=none'))).toEqual(['Riverside Lodge']);
  });

  it('pagination.total follows the venueTrading filter', async () => {
    await seedMixed();
    expect((await list('?type=venues&venueTrading=on')).body.data.pagination.total).toBe(3);
    expect((await list('?type=venues&venueTrading=none')).body.data.pagination.total).toBe(1);
  });

  it('a services account with a Venue record is not a venue-trading account', async () => {
    const sv = await seed('Hall Caterers', { operatorType: 'services', serviceCategory: 'catering', businessType: 'venue' });
    await venueFor(sv._id, 'active');
    expect(names(await list('?type=venues&venueTrading=on'))).toEqual([]);
    expect(names(await list('?type=venues&venueTrading=none'))).toEqual([]);
  });
});

describe('category + serviceCategories', () => {
  it('?category filters service businesses by exact serviceCategory', async () => {
    await seedMixed();
    expect(names(await list('?type=services&category=catering')).sort()).toEqual(['Cater Kings', 'Hall Caterers']);
    expect(names(await list('?type=services&category=photography'))).toEqual(['Snap Studio']);
    expect(names(await list('?type=services&category=cater'))).toEqual([]);
    expect(names(await list('?type=services&category=Catering'))).toEqual([]);
  });

  it('serviceCategories lists the distinct categories in use by services, sorted A-Z', async () => {
    await seed('Z Tents', { operatorType: 'services', serviceCategory: 'tents' });
    await seed('A Cater', { operatorType: 'services', serviceCategory: 'catering' });
    await seed('B Cater', { operatorType: 'services', serviceCategory: 'catering' });
    await seed('Snap', { operatorType: 'services', serviceCategory: 'photography' });
    // An events account carrying a stray category is not a service business.
    await seed('Stray', { operatorType: 'events', serviceCategory: 'legacy_stray' });
    const res = await list();
    expect(res.body.data.serviceCategories).toEqual(['catering', 'photography', 'tents']);
  });

  it('serviceCategories ignores every filter', async () => {
    await seedMixed();
    const base = (await list()).body.data.serviceCategories;
    expect(base).toEqual(['catering', 'photography']);
    expect((await list('?type=events&status=verified&search=big')).body.data.serviceCategories).toEqual(base);
    expect((await list('?type=services&category=photography')).body.data.serviceCategories).toEqual(base);
  });
});

describe('sort', () => {
  async function seedDated() {
    await seed('banana', { createdAt: new Date('2026-01-02T00:00:00Z') });
    await seed('Apple', { createdAt: new Date('2026-01-03T00:00:00Z') });
    await seed('cherry', { createdAt: new Date('2026-01-01T00:00:00Z') });
    await seed('Blueberry', { createdAt: new Date('2026-01-04T00:00:00Z') });
  }

  it('newest is the default: createdAt descending', async () => {
    await seedDated();
    expect(names(await list())).toEqual(['Blueberry', 'Apple', 'banana', 'cherry']);
    expect(names(await list('?sort=newest'))).toEqual(['Blueberry', 'Apple', 'banana', 'cherry']);
  });

  it('oldest is createdAt ascending', async () => {
    await seedDated();
    expect(names(await list('?sort=oldest'))).toEqual(['cherry', 'banana', 'Apple', 'Blueberry']);
  });

  it('name is businessName A-Z, case-insensitive', async () => {
    await seedDated();
    expect(names(await list('?sort=name'))).toEqual(['Apple', 'banana', 'Blueberry', 'cherry']);
  });

  it('the name collation does not make other filters case-insensitive', async () => {
    await seedMixed();
    expect(names(await list('?type=services&category=Catering&sort=name'))).toEqual([]);
  });

  it('an empty ?sort= is the default', async () => {
    await seedDated();
    expect(names(await list('?sort='))).toEqual(['Blueberry', 'Apple', 'banana', 'cherry']);
  });
});

describe('pagination is over the filtered set', () => {
  it('a type filter fills page 1 with that type only (was: filtered after paginating)', async () => {
    // Interleave so a post-pagination filter would starve page 1 of services.
    for (let i = 0; i < 7; i += 1) {
      await seed(`Service ${i}`, { operatorType: 'services', serviceCategory: 'catering', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i * 2)) });
      await seed(`Event ${i}`, { operatorType: 'events', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i * 2 + 1)) });
      await seed(`Venue ${i}`, { businessType: 'venue', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i * 2 + 1, 30)) });
    }
    const p1 = await list('?type=services&limit=3&page=1');
    expect(names(p1)).toHaveLength(3);
    for (const r of p1.body.data.organizers as Row[]) expect(r.type).toBe('services');
    expect(p1.body.data.pagination).toEqual({ page: 1, limit: 3, total: 7, totalPages: 3 });

    const p2 = await list('?type=services&limit=3&page=2');
    const p3 = await list('?type=services&limit=3&page=3');
    expect(names(p2)).toHaveLength(3);
    expect(names(p3)).toHaveLength(1);
    const seen = [...names(p1), ...names(p2), ...names(p3)];
    expect(new Set(seen).size).toBe(7);
    expect(seen.every((x) => x.startsWith('Service '))).toBe(true);
    // newest-first across pages
    expect(seen).toEqual(['Service 6', 'Service 5', 'Service 4', 'Service 3', 'Service 2', 'Service 1', 'Service 0']);
  });

  it('pagination holds with a venueTrading filter too', async () => {
    for (let i = 0; i < 5; i += 1) {
      const v = await seed(`Venue ${i}`, { businessType: 'venue', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) });
      if (i % 2 === 0) await venueFor(v._id, 'active');
    }
    await seed('Noise', { operatorType: 'events' });
    const p1 = await list('?type=venues&venueTrading=on&limit=2&page=1');
    const p2 = await list('?type=venues&venueTrading=on&limit=2&page=2');
    expect(names(p1)).toEqual(['Venue 4', 'Venue 2']);
    expect(names(p2)).toEqual(['Venue 0']);
    expect(p1.body.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it('ties on createdAt still paginate without duplicates or gaps', async () => {
    const same = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i += 1) await seed(`Tie ${i}`, { createdAt: same });
    const pages = await Promise.all([1, 2, 3].map((p) => list(`?limit=2&page=${p}`)));
    const seen = pages.flatMap(names);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

describe('fails loudly on a bad query (400, exact messages)', () => {
  it.each([
    ['?type=bogus', 'Unknown organizer type'],
    ['?status=bogus', 'Unknown verification status'],
    ['?sort=bogus', 'Unknown sort'],
    ['?type=venues&venueTrading=bogus', 'Unknown venue trading filter'],
    ['?venueTrading=on', 'venueTrading needs type=venues'],
    ['?type=events&venueTrading=on', 'venueTrading needs type=venues'],
    ['?category=catering', 'category needs type=services'],
    ['?type=venues&category=catering', 'category needs type=services'],
    ['?type=events&type=venues', 'Unknown organizer type'],
  ])('%s -> 400 %s', async (qs, message) => {
    await seedMixed();
    const res = await list(qs);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(message);
  });

  it('the removed operatorType param no longer filters', async () => {
    await seedMixed();
    const res = await list('?operatorType=services&limit=100');
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(11);
  });

  // Express parses with allowPrototypes, so `x[toString]=y` is an object whose
  // String() throws; that used to escape the handler and kill the process.
  it.each([
    ['?type[toString]=x', 'Unknown organizer type'],
    ['?type[]=events', 'Unknown organizer type'],
    ['?status[a]=b', 'Unknown verification status'],
    ['?sort[]=name', 'Unknown sort'],
    ['?type=venues&venueTrading[a]=b', 'Unknown venue trading filter'],
    ['?search[a]=b', 'Invalid search'],
    ['?search[toString]=x', 'Invalid search'],
    ['?type=services&category[a]=b', 'Invalid category'],
    ['?page[x]=1', 'Invalid page'],
    ['?limit[toString]=1', 'Invalid limit'],
    ['?search=a&search=b', 'Invalid search'],
  ])('a non-text param %s is a 400 %s, and the API keeps serving', async (qs, message) => {
    await seedMixed();
    const res = await list(qs);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    const after = await list('?limit=100');
    expect(after.status).toBe(200);
    expect(after.body.data.pagination.total).toBe(11);
  });

  it('is still super-admin only', async () => {
    const res = await request(app).get('/api/tickets/admin/organizers');
    expect([401, 403]).toContain(res.status);
  });
});

describe('the super-admin account', () => {
  it('is never listed or counted, whatever its shape', async () => {
    await seed('Platform Owner', { isSuperAdmin: true, operatorType: 'events', verificationStatus: 'verified' });
    await seed('Platform Venue', { isSuperAdmin: true, businessType: 'venue', verificationStatus: 'verified' });
    await seed('Real Org', { operatorType: 'events' });
    const res = await list();
    expect(names(res)).toEqual(['Real Org']);
    expect(res.body.data.typeCounts).toEqual({ all: 1, events: 1, venues: 0, services: 0, transport: 0 });
    expect(res.body.data.statusCounts).toEqual({ pending: 1 });
    expect(res.body.data.pagination.total).toBe(1);

    const ev = await list('?type=events');
    expect(names(ev)).toEqual(['Real Org']);
    expect(ev.body.data.statusCounts).toEqual({ pending: 1 });
    expect(names(await list('?type=venues'))).toEqual([]);
    expect((await list('?search=platform')).body.data.organizers).toHaveLength(0);
  });
});
