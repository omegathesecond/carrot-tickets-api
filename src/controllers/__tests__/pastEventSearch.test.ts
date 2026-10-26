import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import publicRoutes from '@routes/public.route';

const app = express();
app.use('/api/public', publicRoutes);
beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('searches past, archived and upcoming names, keeps All unchanged and opens archive results', async () => {
  const seed = (name: string, days: number, status: string) => Event.create({
    name, venue: 'Test venue', vendorId: new mongoose.Types.ObjectId(), status,
    eventDate: new Date(Date.now() + days * 86400000),
    startTime: new Date(Date.now() + days * 86400000),
    endTime: new Date(Date.now() + days * 86400000 + 3600000),
  });
  const past = await seed('Eswatini   Farmers Market', -10, 'published');
  const archived = await seed('Eswatini Farmers Market archive', -20, 'completed');
  await seed('Upcoming Summer Festival', 10, 'published');
  await seed('Eswatini Farmers Market draft', 10, 'draft');
  const search = await request(app).get('/api/public/events').query({ search: '  eSwAtInI  farmers   market  ' });
  expect(search.status).toBe(200);
  expect(search.body.data.events.map((e: any) => e._id).sort()).toEqual([past.id, archived.id].sort());
  expect(search.body.data.events.find((e: any) => e._id === archived.id).status).toBe('completed');
  const all = await request(app).get('/api/public/events');
  expect(all.body.data.events.map((e: any) => e.name)).toEqual(['Upcoming Summer Festival']);
  const upcoming = await request(app).get('/api/public/events').query({ search: 'upcoming summer' });
  expect(upcoming.body.data.events).toHaveLength(1);
  const none = await request(app).get('/api/public/events').query({ search: 'Market.*' });
  expect(none.body.data.events).toEqual([]);
  const detail = await request(app).get(`/api/public/events/${archived.id}`);
  expect(detail.status).toBe(200);
});
