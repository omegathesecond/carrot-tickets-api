import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Event } from '../models/event.model';

dotenv.config();

const MONGODB_URI = process.env['MONGODB_URI'];
if (!MONGODB_URI) {
  throw new Error('FATAL: MONGODB_URI is not set');
}

/**
 * One-off ops tool: set (or clear) an event's per-account ticket cap. There is
 * intentionally NO dashboard UI for this field.
 *
 *   npx ts-node src/scripts/setPerAccountLimit.ts <eventId> <cap>
 *   npx ts-node src/scripts/setPerAccountLimit.ts <eventId> unlimited
 *
 * <eventId> is the 24-hex Mongo _id. <cap> is a positive integer, or the
 * literal "unlimited" to remove the cap. Idempotent; prints before/after.
 */
async function main() {
  const [eventId, capArg] = process.argv.slice(2);
  if (!eventId || !capArg) {
    throw new Error('Usage: setPerAccountLimit.ts <eventId> <cap|unlimited>');
  }

  const clearing = capArg.toLowerCase() === 'unlimited';
  const cap = clearing ? undefined : Number(capArg);
  if (!clearing && (!Number.isInteger(cap) || (cap as number) < 1)) {
    throw new Error(`Invalid cap "${capArg}" — must be a positive integer or "unlimited"`);
  }

  await mongoose.connect(MONGODB_URI as string);
  console.log('✅ Connected to MongoDB');

  const event = await Event.findById(eventId).select('name maxTicketsPerAccount');
  if (!event) {
    await mongoose.disconnect();
    throw new Error(`Event ${eventId} not found`);
  }

  console.log(`Event: "${event.name}"`);
  console.log(`  before: maxTicketsPerAccount = ${event.maxTicketsPerAccount ?? '(unlimited)'}`);

  if (clearing) {
    event.set('maxTicketsPerAccount', undefined);
  } else {
    event.maxTicketsPerAccount = cap as number;
  }
  await event.save();

  const reloaded = await Event.findById(eventId).select('maxTicketsPerAccount');
  console.log(`  after:  maxTicketsPerAccount = ${reloaded!.maxTicketsPerAccount ?? '(unlimited)'}`);

  await mongoose.disconnect();
  console.log('✅ Done');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
