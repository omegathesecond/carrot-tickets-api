import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';

// Spec §11: event.cashless is settable through the create/update event API,
// not just by a direct DB write. Since a64b631 it is ALSO admin-only — turning
// it on commits Carrot to settling real money, so an organizer asks (see
// EventService.requestCashless) and an admin grants.
//
// These tests originally ran without isSuperAdmin, from when any organizer
// could set the flag. They now pass it where the subject is the passthrough,
// and assert the refusal where the subject is the gate.
const VENDOR = '507f1f77bcf86cd799439011';

const base = (name: string) => ({
  vendorId: VENDOR, name, venue: 'V',
  eventDate: new Date(), startTime: new Date(), endTime: new Date(),
  ticketTypes: [],
});

describe('EventService cashless passthrough (admin)', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('persists cashless: true on create', async () => {
    const e = await EventService.createEvent({
      ...base('X'), cashless: true, isSuperAdmin: true,
    } as any);
    expect(e.cashless).toBe(true);
  });

  it('defaults cashless to false when not specified on create', async () => {
    const e = await EventService.createEvent({ ...base('Y') } as any);
    expect(e.cashless).toBe(false);
  });

  it('sets cashless: true via update', async () => {
    const created = await EventService.createEvent({ ...base('Z') } as any);
    expect(created.cashless).toBe(false);

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { cashless: true } as any, true,
    );
    expect(updated.cashless).toBe(true);
  });

  it('unsets cashless: false via update while no money has moved', async () => {
    const created = await EventService.createEvent({
      ...base('W'), cashless: true, isSuperAdmin: true,
    } as any);
    expect(created.cashless).toBe(true);

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { cashless: false } as any, true,
    );
    expect(updated.cashless).toBe(false);
  });
});

// The gate itself. This is the half that had no coverage: the suite above
// proves an admin CAN, and nothing proved anyone else cannot — so removing
// either check would have left the whole file green.
describe('EventService cashless is admin-only', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('refuses an organizer creating an event already cashless', async () => {
    await expect(
      EventService.createEvent({ ...base('NoAdminCreate'), cashless: true } as any),
    ).rejects.toThrow('Only an administrator can enable cashless for an event');
  });

  it('creates nothing when it refuses', async () => {
    await expect(
      EventService.createEvent({ ...base('Rejected'), cashless: true } as any),
    ).rejects.toThrow();

    const { Event } = await import('@models/event.model');
    expect(await Event.countDocuments({ name: 'Rejected' })).toBe(0);
  });

  it('refuses an organizer switching cashless on', async () => {
    const created = await EventService.createEvent({ ...base('NoAdminUpdate') } as any);

    await expect(
      EventService.updateEvent(String(created._id), VENDOR, { cashless: true } as any),
    ).rejects.toThrow("Only an administrator can change an event's cashless setting");
  });

  it('leaves the flag untouched when it refuses an update', async () => {
    const created = await EventService.createEvent({ ...base('Untouched') } as any);

    await expect(
      EventService.updateEvent(String(created._id), VENDOR, { cashless: true } as any),
    ).rejects.toThrow();

    const { Event } = await import('@models/event.model');
    const reloaded = await Event.findById(created._id);
    expect(reloaded!.cashless).toBe(false);
  });

  it('lets an organizer update other fields without tripping the gate', async () => {
    const created = await EventService.createEvent({ ...base('OtherFields') } as any);

    // `cashless` absent (not false) must not read as a change — otherwise
    // every ordinary organizer edit would 403.
    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { venue: 'New Venue' } as any,
    );
    expect(updated.venue).toBe('New Venue');
    expect(updated.cashless).toBe(false);
  });
});
