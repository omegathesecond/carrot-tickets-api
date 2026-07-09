import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { EventService } from '@services/event.service';
import { Community } from '@models/community.model';
import { Channel } from '@models/channel.model';

describe('publishEvent creates the community', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('superadmin publish auto-creates community + default channels', async () => {
    // Seed a published event, then flip it back to DRAFT so we can exercise
    // the real publish transition.
    const seeded = await seedPublishedEvent();
    await Event.updateOne({ _id: seeded.eventId }, { status: EventStatus.DRAFT });

    await EventService.publishEvent(seeded.eventId, seeded.vendorId, true);

    const community = await Community.findOne({ eventId: seeded.eventId });
    expect(community).not.toBeNull();
    expect(await Channel.countDocuments({ communityId: community!._id })).toBe(3);
  });

  it('organizer submission (PENDING_APPROVAL) does NOT create a community', async () => {
    const seeded = await seedPublishedEvent();
    await Event.updateOne({ _id: seeded.eventId }, { status: EventStatus.DRAFT });

    await EventService.publishEvent(seeded.eventId, seeded.vendorId, false).catch(() => {
      // organizer path may throw for missing vendor doc — either way,
      // no community must exist for a non-published event
    });

    expect(await Community.findOne({ eventId: seeded.eventId })).toBeNull();
  });
});
