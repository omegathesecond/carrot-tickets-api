import { ensurePreparationCategories } from '@/scripts/ensurePreparationCategories';
import { ServiceCategory } from '@models/serviceCategory.model';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Ticket } from '@models/ticket.model';
import { Preparation } from '@models/preparation.model';
import { Notification } from '@models/notification.model';
import { NotificationService } from '@services/notification.service';
import { PreparationService as service } from '@services/preparation.service';
import { preparationInput, preparationOfferInput } from '@controllers/preparation.controller';

beforeAll(connectLedgerTestDb, 120000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDb(); });
afterAll(disconnectTestDb);

async function setup() {
  const buyer = await Buyer.create({ email: 'attendee@example.com', password: 'secret123', name: 'Attendee' });
  const { eventId, vendorId } = await seedPublishedEvent();
  await Ticket.create({ eventId, vendorId, ticketType: 'General', price: 100, status: 'sold', buyerId: buyer._id });
  const provider = await Vendor.create({ businessName: 'Salon', phoneNumber: '+26878422613', password: 'secret123', operatorType: 'services', serviceCategories: ['hair'], verificationStatus: 'pending' });
  return { buyer, eventId, provider };
}
const input = { category: 'hair', budget: 300, preferredDate: new Date('2027-01-10'), location: 'Mbabane', note: '', mode: 'open', providerIds: [] };
const offer = { price: 200, description: 'Hair styling', availableTime: new Date('2027-01-10T10:00:00Z'), location: 'Salon', photos: ['https://example.com/work.jpg'], message: '', deposit: 50, cancellationTerms: 'Free until 24h before' };

it('requires a live ticket and rechecks it after refund, including email-only buyers', async () => {
  const { buyer, eventId } = await setup();
  await expect(service.mine(eventId, buyer)).resolves.toMatchObject({ requests: [] });
  await Ticket.updateMany({}, { status: 'refunded' });
  await expect(service.save(eventId, buyer, { ...input })).rejects.toMatchObject({ statusCode: 403 });
});

it('hides private invitations and rejects uninvited or wrong-category offers', async () => {
  const { buyer, eventId, provider } = await setup();
  const other = await Vendor.create({ businessName: 'Other', phoneNumber: '+26878000001', password: 'secret123', operatorType: 'services', serviceCategories: ['hair'] });
  const request = await service.save(eventId, buyer, { ...input, mode: 'invite', providerIds: [String(provider._id)] });
  expect(await service.list(String(other._id), {})).toEqual([]);
  await expect(service.offer(String(request._id), { id: String(other._id), type: 'vendor', name: '' }, offer)).rejects.toMatchObject({ statusCode: 403 });
  await Vendor.updateOne({ _id: provider._id }, { serviceCategories: ['transport'] });
  await expect(service.offer(String(request._id), { id: String(provider._id), type: 'vendor', name: '' }, offer)).rejects.toMatchObject({ statusCode: 403 });
});

it('keeps competing offers private and allows only one booking', async () => {
  const { buyer, eventId, provider } = await setup();
  const request = await service.save(eventId, buyer, { ...input });
  const result = await service.offer(String(request._id), { id: String(provider._id), type: 'vendor', name: '' }, offer);
  expect(result).not.toHaveProperty('offers');
  const [listed] = await service.list(String(provider._id), { location: 'Mbabane', budget: 200, date: '2027-01-10', eventId });
  expect(listed!.buyerId).toBeUndefined();
  expect(listed!.offers).toHaveLength(1);
  const stored = await Preparation.findById(request._id);
  const accepted = await service.accept(eventId, buyer, String(request._id), String(stored!.offers[0]!._id));
  expect(accepted.status).toBe('booked');
  await expect(service.accept(eventId, buyer, String(request._id), String(stored!.offers[0]!._id))).rejects.toMatchObject({ statusCode: 409 });
  expect(await Notification.countDocuments({ type: 'preparation_update' })).toBe(2);
});

it('does not allow another buyer to edit, remove or book a request', async () => {
  const { buyer, eventId } = await setup();
  const request = await service.save(eventId, buyer, { ...input });
  const other = await Buyer.create({ email: 'other@example.com', password: 'secret123' });
  await Ticket.updateMany({}, { buyerId: other._id });
  await expect(service.save(eventId, other, { ...input }, String(request._id))).rejects.toMatchObject({ statusCode: 409 });
  await expect(service.remove(eventId, other, String(request._id))).rejects.toMatchObject({ statusCode: 409 });
  await expect(service.accept(eventId, other, String(request._id), String(request._id))).rejects.toMatchObject({ statusCode: 409 });
});

it('rolls back the offer when its notification fails', async () => {
  const { buyer, eventId, provider } = await setup();
  const request = await service.save(eventId, buyer, { ...input });
  jest.spyOn(NotificationService, 'create').mockRejectedValueOnce(new Error('notification unavailable'));
  await expect(service.offer(String(request._id), { id: String(provider._id), type: 'vendor', name: '' }, offer)).rejects.toThrow('notification unavailable');
  expect((await Preparation.findById(request._id))!.offers).toHaveLength(0);
});

it('invalidates old offers on editing and prevents offers to removed requests', async () => {
  const { buyer, eventId, provider } = await setup();
  const request = await service.save(eventId, buyer, { ...input });
  await service.offer(String(request._id), { id: String(provider._id), type: 'vendor', name: '' }, offer);
  const edited = await service.save(eventId, buyer, { ...input, budget: 400 }, String(request._id));
  expect(edited.offers).toHaveLength(0);
  await service.remove(eventId, buyer, String(request._id));
  expect((await service.mine(eventId, buyer)).requests).toHaveLength(0);
  await expect(service.offer(String(request._id), { id: String(provider._id), type: 'vendor', name: '' }, offer)).rejects.toMatchObject({ statusCode: 409 });
});

it('lets other ticket holders express interest but prevents self-interest', async () => {
  const { buyer, eventId } = await setup();
  const request = await service.save(eventId, buyer, { ...input, category: 'event_companion' });
  await expect(service.offer(String(request._id), { id: String(buyer._id), type: 'buyer', name: 'Me', buyer }, offer)).rejects.toMatchObject({ statusCode: 403 });
  const other = await Buyer.create({ email: 'companion@example.com', password: 'secret123' });
  await Ticket.updateMany({}, { buyerId: other._id });
  expect(await service.companions(eventId, other)).toHaveLength(1);
  await service.offer(String(request._id), { id: String(other._id), type: 'buyer', name: 'Companion', buyer: other }, offer);
  expect((await service.companions(eventId, other))[0]!.offers).toHaveLength(1);
});

it('validates request fields, invite ids, deposits, dates and unsafe example URLs', () => {
  expect(preparationInput.validate({ ...input, budget: -1 }).error).toBeDefined();
  expect(preparationInput.validate({ ...input, providerIds: ['bad'] }).error).toBeDefined();
  expect(preparationOfferInput.validate({ ...offer, deposit: 300 }).error).toBeDefined();
  expect(preparationOfferInput.validate({ ...offer, photos: ['javascript:alert(1)'] }).error).toBeDefined();
  expect(preparationOfferInput.validate({ ...offer, availableTime: 'invalid' }).error).toBeDefined();
});

it('adds preparation categories without overwriting administrator decisions', async () => {
  await ServiceCategory.create({ value: 'hair', label: 'Custom salon label', order: 2, isActive: false });
  await ensurePreparationCategories();
  await ensurePreparationCategories();
  expect(await ServiceCategory.findOne({ value: 'hair' })).toMatchObject({ label: 'Custom salon label', order: 2, isActive: false });
  expect(await ServiceCategory.countDocuments({ value: 'babysitting' })).toBe(1);
});

it('concurrent offers from the same provider persist once and filters escape user regex', async () => {
  const { buyer, eventId, provider } = await setup();
  const request = await service.save(eventId, buyer, { ...input });
  const actor = { id: String(provider._id), type: 'vendor' as const, name: '' };
  const results = await Promise.allSettled([service.offer(String(request._id), actor, offer), service.offer(String(request._id), actor, offer)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await Preparation.findById(request._id))!.offers).toHaveLength(1);
  expect(await service.list(String(provider._id), { event: 'Snapshot' })).toHaveLength(1);
  expect(await service.list(String(provider._id), { event: '.*' })).toHaveLength(0);
  expect(await service.list(String(provider._id), { location: '.*' })).toHaveLength(0);
});
