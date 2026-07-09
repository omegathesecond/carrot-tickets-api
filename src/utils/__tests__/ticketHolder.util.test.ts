import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { isTicketHolder } from '@utils/ticketHolder.util';

describe('isTicketHolder', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedTicket(eventId: string, vendorId: string, phone: string, status: TicketStatus) {
    return Ticket.create({
      eventId,
      vendorId,
      ticketType: 'General',
      price: 100,
      customerPhone: phone,
      status,
    });
  }

  it('true for a SOLD ticket, matching on normalized phone', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    await seedTicket(eventId, vendorId, '+26878422613', TicketStatus.SOLD);

    // raw local formats must still match — normalization is the contract
    expect(await isTicketHolder(eventId, '78422613')).toBe(true); // bare local form
    expect(await isTicketHolder(eventId, '078422613')).toBe(true); // trunk-0 local form
    expect(await isTicketHolder(eventId, '+268 7842 2613')).toBe(true); // spaced intl form
    expect(await isTicketHolder(eventId, '76000000')).toBe(false); // different number
  });

  it('true for CHECKED_IN (mid-festival access persists)', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    await seedTicket(eventId, vendorId, '+26878000010', TicketStatus.CHECKED_IN);
    expect(await isTicketHolder(eventId, '+26878000010')).toBe(true);
  });

  it('false for REFUNDED/CANCELLED and for other events', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    await seedTicket(eventId, vendorId, '+26878000011', TicketStatus.REFUNDED);
    expect(await isTicketHolder(eventId, '+26878000011')).toBe(false);

    const other = await seedPublishedEvent();
    await seedTicket(other.eventId, other.vendorId, '+26878000012', TicketStatus.SOLD);
    expect(await isTicketHolder(eventId, '+26878000012')).toBe(false);
  });

  it('false for empty phone', async () => {
    const { eventId } = await seedPublishedEvent();
    expect(await isTicketHolder(eventId, '')).toBe(false);
  });
});
