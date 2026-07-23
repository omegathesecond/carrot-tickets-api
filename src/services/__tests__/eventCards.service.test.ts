import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { buildEventCards } from '@services/eventCards.service';

describe('buildEventCards', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns cards in the requested id order with organizer attached', async () => {
    const v = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret123' });
    const e1 = await Event.create({ vendorId: v._id, name: 'A', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const e2 = await Event.create({ vendorId: v._id, name: 'B', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 50, quantity: 10, available: 10 }] });
    const cards = await buildEventCards([String(e2._id), String(e1._id)], null);
    expect(cards.map((c) => c.name)).toEqual(['B', 'A']);
    expect(cards[0].organizer.businessName).toBe('MTN Bushfire');
  });

  it('returns [] for no ids', async () => {
    expect(await buildEventCards([], null)).toEqual([]);
  });
});
