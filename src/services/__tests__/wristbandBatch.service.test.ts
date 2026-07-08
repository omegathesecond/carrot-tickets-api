import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { TicketService } from '@services/ticket.service';
import { Ticket } from '@models/ticket.model';
import { Event } from '@models/event.model';
import { PaymentMethod, PaymentStatus, SalesChannel, TicketStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('issues N real tickets on a zero-amount wristband sale', async () => {
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 20 });
  const { sale, tickets } = await TicketService.issueWristbandBatch({ eventId, ticketTypeId, quantity: 10 });

  expect(tickets).toHaveLength(10);
  expect(sale.quantity).toBe(10);
  expect(sale.totalAmount).toBe(0);
  expect(sale.channel).toBe(SalesChannel.WRISTBAND);
  expect(sale.paymentMethod).toBe(PaymentMethod.CASH);
  expect(sale.paymentStatus).toBe(PaymentStatus.COMPLETED);
  expect(sale.faceAmount).toBe(0);
  expect(sale.amountCharged).toBe(0);

  // Real, scannable tickets: 8-char unambiguous-alphabet codes (see
  // ticketCode.util.ts — the model's current format; the older TKT- prefix is
  // legacy and no longer generated), SOLD, linked to the sale, price 0.
  for (const t of tickets) {
    expect(t.ticketId).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(t.status).toBe(TicketStatus.SOLD);
    expect(t.price).toBe(0);
  }
  const persisted = await Ticket.find({ saleId: sale._id });
  expect(persisted).toHaveLength(10);
});

it('counts against ticket-type capacity and fails loudly when overselling', async () => {
  const { eventId, ticketTypeId } = await seedPublishedEvent({ capacity: 5 });
  await TicketService.issueWristbandBatch({ eventId, ticketTypeId, quantity: 5 });

  const event = await Event.findById(eventId).lean();
  expect((event as any).ticketTypes[0].sold).toBe(5);

  await expect(
    TicketService.issueWristbandBatch({ eventId, ticketTypeId, quantity: 1 })
  ).rejects.toThrow();
});
