import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';

describe('EventService pricing passthrough', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  const base = {
    vendorId: '507f1f77bcf86cd799439011', name: 'X', venue: 'V',
    eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [],
  };

  it('persists currency + price range on create', async () => {
    const e = await EventService.createEvent({
      ...base, ticketing: 'external', externalTicketUrl: 'https://x.co/t',
      currency: 'ZAR', priceMin: 100, priceMax: 250,
    } as any);
    expect(e.currency).toBe('ZAR');
    expect(e.priceMin).toBe(100);
    expect(e.priceMax).toBe(250);
  });

  it('defaults currency to SZL when not specified', async () => {
    const e = await EventService.createEvent({ ...base } as any);
    expect(e.currency).toBe('SZL');
  });

  it('updates the price range', async () => {
    const created = await EventService.createEvent({ ...base } as any);
    const updated = await EventService.updateEvent(
      (created as any)._id.toString(), base.vendorId,
      { currency: 'ZAR', priceMin: 50, priceMax: 75 } as any, false,
    );
    expect(updated!.currency).toBe('ZAR');
    expect(updated!.priceMin).toBe(50);
    expect(updated!.priceMax).toBe(75);
  });
});
