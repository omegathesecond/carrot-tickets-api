import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';

describe('EventService ticketing passthrough', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('persists external ticketing on create', async () => {
    const e = await EventService.createEvent({
      vendorId: '507f1f77bcf86cd799439011', name: 'X', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketing: 'external', externalTicketUrl: 'https://my.tickets/x', ticketTypes: [],
    } as any);
    expect(e.ticketing).toBe('external');
    expect(e.externalTicketUrl).toBe('https://my.tickets/x');
  });

  it('defaults to carrot ticketing when not specified', async () => {
    const e = await EventService.createEvent({
      vendorId: '507f1f77bcf86cd799439011', name: 'Y', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketTypes: [],
    } as any);
    expect(e.ticketing).toBe('carrot');
    expect(e.externalTicketUrl).toBeUndefined();
  });

  it('updates ticketing mode and external url', async () => {
    const created = await EventService.createEvent({
      vendorId: '507f1f77bcf86cd799439011', name: 'Z', venue: 'V',
      eventDate: new Date(), startTime: new Date(), endTime: new Date(),
      ticketTypes: [],
    } as any);
    expect(created.ticketing).toBe('carrot');

    const updated = await EventService.updateEvent(
      String(created._id),
      '507f1f77bcf86cd799439011',
      { ticketing: 'external', externalTicketUrl: 'https://my.tickets/z' } as any
    );
    expect(updated.ticketing).toBe('external');
    expect(updated.externalTicketUrl).toBe('https://my.tickets/z');
  });
});
