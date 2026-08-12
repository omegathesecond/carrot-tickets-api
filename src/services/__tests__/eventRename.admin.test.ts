import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';
import { HttpError } from '@utils/httpError.util';

/**
 * Renaming an event is admin-only, enforced server-side (not just hidden in the
 * dashboard UI). An organizer silently changing the name of an approved/sold
 * event is a bait-and-switch fraud vector, so even the event owner is blocked.
 */
describe('EventService.updateEvent — rename is admin-only', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  const VENDOR = '507f1f77bcf86cd799439011';

  const makeEvent = (name: string) =>
    EventService.createEvent({
      vendorId: VENDOR, name, venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketTypes: [],
    } as any);

  it('rejects a rename by a non-admin owner with a 403 and leaves the name unchanged', async () => {
    const created = await makeEvent('Original Name');

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

  it('lets a super-admin rename', async () => {
    const created = await makeEvent('Original Name');

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { name: 'Corrected Name' } as any, true
    );
    expect(updated.name).toBe('Corrected Name');
  });

  it('treats an unchanged name echoed by a non-admin as a harmless no-op', async () => {
    const created = await makeEvent('Same Name');

    // Name equals the current value, so it must NOT trip the 403 — the update
    // (here also touching venue) should still succeed.
    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { name: 'Same Name', venue: 'New Venue' } as any, false
    );
    expect(updated.name).toBe('Same Name');
    expect(updated.venue).toBe('New Venue');
  });

  it('still lets a non-admin owner update other fields', async () => {
    const created = await makeEvent('Keep This Name');

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { venue: 'Relocated' } as any, false
    );
    expect(updated.venue).toBe('Relocated');
    expect(updated.name).toBe('Keep This Name');
  });
});
