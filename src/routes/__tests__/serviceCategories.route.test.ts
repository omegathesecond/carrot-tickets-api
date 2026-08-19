import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken, signVendorToken } from '../../__tests__/helpers/auth';
import { ServiceCategory } from '@models/serviceCategory.model';
import { seedServiceCategories } from '../../scripts/seed-service-categories';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('GET /api/public/service-categories', () => {
  it('returns the seeded, active list sorted by order', async () => {
    await seedServiceCategories();

    const res = await request(app).get('/api/public/service-categories');
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toHaveLength(11);
    expect(res.body.data.categories[0]).toMatchObject({ value: 'sound_hire', label: 'Sound hire' });
  });

  it('excludes a disabled category', async () => {
    await seedServiceCategories();
    await ServiceCategory.updateOne({ value: 'sound_hire' }, { $set: { isActive: false } });

    const res = await request(app).get('/api/public/service-categories');
    expect(res.status).toBe(200);
    const values = res.body.data.categories.map((c: any) => c.value);
    expect(values).not.toContain('sound_hire');
    expect(values).toHaveLength(10);
  });
});

describe('GET /api/tickets/admin/service-categories', () => {
  it('super-admin sees all rows including inactive ones', async () => {
    await ServiceCategory.create({ value: 'active_one', label: 'Active One', order: 0, isActive: true });
    await ServiceCategory.create({ value: 'inactive_one', label: 'Inactive One', order: 1, isActive: false });

    const res = await request(app)
      .get('/api/tickets/admin/service-categories')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.categories.map((c: any) => c.value).sort()).toEqual(['active_one', 'inactive_one']);
  });

  it('rejects a non-super-admin (403)', async () => {
    const res = await request(app)
      .get('/api/tickets/admin/service-categories')
      .set('Authorization', `Bearer ${signVendorToken('000000000000000000000001')}`);
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/tickets/admin/service-categories');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/tickets/admin/service-categories', () => {
  it('super-admin creates a category, normalizing value to lowercase', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/service-categories')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ value: 'Bouncy_Castle', label: 'Bouncy castle', order: 5 });
    expect(res.status).toBe(201);
    expect(res.body.data.category).toMatchObject({ value: 'bouncy_castle', label: 'Bouncy castle', order: 5, isActive: true });
  });

  it('rejects a duplicate value (409)', async () => {
    await ServiceCategory.create({ value: 'sound_hire', label: 'Sound hire', order: 0 });
    const res = await request(app)
      .post('/api/tickets/admin/service-categories')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ value: 'sound_hire', label: 'Sound Hire Duplicate' });
    expect(res.status).toBe(409);
  });

  it('rejects a missing label (400)', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/service-categories')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ value: 'no_label' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-super-admin (403)', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/service-categories')
      .set('Authorization', `Bearer ${signVendorToken('000000000000000000000001')}`)
      .send({ value: 'x', label: 'X' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/tickets/admin/service-categories/:id', () => {
  it('super-admin updates label/order/isActive but not value', async () => {
    const created = await ServiceCategory.create({ value: 'sound_hire', label: 'Sound hire', order: 0 });

    const res = await request(app)
      .patch(`/api/tickets/admin/service-categories/${created._id}`)
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ label: 'Sound Hire (Renamed)', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.category).toMatchObject({ value: 'sound_hire', label: 'Sound Hire (Renamed)', isActive: false });
  });

  it('404s for a missing id', async () => {
    const res = await request(app)
      .patch('/api/tickets/admin/service-categories/000000000000000000000000')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ label: 'X' });
    expect(res.status).toBe(404);
  });

  it('rejects a non-super-admin (403)', async () => {
    const created = await ServiceCategory.create({ value: 'sound_hire', label: 'Sound hire', order: 0 });
    const res = await request(app)
      .patch(`/api/tickets/admin/service-categories/${created._id}`)
      .set('Authorization', `Bearer ${signVendorToken('000000000000000000000001')}`)
      .send({ label: 'X' });
    expect(res.status).toBe(403);
  });
});
