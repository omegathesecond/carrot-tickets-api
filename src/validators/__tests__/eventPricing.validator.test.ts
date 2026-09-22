import { createEventSchema, updateEventSchema } from '@validators/tickets.validator';

const base = {
  name: 'E', venue: 'V',
  eventDate: new Date(Date.now() + 8.64e7),
  startTime: new Date(Date.now() + 8.64e7),
  endTime: new Date(Date.now() + 9e7),
};

it('defaults currency to SZL on create', () => {
  const { value } = createEventSchema.validate({ ...base });
  expect(value.currency).toBe('SZL');
});

it('accepts ZAR + a valid min/max range', () => {
  const { error, value } = createEventSchema.validate({
    ...base, ticketing: 'external', externalTicketUrl: 'https://x.co/t',
    currency: 'ZAR', priceMin: 100, priceMax: 250,
  });
  expect(error).toBeUndefined();
  expect(value.currency).toBe('ZAR');
  expect(value.priceMin).toBe(100);
  expect(value.priceMax).toBe(250);
});

it('rejects an unknown currency', () => {
  const { error } = createEventSchema.validate({ ...base, currency: 'USD' });
  expect(error).toBeDefined();
});

it('rejects priceMax below priceMin', () => {
  const { error } = createEventSchema.validate({ ...base, priceMin: 300, priceMax: 100 });
  expect(error).toBeDefined();
  expect(error!.details[0]!.message).toMatch(/maximum price/i);
});

it('allows a lone priceMin (open-ended "from")', () => {
  const { error } = createEventSchema.validate({ ...base, priceMin: 100 });
  expect(error).toBeUndefined();
});

it('validates the same range rule on update', () => {
  const { error } = updateEventSchema.validate({ priceMin: 300, priceMax: 100 });
  expect(error).toBeDefined();
});
