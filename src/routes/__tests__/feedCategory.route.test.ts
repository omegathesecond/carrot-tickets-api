import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import { EventStatus } from '@interfaces/event.interface';

jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn(), reconcileStuckUpdates: jest.fn() }));

describe('GET /api/public/feed?category=', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const common = () => ({
    vendorId: new mongoose.Types.ObjectId(),
    venue: 'V',
    eventDate: new Date(Date.now() + 8.64e7),
    startTime: new Date(Date.now() + 8.64e7),
    endTime: new Date(Date.now() + 9e7),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }],
  });

  it('returns only event slides of the requested category', async () => {
    await Event.create({ ...common(), name: 'MusicEvt', category: 'Music' });
    await Event.create({ ...common(), name: 'TechEvt', category: 'Tech' });

    const res = await request(app).get('/api/public/feed?tab=events&category=Music').expect(200);
    const eventNames = res.body.data.items.filter((s: any) => s.type === 'event').map((s: any) => s.name);
    expect(eventNames).toContain('MusicEvt');
    expect(eventNames).not.toContain('TechEvt');
  });

  it('drops update slides whose linked event is not in the requested category, and updates with no eventId', async () => {
    const musicEvent = await Event.create({ ...common(), name: 'MusicEvt', category: 'Music' });
    const techEvent = await Event.create({ ...common(), name: 'TechEvt', category: 'Tech' });
    const media = { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } };

    await Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: 'music update', media, eventId: musicEvent._id });
    await Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: 'tech update', media, eventId: techEvent._id });
    await Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: 'no event update', media });

    const res = await request(app).get('/api/public/feed?tab=for-you&category=Music').expect(200);
    const captions = res.body.data.items.filter((s: any) => s.type === 'update').map((s: any) => s.caption);
    expect(captions).toContain('music update');
    expect(captions).not.toContain('tech update');
    expect(captions).not.toContain('no event update');
  });

  it('behaves unchanged when category is absent or All', async () => {
    await Event.create({ ...common(), name: 'MusicEvt', category: 'Music' });
    await Event.create({ ...common(), name: 'TechEvt', category: 'Tech' });

    const resNoFilter = await request(app).get('/api/public/feed?tab=events').expect(200);
    const namesNoFilter = resNoFilter.body.data.items.filter((s: any) => s.type === 'event').map((s: any) => s.name);
    expect(namesNoFilter).toEqual(expect.arrayContaining(['MusicEvt', 'TechEvt']));

    const resAll = await request(app).get('/api/public/feed?tab=events&category=All').expect(200);
    const namesAll = resAll.body.data.items.filter((s: any) => s.type === 'event').map((s: any) => s.name);
    expect(namesAll).toEqual(expect.arrayContaining(['MusicEvt', 'TechEvt']));
  });

  it('exposes category on event slides, falling back to Other for legacy events with no category', async () => {
    await Event.create({ ...common(), name: 'MusicEvt', category: 'Music' });
    await Event.create({ ...common(), name: 'LegacyEvt' }); // no category field, mirrors pre-migration docs

    const res = await request(app).get('/api/public/feed?tab=events').expect(200);
    const slides = res.body.data.items.filter((s: any) => s.type === 'event');
    expect(slides.find((s: any) => s.name === 'MusicEvt').category).toBe('Music');
    expect(slides.find((s: any) => s.name === 'LegacyEvt').category).toBe('Other');
  });
});
