import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { getFeed } from '@services/feed.service';
import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { EventStatus } from '@interfaces/event.interface';
import mongoose from 'mongoose';

async function seedReadyUpdate(caption: string) {
  return Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption, media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } } });
}
async function seedEvent(name: string) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  return Event.create({
    vendorId: vendor._id, name, venue: 'V', eventDate: new Date(Date.now() + 86400000),
    startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
}

describe('feed.service getFeed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns a blended for-you feed containing updates and events', async () => {
    await seedReadyUpdate('u1'); await seedReadyUpdate('u2'); await seedReadyUpdate('u3');
    await seedEvent('E1');
    const { items } = await getFeed({ tab: 'for-you', limit: 8 });
    const types = items.map((i) => i.type);
    expect(types).toContain('update');
    expect(types).toContain('event');
  });

  it('excludes non-ready updates from the feed', async () => {
    await Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'video', caption: 'processing', media: { rawKey: 'k', status: 'processing' } });
    const { items } = await getFeed({ tab: 'for-you', limit: 8 });
    expect(items.find((i) => i.type === 'update')).toBeUndefined();
  });

  it('events tab returns only event slides', async () => {
    await seedReadyUpdate('u1'); await seedEvent('E1');
    const { items } = await getFeed({ tab: 'events', limit: 8 });
    expect(items.every((i) => i.type === 'event')).toBe(true);
  });

  it('paginates via nextCursor without repeating items', async () => {
    for (let i = 0; i < 10; i++) await seedReadyUpdate('u' + i);
    const p1 = await getFeed({ tab: 'for-you', limit: 4 });
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await getFeed({ tab: 'for-you', limit: 4, cursor: p1.nextCursor! });
    const p1ids = new Set(p1.items.map((i) => i.id));
    expect(p2.items.every((i) => !p1ids.has(i.id))).toBe(true);
  });
});
