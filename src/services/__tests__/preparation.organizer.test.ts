import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { Preparation } from '@models/preparation.model';
import { PreparationService } from '@services/preparation.service';

const owner = { _id: '111111111111111111111111', requesterType: 'vendor' as const };
const eventId = '222222222222222222222222';
afterEach(() => jest.restoreAllMocks());

it('requires both an organizer account and ownership of the selected event', async () => {
  const vendor = jest.spyOn(Vendor, 'findOne').mockResolvedValue(null);
  const event = jest.spyOn(Event, 'findOne');
  await expect(PreparationService.mine(eventId, owner)).rejects.toMatchObject({ statusCode: 403 });
  expect(event).not.toHaveBeenCalled();
  vendor.mockResolvedValue({ _id: owner._id } as never);
  event.mockReturnValue({ select: jest.fn().mockResolvedValue(null) } as never);
  await expect(PreparationService.mine(eventId, owner)).rejects.toMatchObject({ statusCode: 403 });
  expect(event).toHaveBeenCalledWith({ _id: eventId, vendorId: owner._id });
});

it('scopes organizer requests to their vendor identity, without requiring attendee tickets', async () => {
  jest.spyOn(Vendor, 'findOne').mockResolvedValue({ _id: owner._id } as never);
  jest.spyOn(Event, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue({ name: 'Festival' }) } as never);
  const find = jest.spyOn(Preparation, 'find').mockReturnValue({ sort: jest.fn().mockResolvedValue([]) } as never);
  await expect(PreparationService.mine(eventId, owner)).resolves.toMatchObject({ requests: [] });
  expect(find).toHaveBeenCalledWith({ eventId, organizerId: owner._id, status: { $ne: 'removed' } });
});

it('rejects attendee-only categories before saving organizer requests', async () => {
  jest.spyOn(PreparationService, 'holder').mockResolvedValue({} as never);
  const persist = jest.spyOn(PreparationService, 'persist');
  await expect(PreparationService.save(eventId, owner, { category: 'event_companion', budget: 10, preferredDate: '2027-01-01', location: 'Mbabane', note: '', mode: 'open', providerIds: [] })).rejects.toMatchObject({ statusCode: 400 });
  expect(persist).not.toHaveBeenCalled();
});

it('requires exactly one requester identity in the model', async () => {
  const fields = { eventId, category: 'catering', budget: 10, preferredDate: new Date(), location: 'Mbabane', mode: 'open' };
  await expect(new Preparation(fields).validate()).rejects.toThrow('Exactly one');
  await expect(new Preparation({ ...fields, buyerId: owner._id, organizerId: owner._id }).validate()).rejects.toThrow('Exactly one');
  await expect(new Preparation({ ...fields, organizerId: owner._id }).validate()).resolves.toBeUndefined();
});
