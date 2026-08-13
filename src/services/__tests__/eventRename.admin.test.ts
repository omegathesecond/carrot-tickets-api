import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { HttpError } from '@utils/httpError.util';

/**
 * Renaming — and editing any core event detail — follows the "before publish"
 * rule, enforced server-side (not just hidden in the dashboard UI):
 *
 *   • While the event is a DRAFT or PENDING_APPROVAL (no tickets sold yet), the
 *     owning organizer may freely rename it — they're still getting it right.
 *   • Once the event is PUBLISHED/ONGOING, the name is locked for organizers: an
 *     organizer silently swapping the name of a live, sold event is a
 *     bait-and-switch fraud vector. Only an administrator can correct it.
 *
 * See eventCoreInfoLock.test.ts for the same rule applied to venue/date/etc.
 */
describe('EventService.updateEvent — rename follows the before-publish rule', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  const VENDOR = '507f1f77bcf86cd799439011';

  const makeEvent = (name: string) =>
    EventService.createEvent({
      vendorId: VENDOR, name, venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketTypes: [],
    } as any);

  const publish = (id: string) =>
    Event.updateOne({ _id: id }, { status: EventStatus.PUBLISHED });

  it('lets a non-admin owner rename a DRAFT event (before publish)', async () => {
    const created = await makeEvent('Working Title');

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { name: 'Final Title' } as any, false
    );
    expect(updated.name).toBe('Final Title');
  });

  it('rejects a non-admin owner rename once the event is PUBLISHED, leaving the name unchanged', async () => {
    const created = await makeEvent('Original Name');
    await publish(String(created._id));

    let err: any;
    try {
      await EventService.updateEvent(String(created._id), VENDOR, { name: 'Fraud Swap' } as any, false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(403);

    const reloaded = await EventService.getEventById(String(created._id), VENDOR, false);
    expect(reloaded.name).toBe('Original Name');
  });

  it('lets a super-admin rename a PUBLISHED event', async () => {
    const created = await makeEvent('Original Name');
    await publish(String(created._id));

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { name: 'Corrected Name' } as any, true
    );
    expect(updated.name).toBe('Corrected Name');
  });

  it('treats an unchanged name echoed by a non-admin on a PUBLISHED event as a harmless no-op', async () => {
    const created = await makeEvent('Same Name');
    await publish(String(created._id));

    // Name equals the current value, so it must NOT trip the 403 — a client
    // echoing the whole event back while editing a ticketing field is fine.
    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { name: 'Same Name', ticketing: 'external', externalTicketUrl: 'https://x.co/t' } as any, false
    );
    expect(updated.name).toBe('Same Name');
    expect(updated.ticketing).toBe('external');
  });
});
