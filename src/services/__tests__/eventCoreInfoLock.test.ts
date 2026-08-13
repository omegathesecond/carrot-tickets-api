import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { HttpError } from '@utils/httpError.util';

/**
 * Core "Event Information" (venue, date/time, description, category, capacity,
 * name) is owner-editable ONLY before the event is published. Once it's live,
 * changing those details is a bait-and-switch on people who already have
 * tickets, so only an administrator may do it. Ticketing/pricing settings are
 * NOT core info — organizers legitimately tune those on a live event.
 */
describe('EventService.updateEvent — core-info edits are locked after publish', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  const VENDOR = '507f1f77bcf86cd799439011';

  const makeEvent = () =>
    EventService.createEvent({
      vendorId: VENDOR, name: 'My Event', venue: 'Old Venue',
      eventDate: new Date('2030-01-01'), startTime: new Date('2030-01-01T18:00:00Z'),
      endTime: new Date('2030-01-01T22:00:00Z'), ticketTypes: [],
    } as any);

  const publish = (id: string) =>
    Event.updateOne({ _id: id }, { status: EventStatus.PUBLISHED });

  it('lets a non-admin owner change the venue while the event is a DRAFT', async () => {
    const created = await makeEvent();

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { venue: 'New Venue' } as any, false
    );
    expect(updated.venue).toBe('New Venue');
  });

  it('rejects a non-admin owner venue change once PUBLISHED, leaving the venue unchanged', async () => {
    const created = await makeEvent();
    await publish(String(created._id));

    let err: any;
    try {
      await EventService.updateEvent(String(created._id), VENDOR, { venue: 'Moved Elsewhere' } as any, false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(403);

    const reloaded = await EventService.getEventById(String(created._id), VENDOR, false);
    expect(reloaded.venue).toBe('Old Venue');
  });

  it('lets a super-admin change the venue on a PUBLISHED event', async () => {
    const created = await makeEvent();
    await publish(String(created._id));

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { venue: 'Admin Fixed Venue' } as any, true
    );
    expect(updated.venue).toBe('Admin Fixed Venue');
  });

  it('still lets a non-admin owner edit ticketing settings on a PUBLISHED event (not core info)', async () => {
    const created = await makeEvent();
    await publish(String(created._id));

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR,
      { ticketing: 'external', externalTicketUrl: 'https://tickets.example/e' } as any,
      false
    );
    expect(updated.ticketing).toBe('external');
    expect(updated.externalTicketUrl).toBe('https://tickets.example/e');
  });

  it('applies isMultiDay on update (was previously ignored)', async () => {
    const created = await makeEvent();
    expect(created.isMultiDay).toBe(false);

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { isMultiDay: true } as any, false
    );
    expect(updated.isMultiDay).toBe(true);
  });
});
