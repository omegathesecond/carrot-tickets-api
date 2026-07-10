jest.mock('@services/push.service', () => ({
  PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@utils/buyerOnline.util', () => ({
  isBuyerOnline: jest.fn().mockResolvedValue(true),
  PRESENCE_STALE_MS: 120000,
}));
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Notification } from '@models/notification.model';
import { NotificationService } from '@services/notification.service';
import { EventReminderService } from '@services/eventReminder.service';

const PHONE = '+26878422613';

async function seedEventStartingIn(hours: number, phone = PHONE) {
  const seeded = await seedPublishedEvent();
  const start = new Date(Date.now() + hours * 60 * 60 * 1000);
  await Event.updateOne({ _id: seeded.eventId }, { eventDate: start, startTime: start });
  await Ticket.create({
    eventId: seeded.eventId, vendorId: seeded.vendorId, ticketType: 'General',
    price: 100, customerPhone: phone, status: TicketStatus.SOLD,
  });
  return seeded;
}

describe('EventReminderService.sweep', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Notification.init(); // partial unique dedupe index must exist before the race test below
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('t24 and dayof kinds fire for ticket holders; re-sweeps never duplicate', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', username: 'holder_one' });
    const t24Event = await seedEventStartingIn(23);
    const dayofEvent = await seedEventStartingIn(2);
    await seedEventStartingIn(40); // outside every window — no reminder

    await EventReminderService.sweep();
    await EventReminderService.sweep(); // idempotent

    const notes = await Notification.find({ recipientId: buyer._id, type: 'event_reminder' });
    expect(notes).toHaveLength(2);
    const byKind = Object.fromEntries(notes.map((n) => [n.data['kind'], n]));
    expect(String(byKind['t24']!.data['eventId'])).toBe(t24Event.eventId);
    expect(String(byKind['dayof']!.data['eventId'])).toBe(dayofEvent.eventId);
  });

  it('non-holders and refunded tickets get nothing; prefs.reminders=false suppresses', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1' });
    const optedOut = await Buyer.create({
      phone: '+26878000042', password: 'secret1',
      notificationPrefs: { announcements: true, dms: true, mentions: true, social: true, reminders: false },
    });
    const seeded = await seedEventStartingIn(2);
    await Ticket.create({
      eventId: seeded.eventId, vendorId: seeded.vendorId, ticketType: 'General',
      price: 100, customerPhone: '+26878000042', status: TicketStatus.SOLD,
    });
    await Ticket.updateOne({ customerPhone: PHONE }, { status: TicketStatus.REFUNDED });

    await EventReminderService.sweep();
    expect(await Notification.countDocuments({ type: 'event_reminder' })).toBe(0);
    void optedOut;
  });

  it('truncates an oversized event name so the notification title never exceeds the schema maxlength', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1' });
    const seeded = await seedEventStartingIn(2);
    await Event.updateOne({ _id: seeded.eventId }, { name: 'X'.repeat(200) });

    await EventReminderService.sweep();

    expect(await Notification.countDocuments({ type: 'event_reminder' })).toBe(1);
    const note = await Notification.findOne({ type: 'event_reminder' });
    expect(note!.title.length).toBeLessThanOrEqual(120);
  });

  it('a racing duplicate reminder insert for the same (recipient, event, kind) resolves null instead of throwing', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', username: 'holder_one' });
    const seeded = await seedEventStartingIn(2);

    await EventReminderService.sweep();
    const before = await Notification.countDocuments({ type: 'event_reminder' });
    expect(before).toBe(1);

    const result = await NotificationService.create(
      String(buyer._id),
      'event_reminder',
      'T',
      'B',
      { eventId: seeded.eventId, kind: 'dayof' }
    );

    expect(result).toBeNull();
    expect(await Notification.countDocuments({ type: 'event_reminder' })).toBe(before);
  });
});
