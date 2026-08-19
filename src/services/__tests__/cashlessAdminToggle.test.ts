import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';
import { Event } from '@models/event.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { LedgerAccountType } from '@interfaces/ledger.interface';
import { EventStatus } from '@interfaces/event.interface';

/**
 * `cashless` is not an ordinary event setting: switching it on commits Carrot
 * to bands, handhelds, a float and a settlement run, so only an administrator
 * may change it. Switching it OFF is guarded by an invariant rather than a
 * permission — once any money has moved on the event, unsetting the flag would
 * strand funded bands behind "Event is not cashless", so nobody may do it.
 */
describe('EventService — cashless is an admin switch', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  const VENDOR = '507f1f77bcf86cd799439011';

  const makeEvent = (extra: Record<string, unknown> = {}) =>
    EventService.createEvent({
      vendorId: VENDOR, name: 'My Event', venue: 'Somewhere',
      eventDate: new Date('2030-01-01'), startTime: new Date('2030-01-01T18:00:00Z'),
      endTime: new Date('2030-01-01T22:00:00Z'), ticketTypes: [], ...extra,
    } as any);

  /** One posting is enough — any entry means money moved on this event. */
  const postToLedger = (eventId: string) =>
    LedgerEntry.create({
      eventId, txnId: 'txn-1', accountType: LedgerAccountType.FLOAT,
      accountRef: null, delta: 5000, refType: 'topup', refId: 'top-1',
    });

  describe('enabling', () => {
    it('rejects a non-admin turning cashless on, leaving the flag off', async () => {
      const created = await makeEvent();

      await expect(
        EventService.updateEvent(String(created._id), VENDOR, { cashless: true } as any, false),
      ).rejects.toThrow(/administrator/i);

      const after = await Event.findById(created._id);
      expect(after!.cashless).toBe(false);
    });

    it('lets an admin turn cashless on', async () => {
      const created = await makeEvent();

      const updated = await EventService.updateEvent(
        String(created._id), VENDOR, { cashless: true } as any, true,
      );
      expect(updated.cashless).toBe(true);
    });

    it('rejects a non-admin creating an event already marked cashless', async () => {
      await expect(makeEvent({ cashless: true })).rejects.toThrow(/administrator/i);
    });

    it('ignores a non-admin echoing back the value the event already has', async () => {
      // The edit form may PUT every field it loaded; re-sending the current
      // value changes nothing and must not read as an attempt to switch.
      const created = await makeEvent();

      const updated = await EventService.updateEvent(
        String(created._id), VENDOR, { cashless: false, venue: 'New Venue' } as any, false,
      );
      expect(updated.venue).toBe('New Venue');
      expect(updated.cashless).toBe(false);
    });
  });

  describe('disabling', () => {
    it('lets an admin turn cashless off while no money has moved', async () => {
      const created = await makeEvent();
      await EventService.updateEvent(String(created._id), VENDOR, { cashless: true } as any, true);

      const updated = await EventService.updateEvent(
        String(created._id), VENDOR, { cashless: false } as any, true,
      );
      expect(updated.cashless).toBe(false);
    });

    it('refuses even an admin once the ledger has an entry, leaving cashless on', async () => {
      const created = await makeEvent();
      await EventService.updateEvent(String(created._id), VENDOR, { cashless: true } as any, true);
      await postToLedger(String(created._id));

      await expect(
        EventService.updateEvent(String(created._id), VENDOR, { cashless: false } as any, true),
      ).rejects.toThrow(/money has already moved/i);

      const after = await Event.findById(created._id);
      expect(after!.cashless).toBe(true);
    });
  });

  describe('organizer request', () => {
    it('stamps the request on the event', async () => {
      const created = await makeEvent();

      const updated = await EventService.requestCashless(
        String(created._id), VENDOR, 'We want tap-to-pay bars',
      );
      expect(updated.cashlessRequestedAt).toBeInstanceOf(Date);
      expect(updated.cashlessRequestNote).toBe('We want tap-to-pay bars');
    });

    it('re-requesting updates the note instead of stacking a second request', async () => {
      const created = await makeEvent();
      const first = await EventService.requestCashless(String(created._id), VENDOR, 'First ask');
      const second = await EventService.requestCashless(String(created._id), VENDOR, 'Revised ask');

      expect(second.cashlessRequestNote).toBe('Revised ask');
      expect(second.cashlessRequestedAt!.getTime()).toBeGreaterThanOrEqual(
        first.cashlessRequestedAt!.getTime(),
      );
    });

    it('clears the request when an admin grants it', async () => {
      const created = await makeEvent();
      await EventService.requestCashless(String(created._id), VENDOR, 'Please');

      const granted = await EventService.updateEvent(
        String(created._id), VENDOR, { cashless: true } as any, true,
      );
      expect(granted.cashless).toBe(true);
      expect(granted.cashlessRequestedAt ?? null).toBeNull();
    });

    it('refuses a request on an event that is already cashless', async () => {
      const created = await makeEvent();
      await EventService.updateEvent(String(created._id), VENDOR, { cashless: true } as any, true);

      await expect(
        EventService.requestCashless(String(created._id), VENDOR, 'Please'),
      ).rejects.toThrow(/already cashless/i);
    });

    it('refuses a request from a vendor that does not own the event', async () => {
      const created = await makeEvent();

      await expect(
        EventService.requestCashless(String(created._id), '507f1f77bcf86cd799439099', 'Mine now'),
      ).rejects.toThrow(/not found/i);
    });
  });

  it('still lets an admin edit a cancelled-free published event without touching cashless', async () => {
    const created = await makeEvent();
    await Event.updateOne({ _id: created._id }, { status: EventStatus.PUBLISHED });

    const updated = await EventService.updateEvent(
      String(created._id), VENDOR, { venue: 'Admin Fix' } as any, true,
    );
    expect(updated.venue).toBe('Admin Fix');
  });
});
