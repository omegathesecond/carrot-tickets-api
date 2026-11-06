import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { EventService } from '@services/event.service';

const VENDOR = new mongoose.Types.ObjectId().toString();
function makeEvent(overrides: Record<string, unknown> = {}) {
  return Event.create({
    vendorId: VENDOR, eventId: `EVT-${new mongoose.Types.ObjectId()}`, name: 'Nearby', venue: 'Text alone is not a location',
    eventDate: new Date('2030-01-01'), startTime: new Date('2030-01-01'), endTime: new Date('2030-01-02'),
    capacity: 0, ticketTypes: [], status: EventStatus.PUBLISHED, category: 'events',
    ...overrides,
  });
}
describe('Nearby events and coordinate persistence', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);
  it('serves only not-ended published located events within the radius, nearest first', async () => {
    await makeEvent({ name: 'Far', eventLocation: { lat: 0, lng: 1 } });
    await makeEvent({ name: 'Near', eventLocation: { lat: 0, lng: 0.01 } });
    await makeEvent({ name: 'Here', eventLocation: { lat: 0, lng: 0 } });
    await makeEvent({ name: 'No coordinates' });
    await makeEvent({ name: 'Draft', status: EventStatus.DRAFT, eventLocation: { lat: 0, lng: 0 } });
    await makeEvent({ name: 'Ended', endTime: new Date('2020-01-01'), eventLocation: { lat: 0, lng: 0 } });
    const res = await request(app).get('/api/public/events/nearby?lat=0&lng=0').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.events.map((e: any) => e.name)).toEqual(['Here', 'Near']);
    expect(res.body.data.events[1].distanceKm).toBeCloseTo(1.112, 2);
    expect(res.body.data.events[0].eventLocation).toEqual({ lat: 0, lng: 0 });
  });
  it.each(['', '?lat=0', '?lat=91&lng=0', '?lat=0&lng=NaN', '?lat=0&lng=0&radiusKm=201'])('rejects invalid location %s', async (query) => {
    await request(app).get('/api/public/events/nearby' + query).expect(400);
  });
  it('persists selected points and enforces existing live-event edit permissions', async () => {
    const event = await EventService.createEvent({
      vendorId: VENDOR, name: 'Chosen', venue: 'Venue', eventLocation: { lat: -26.3, lng: 31.1 },
      eventDate: new Date('2030-01-01'), startTime: new Date('2030-01-01'), endTime: new Date('2030-01-02'),
    });
    expect((await Event.findById(event._id))?.eventLocation?.lat).toBe(-26.3);
    await Event.updateOne({ _id: event._id }, { status: EventStatus.PUBLISHED });
    await expect(EventService.updateEvent(String(event._id), VENDOR, { eventLocation: { lat: 0, lng: 0 } }, false))
      .rejects.toMatchObject({ statusCode: 403 });
    const updated = await EventService.updateEvent(String(event._id), VENDOR, { eventLocation: { lat: 0, lng: 0 } }, true);
    expect(updated.eventLocation?.lat).toBe(0);
    await EventService.updateEvent(String(event._id), VENDOR, { eventLocation: null }, true);
    expect((await Event.findById(event._id))?.eventLocation).toBeNull();
  });
});
