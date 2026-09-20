import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Vendor } from '@models/vendor.model';

/**
 * Organizer withdrawal of a pending_approval submission: reverts to DRAFT
 * (editable/resubmittable), is blocked once tickets have sold, and rejects a
 * stale admin approval that raced past it.
 */
describe('EventService.withdrawEvent', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const makeActiveVendor = () =>
    Vendor.create({
      email: `organizer-${Date.now()}-${Math.random()}@fixture.com`,
      password: 'password123',
      businessName: 'Fixture Organizer',
      isActive: true,
      verificationStatus: 'verified',
    });

  const makePendingEvent = async (vendorId: string) => {
    const event = await EventService.createEvent({
      vendorId,
      name: 'Withdrawable Event',
      venue: 'Venue',
      eventDate: new Date('2030-01-01'),
      startTime: new Date('2030-01-01T10:00:00Z'),
      endTime: new Date('2030-01-01T12:00:00Z'),
    });
    await EventService.addTicketType(String(event._id), vendorId, {
      name: 'General',
      price: 50,
      quantity: 100,
    });
    await EventService.publishEvent(String(event._id), vendorId, false);
    return event;
  };

  it('reverts a pending submission to DRAFT', async () => {
    const vendor = await makeActiveVendor();
    const event = await makePendingEvent(String(vendor._id));

    const withdrawn = await EventService.withdrawEvent(String(event._id), String(vendor._id));
    expect(withdrawn.status).toBe(EventStatus.DRAFT);
    expect(withdrawn.publishedAt).toBeUndefined();

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.DRAFT);
  });

  it('leaves the event editable and resubmittable after withdrawal', async () => {
    const vendor = await makeActiveVendor();
    const event = await makePendingEvent(String(vendor._id));
    await EventService.withdrawEvent(String(event._id), String(vendor._id));

    await EventService.updateEvent(String(event._id), String(vendor._id), { name: 'Renamed After Withdraw' }, false);
    await EventService.publishEvent(String(event._id), String(vendor._id), false);

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.name).toBe('Renamed After Withdraw');
    expect(reloaded!.status).toBe(EventStatus.PENDING_APPROVAL);
  });

  it('rejects withdrawal when the event is not pending approval', async () => {
    const vendor = await makeActiveVendor();
    const event = await EventService.createEvent({
      vendorId: String(vendor._id),
      name: 'Draft Event',
      venue: 'Venue',
      eventDate: new Date('2030-01-01'),
      startTime: new Date('2030-01-01T10:00:00Z'),
      endTime: new Date('2030-01-01T12:00:00Z'),
    });

    await expect(
      EventService.withdrawEvent(String(event._id), String(vendor._id))
    ).rejects.toThrow('no longer awaiting approval');
  });

  it('does not allow withdrawing another organizer\'s event', async () => {
    const vendor = await makeActiveVendor();
    const otherVendor = await makeActiveVendor();
    const event = await makePendingEvent(String(vendor._id));

    await expect(
      EventService.withdrawEvent(String(event._id), String(otherVendor._id))
    ).rejects.toThrow('Event not found');

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.PENDING_APPROVAL);
  });

  it('blocks withdrawal once tickets have sold, with a cancellation/refund message', async () => {
    const vendor = await makeActiveVendor();
    const event = await makePendingEvent(String(vendor._id));
    await Event.findByIdAndUpdate(event._id, { totalTicketsSold: 5 });

    await expect(
      EventService.withdrawEvent(String(event._id), String(vendor._id))
    ).rejects.toThrow('cancellation and refund process');

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.PENDING_APPROVAL);
  });

  it('rejects a second withdrawal once the first has already succeeded', async () => {
    const vendor = await makeActiveVendor();
    const event = await makePendingEvent(String(vendor._id));

    await EventService.withdrawEvent(String(event._id), String(vendor._id));

    await expect(
      EventService.withdrawEvent(String(event._id), String(vendor._id))
    ).rejects.toThrow('no longer awaiting approval');
  });

  it('rejects a stale admin approval sent for the status the admin last saw, once withdrawn', async () => {
    const vendor = await makeActiveVendor();
    const event = await makePendingEvent(String(vendor._id));

    await EventService.withdrawEvent(String(event._id), String(vendor._id));

    await expect(
      EventService.publishEvent(String(event._id), String(vendor._id), true, EventStatus.PENDING_APPROVAL)
    ).rejects.toThrow('no longer awaiting approval');

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.DRAFT);
  });

  it('still allows a direct admin publish of a draft that was never submitted', async () => {
    const vendor = await makeActiveVendor();
    const event = await makePendingEvent(String(vendor._id));
    await EventService.withdrawEvent(String(event._id), String(vendor._id));

    const published = await EventService.publishEvent(String(event._id), String(vendor._id), true);
    expect(published.status).toBe(EventStatus.PUBLISHED);
  });
});
