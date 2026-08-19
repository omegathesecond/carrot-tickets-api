import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('defaults cashless to false and is settable to true', async () => {
  const { eventId } = await seedPublishedEvent({});
  const before = await Event.findById(eventId).lean();
  expect(before!.cashless).toBe(false);

  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const after = await Event.findById(eventId).lean();
  expect(after!.cashless).toBe(true);
});
