import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Event } from '../models/event.model';
import { EventStatus } from '../interfaces/event.interface';
import { CommunityService } from '../services/community.service';

dotenv.config();

const MONGODB_URI = process.env['MONGODB_URI'];
if (!MONGODB_URI) {
  throw new Error('FATAL: MONGODB_URI is not set');
}

/**
 * One-off release backfill: every already-published event gets its community
 * + default channels. Safe to re-run (ensureForEvent is idempotent).
 */
async function backfillCommunities() {
  await mongoose.connect(MONGODB_URI as string);
  console.log('✅ Connected to MongoDB');

  const events = await Event.find({ status: EventStatus.PUBLISHED }).select('_id vendorId name');
  console.log(`Found ${events.length} published events`);

  let created = 0;
  for (const event of events) {
    const result = await CommunityService.ensureForEvent(String(event._id), String(event.vendorId));
    if (result.created) {
      created++;
      console.log(`  + community for "${event.name}"`);
    }
  }

  console.log(`Done: ${created} created, ${events.length - created} already existed`);
  await mongoose.disconnect();
}

backfillCommunities().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
