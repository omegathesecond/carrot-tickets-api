import { createEventSchema } from '@validators/tickets.validator';

const base = { name: 'E', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(Date.now() + 8.64e7), endTime: new Date(Date.now() + 9e7) };

it('rejects external without a url', () => {
  const { error } = createEventSchema.validate({ ...base, ticketing: 'external' });
  expect(error).toBeDefined();
});
it('rejects a non-https external url', () => {
  const { error } = createEventSchema.validate({ ...base, ticketing: 'external', externalTicketUrl: 'http://x' });
  expect(error).toBeDefined();
});
it('accepts external with an https url', () => {
  const { error, value } = createEventSchema.validate({ ...base, ticketing: 'external', externalTicketUrl: 'https://my.tickets/e' });
  expect(error).toBeUndefined();
  expect(value.ticketing).toBe('external');
});
it('defaults ticketing to carrot', () => {
  const { value } = createEventSchema.validate({ ...base, ticketTypes: [{ name: 'GA', price: 10, quantity: 5 }] });
  expect(value.ticketing).toBe('carrot');
});
