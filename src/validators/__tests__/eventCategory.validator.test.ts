import { createEventSchema } from '@validators/tickets.validator';

const base = { name: 'E', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(Date.now() + 8.64e7), endTime: new Date(Date.now() + 9e7), ticketTypes: [{ name: 'GA', price: 10, quantity: 5 }] };

it('requires a category', () => {
  const { error } = createEventSchema.validate(base);
  expect(error).toBeDefined();
  expect(error?.details[0]?.message).toBe('Select a category');
});
it('accepts a valid category', () => {
  const { error, value } = createEventSchema.validate({ ...base, category: 'sports' });
  expect(error).toBeUndefined();
  expect(value.category).toBe('sports');
});
it('rejects an unknown category', () => {
  const { error } = createEventSchema.validate({ ...base, category: 'Nonsense' });
  expect(error).toBeDefined();
});
