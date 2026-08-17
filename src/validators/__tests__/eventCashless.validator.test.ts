import { createEventSchema, updateEventSchema } from '@validators/tickets.validator';

const base = { name: 'E', venue: 'V', eventDate: new Date(Date.now() + 8.64e7), startTime: new Date(Date.now() + 8.64e7), endTime: new Date(Date.now() + 9e7) };

it('accepts cashless: true on create', () => {
  const { error, value } = createEventSchema.validate({ ...base, cashless: true });
  expect(error).toBeUndefined();
  expect(value.cashless).toBe(true);
});

it('does not require cashless on create (optional, model default applies downstream)', () => {
  const { error, value } = createEventSchema.validate({ ...base });
  expect(error).toBeUndefined();
  expect(value.cashless).toBeUndefined();
});

it('rejects a non-boolean cashless value on create', () => {
  const { error } = createEventSchema.validate({ ...base, cashless: 'yes' });
  expect(error).toBeDefined();
});

it('accepts cashless: true on update', () => {
  const { error, value } = updateEventSchema.validate({ cashless: true });
  expect(error).toBeUndefined();
  expect(value.cashless).toBe(true);
});

it('accepts cashless: false on update', () => {
  const { error, value } = updateEventSchema.validate({ cashless: false });
  expect(error).toBeUndefined();
  expect(value.cashless).toBe(false);
});
