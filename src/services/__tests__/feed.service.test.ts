import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { getFeed } from '@services/feed.service';
import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import mongoose from 'mongoose';

async function seedReadyUpdate(caption: string) {
  return Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption, media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } } });
}
async function seedEvent(name: string, status: EventStatus = EventStatus.PUBLISHED) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  return Event.create({
    vendorId: vendor._id, name, venue: 'V', eventDate: new Date(Date.now() + 86400000),
    startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status, ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
}
async function seedCompletedSale(eventId: mongoose.Types.ObjectId, vendorId: mongoose.Types.ObjectId) {
  return TicketSale.create({
    eventId, vendorId, quantity: 1, totalAmount: 100,
    paymentMethod: PaymentMethod.CASH, paymentStatus: PaymentStatus.COMPLETED,
    channel: SalesChannel.BOX_OFFICE, soldBy: vendorId, soldByType: 'Vendor',
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

  it('paginates the events tab via the $skip-based event cursor without repeating items', async () => {
    for (let i = 0; i < 10; i++) await seedEvent('E' + i);
    const p1 = await getFeed({ tab: 'events', limit: 4 });
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await getFeed({ tab: 'events', limit: 4, cursor: p1.nextCursor! });
    const p1ids = new Set(p1.items.map((i) => i.id));
    expect(p2.items.every((i) => !p1ids.has(i.id))).toBe(true);
  });

  it('gates activity slides on published events and carries eventName', async () => {
    const published = await seedEvent('Published Show');
    await seedCompletedSale(published._id, published.vendorId);

    const cancelled = await seedEvent('Cancelled Show', EventStatus.CANCELLED);
    await seedCompletedSale(cancelled._id, cancelled.vendorId);

    const { items } = await getFeed({ tab: 'for-you', limit: 30 });
    const activitySlides = items.filter((i) => i.type === 'activity');

    const publishedSlide = activitySlides.find((s) => s.eventId === String(published._id));
    expect(publishedSlide).toBeDefined();
    expect(publishedSlide!.eventName).toBe('Published Show');

    expect(activitySlides.some((s) => s.eventId === String(cancelled._id))).toBe(false);
  });

  it('following tab includes updates authored by a followed organizer', async () => {
    const vendor = await Vendor.create({ businessName: 'Followed Org', password: 'password123', slug: 'followed-org' });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'password123' });

    const orgUpdate = await Update.create({
      authorType: 'vendor', authorId: vendor._id, kind: 'image', caption: 'org update',
      media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } },
    });

    // Without a follow, the following tab must NOT surface the organizer's update.
    const before = await getFeed({ tab: 'following', buyerId: String(buyer._id), limit: 8 });
    expect(before.items.some((i) => i.id === String(orgUpdate._id))).toBe(false);

    await Follow.create({ followerId: buyer._id, targetType: 'organizer', targetId: vendor._id });

    const after = await getFeed({ tab: 'following', buyerId: String(buyer._id), limit: 8 });
    const slide = after.items.find((i) => i.id === String(orgUpdate._id));
    expect(slide).toBeDefined();
    expect(slide!.type).toBe('update');
  });
});
