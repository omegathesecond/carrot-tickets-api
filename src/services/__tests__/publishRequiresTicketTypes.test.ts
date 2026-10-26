import { EventApprovalEmailService } from '../eventApprovalEmail.service';
jest.mock('../eventApprovalEmail.service', () => ({ EventApprovalEmailService: { send: jest.fn().mockResolvedValue(undefined) } }));
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '@services/event.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Vendor } from '@models/vendor.model';

/**
 * An event with zero ticket types has nothing for a buyer to purchase, so it
 * must not be submittable for approval (organizer) or publishable directly
 * (admin) — and if the last ticket type is deleted while the event is still
 * awaiting approval, that submission is no longer valid either.
 */
describe('EventService.publishEvent — requires at least one ticket type', () => {
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

  const makeDraftEventWithoutTickets = async (vendorId: string) =>
    EventService.createEvent({
      vendorId,
      name: 'Ticketless Draft Event',
      venue: 'Venue',
      eventDate: new Date('2030-01-01'),
      startTime: new Date('2030-01-01T10:00:00Z'),
      endTime: new Date('2030-01-01T12:00:00Z'),
    });

  it('rejects an organizer submission when the event has no ticket types', async () => {
    const vendor = await makeActiveVendor();
    const event = await makeDraftEventWithoutTickets(String(vendor._id));

    await expect(
      EventService.publishEvent(String(event._id), String(vendor._id), false)
    ).rejects.toThrow('Create at least one ticket type before requesting to publish this event.');

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.DRAFT);
  });

  it('rejects a direct admin publish when the event has no ticket types', async () => {
    const vendor = await makeActiveVendor();
    const event = await makeDraftEventWithoutTickets(String(vendor._id));

    await expect(
      EventService.publishEvent(String(event._id), String(vendor._id), true)
    ).rejects.toThrow('Create at least one ticket type before requesting to publish this event.');

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.DRAFT);
  });

  it('allows submission once a valid ticket type exists', async () => {
    const vendor = await makeActiveVendor();
    const event = await makeDraftEventWithoutTickets(String(vendor._id));

    await EventService.addTicketType(String(event._id), String(vendor._id), {
      name: 'General',
      price: 50,
      quantity: 100,
    });

    await EventService.publishEvent(String(event._id), String(vendor._id), false);

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.PENDING_APPROVAL);
  });

  it('reverts a pending event back to DRAFT when its last ticket type is deleted', async () => {
    const vendor = await makeActiveVendor();
    const event = await makeDraftEventWithoutTickets(String(vendor._id));

    await EventService.addTicketType(String(event._id), String(vendor._id), {
      name: 'General',
      price: 50,
      quantity: 100,
    });
    await EventService.publishEvent(String(event._id), String(vendor._id), false);
    expect((await Event.findById(event._id))!.status).toBe(EventStatus.PENDING_APPROVAL);

    await EventService.deleteTicketType(String(event._id), String(vendor._id), 'General', false);

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.DRAFT);
    expect(reloaded!.ticketTypes.length).toBe(0);
  });

  it('does not touch an already-published event when its last ticket type is deleted', async () => {
    const vendor = await makeActiveVendor();
    const event = await makeDraftEventWithoutTickets(String(vendor._id));

    await EventService.addTicketType(String(event._id), String(vendor._id), {
      name: 'General',
      price: 50,
      quantity: 100,
    });
    await EventService.publishEvent(String(event._id), String(vendor._id), true);
    expect((await Event.findById(event._id))!.status).toBe(EventStatus.PUBLISHED);

    await EventService.deleteTicketType(String(event._id), String(vendor._id), 'General', true);

    const reloaded = await Event.findById(event._id);
    expect(reloaded!.status).toBe(EventStatus.PUBLISHED);
    expect(reloaded!.ticketTypes.length).toBe(0);
  });
  it('claims concurrent submissions once and permits a new submission after withdrawal', async () => {
    const vendor = await makeActiveVendor();
    const event = await makeDraftEventWithoutTickets(String(vendor._id));
    await EventService.addTicketType(String(event._id), String(vendor._id), { name: 'General', price: 50, quantity: 100 });
    const send = jest.mocked(EventApprovalEmailService.send);
    send.mockClear();
    const submit = () => EventService.publishEvent(String(event._id), String(vendor._id), false);
    const results = await Promise.allSettled([submit(), submit()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    await EventService.withdrawEvent(String(event._id), String(vendor._id));
    await submit();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('preserves submission and surfaces email failure without resending on retry', async () => {
    const vendor = await makeActiveVendor();
    const event = await makeDraftEventWithoutTickets(String(vendor._id));
    await EventService.addTicketType(String(event._id), String(vendor._id), { name: 'General', price: 50, quantity: 100 });
    const send = jest.mocked(EventApprovalEmailService.send);
    send.mockClear();
    send.mockRejectedValueOnce(new Error('offline'));
    const submit = () => EventService.publishEvent(String(event._id), String(vendor._id), false);
    await expect(submit()).rejects.toThrow('submitted for approval, but');
    expect((await Event.findById(event._id))!.status).toBe(EventStatus.PENDING_APPROVAL);
    await expect(submit()).rejects.toThrow('already been submitted');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('claims concurrent admin approvals once', async () => {
    const vendor = await makeActiveVendor();
    const event = await makeDraftEventWithoutTickets(String(vendor._id));
    await EventService.addTicketType(String(event._id), String(vendor._id), { name: 'General', price: 50, quantity: 100 });
    await EventService.publishEvent(String(event._id), String(vendor._id), false);
    const send = jest.mocked(EventApprovalEmailService.send);
    send.mockClear();
    const approve = () => EventService.publishEvent(String(event._id), String(vendor._id), true, EventStatus.PENDING_APPROVAL);
    const results = await Promise.allSettled([approve(), approve()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: EventStatus.PUBLISHED }), true);
  });

});
