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
  beforeAll(connectTestDb);
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
});
