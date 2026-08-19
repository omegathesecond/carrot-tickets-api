import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('GET /api/tickets/admin/organizers — operatorType + serviceCategory', () => {
  it('includes operatorType and serviceCategory on each row, and filters by ?operatorType=services', async () => {
    await Vendor.create({
      businessName: 'Luxe Decor',
      phoneNumber: '+26876000010',
      password: 'secret1',
      operatorType: OperatorType.SERVICES,
      serviceCategory: 'furniture_decor',
    });
    await Vendor.create({
      businessName: 'Big Concerts Co',
      phoneNumber: '+26876000011',
      password: 'secret1',
      operatorType: OperatorType.EVENTS,
    });

    // Unfiltered list includes both, with the new fields present.
    const all = await request(app)
      .get('/api/tickets/admin/organizers')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`);
    expect(all.status).toBe(200);
    const servicesRow = all.body.data.organizers.find((o: any) => o.businessName === 'Luxe Decor');
    expect(servicesRow.operatorType).toBe('services');
    expect(servicesRow.serviceCategory).toBe('furniture_decor');
    const eventsRow = all.body.data.organizers.find((o: any) => o.businessName === 'Big Concerts Co');
    expect(eventsRow.operatorType).toBe('events');
    expect(eventsRow.serviceCategory).toBeNull();

    // Filtered by operatorType=services returns only the services vendor.
    const filtered = await request(app)
      .get('/api/tickets/admin/organizers?operatorType=services')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.organizers).toHaveLength(1);
    expect(filtered.body.data.organizers[0].businessName).toBe('Luxe Decor');
  });

  it('ignores an invalid ?operatorType value instead of erroring', async () => {
    await Vendor.create({
      businessName: 'Big Concerts Co', phoneNumber: '+26876000012', password: 'secret1',
      operatorType: OperatorType.EVENTS,
    });
    const res = await request(app)
      .get('/api/tickets/admin/organizers?operatorType=bogus')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.organizers).toHaveLength(1);
  });
});
