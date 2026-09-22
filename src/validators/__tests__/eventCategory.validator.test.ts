import { createEventSchema } from '@validators/tickets.validator';

const base = { name: 'E', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(Date.now() + 8.64e7), endTime: new Date(Date.now() + 9e7), ticketTypes: [{ name: 'GA', price: 10, quantity: 5 }] };

it('defaults category to Other', () => {
  const { value } = createEventSchema.validate(base);
  expect(value.category).toBe('Other');
});
it('accepts a valid category', () => {
  const { error, value } = createEventSchema.validate({ ...base, category: 'Music' });
  expect(error).toBeUndefined();
  expect(value.category).toBe('Music');
});
it('rejects an unknown category', () => {
  const { error } = createEventSchema.validate({ ...base, category: 'Nonsense' });
  expect(error).toBeDefined();
});
