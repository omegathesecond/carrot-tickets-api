import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { EventService } from '@services/event.service';
import { Community } from '@models/community.model';
import { Channel } from '@models/channel.model';
import { Vendor } from '@models/vendor.model';

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

    // seedPublishedEvent uses a random vendorId with no backing Vendor doc —
    // publishEvent's organizer path needs a real, active vendor to get past
    // the account-status check and actually reach the PENDING_APPROVAL
    // transition, otherwise this test would trivially pass on an early throw.
    const vendor = await Vendor.create({
      email: 'organizer@fixture.com',
      password: 'password123',
      businessName: 'Fixture Organizer',
      isActive: true,
      verificationStatus: 'verified'
    });
    await Event.updateOne({ _id: seeded.eventId }, { vendorId: vendor._id });

    await EventService.publishEvent(seeded.eventId, String(vendor._id), false);

    const reloaded = await Event.findById(seeded.eventId);
    expect(reloaded!.status).toBe(EventStatus.PENDING_APPROVAL);
    expect(await Community.findOne({ eventId: seeded.eventId })).toBeNull();
  });
});
