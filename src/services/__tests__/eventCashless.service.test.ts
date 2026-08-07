import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';

// Spec §11: event.cashless must be settable through the create/update event
// API, not just by direct DB write. Mirrors the ticketing passthrough tests
// in eventServiceTicketing.test.ts.
describe('EventService cashless passthrough', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('persists cashless: true on create', async () => {
    const e = await EventService.createEvent({
      vendorId: '507f1f77bcf86cd799439011', name: 'X', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      cashless: true, ticketTypes: [],
    } as any);
    expect(e.cashless).toBe(true);
  });

  it('defaults cashless to false when not specified on create', async () => {
    const e = await EventService.createEvent({
      vendorId: '507f1f77bcf86cd799439011', name: 'Y', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketTypes: [],
    } as any);
    expect(e.cashless).toBe(false);
  });

  it('sets cashless: true via update', async () => {
    const created = await EventService.createEvent({
      vendorId: '507f1f77bcf86cd799439011', name: 'Z', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketTypes: [],
    } as any);
    expect(created.cashless).toBe(false);

    const updated = await EventService.updateEvent(
      String(created._id),
      '507f1f77bcf86cd799439011',
      { cashless: true } as any
    );
    expect(updated.cashless).toBe(true);
  });

  it('unsets cashless: false via update', async () => {
    const created = await EventService.createEvent({
      vendorId: '507f1f77bcf86cd799439011', name: 'W', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      cashless: true, ticketTypes: [],
    } as any);
    expect(created.cashless).toBe(true);

    const updated = await EventService.updateEvent(
      String(created._id),
      '507f1f77bcf86cd799439011',
      { cashless: false } as any
    );
    expect(updated.cashless).toBe(false);
  });
});
