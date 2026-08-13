// api/src/models/__tests__/review.serviceReview.test.ts
//
// Task E1: a service business (Vendor operatorType:'services') sells no
// tickets, so a review of it carries NO eventId. Review.eventId must become
// optional, and the old single {eventId, buyerId} unique index must split
// into two PARTIAL unique indexes so that:
//   - event reviews stay unique per {eventId, buyerId} (unchanged behavior)
//   - service reviews (eventId absent) are unique per {vendorId, buyerId}
// without the two families colliding with each other.
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Review } from '@models/review.model';

beforeAll(async () => {
  await connectTestDb();
  // Build the (new) partial unique indexes in the in-memory Mongo — without
  // this the uniqueness assertions below wouldn't be enforced by the server
  // and the test would pass for the wrong reason.
  await Review.syncIndexes();
});
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('Review — event-less service reviews', () => {
  it('allows the same buyer to leave one service review per vendor (different vendors)', async () => {
    const buyerId = new mongoose.Types.ObjectId();
    const vendorA = new mongoose.Types.ObjectId();
    const vendorB = new mongoose.Types.ObjectId();

    const reviewA = await Review.create({ vendorId: vendorA, buyerId, rating: 5, verified: true });
    const reviewB = await Review.create({ vendorId: vendorB, buyerId, rating: 4, verified: true });

    expect(reviewA.eventId).toBeUndefined();
    expect(reviewB.eventId).toBeUndefined();
  });

  it('rejects a second service review from the same buyer to the same vendor (11000)', async () => {
    const buyerId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();

    await Review.create({ vendorId, buyerId, rating: 5, verified: true });
    await expect(Review.create({ vendorId, buyerId, rating: 3, verified: true })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('still enforces {eventId, buyerId} uniqueness per buyer per event', async () => {
    const buyerId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const eventId = new mongoose.Types.ObjectId();

    await Review.create({ eventId, vendorId, buyerId, rating: 5, verified: true });
    await expect(
      Review.create({ eventId, vendorId, buyerId, rating: 2, verified: true })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('does not let an event review collide with a service review from the same buyer/vendor', async () => {
    const buyerId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const eventId = new mongoose.Types.ObjectId();

    // Service review (no eventId) and an event review, same buyer+vendor:
    // these live in different partial indexes and must both succeed.
    const service = await Review.create({ vendorId, buyerId, rating: 5, verified: true });
    const event = await Review.create({ eventId, vendorId, buyerId, rating: 4, verified: true });

    expect(service.eventId).toBeUndefined();
    expect(event.eventId?.toString()).toBe(eventId.toString());
  });
});
