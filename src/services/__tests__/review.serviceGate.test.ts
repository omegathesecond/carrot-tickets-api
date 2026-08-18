// api/src/services/__tests__/review.serviceGate.test.ts
//
// Task E2: enquiry-gated service reviews. A services business (Vendor
// operatorType:'services') sells no tickets, so ticket-holder-ship (the
// gate submitReview uses for event reviews) can't apply. Instead: only a
// buyer who has previously sent the business an enquiry (D1's
// EnquiryService.hasEnquired) may leave a review. One review per
// buyer/business (409 on a second), and the review carries vendorId with
// NO eventId (E1's partial-unique-index shape).
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';
import { Review } from '@models/review.model';
import { EnquiryService } from '@services/enquiry.service';
import { ReviewService } from '@services/review.service';

async function mkServicesBiz(over: any = {}) {
  return Vendor.create({
    businessName: over.businessName ?? 'Luxe Decor',
    phoneNumber: over.phoneNumber ?? '+2687650' + Math.floor(Math.random() * 100000),
    password: 'secret1',
    operatorType: over.operatorType ?? OperatorType.SERVICES,
    serviceCategory: over.serviceCategory ?? 'furniture_decor',
    verificationStatus: over.verificationStatus ?? VerificationStatus.VERIFIED,
    isActive: over.isActive ?? true,
  });
}

async function mkBuyer(over: any = {}) {
  return Buyer.create({
    phone: over.phone ?? '+26878' + Math.floor(Math.random() * 1000000),
    password: 'secret1',
    name: over.name ?? 'Test Buyer',
    username: over.username,
  }) as Promise<IBuyer>;
}

describe('ReviewService.submitServiceReview', () => {
  beforeAll(async () => {
    await connectTestDb();
    // The {vendorId, buyerId} partial-unique index (eventId absent) must
    // actually exist in the in-memory Mongo before the duplicate-review
    // assertion below, or a 409 would pass for the wrong reason.
    await Review.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('403s without a prior enquiry; succeeds after one; 409s on a second review', async () => {
    const biz = await mkServicesBiz();
    const buyer = await mkBuyer();

    await expect(
      ReviewService.submitServiceReview(String(biz._id), buyer, { rating: 5, text: 'Beautiful work' })
    ).rejects.toMatchObject({ statusCode: 403, message: 'Only customers who have enquired can review this business' });

    await EnquiryService.create(String(biz._id), buyer, { message: 'Do you do weddings?' });

    const review = await ReviewService.submitServiceReview(String(biz._id), buyer, {
      rating: 5,
      text: 'Beautiful work',
    });
    expect(String(review.vendorId)).toBe(String(biz._id));
    expect(review.eventId).toBeUndefined();
    expect(review.verified).toBe(true);

    const stored = await Review.findById(review._id);
    expect(stored).not.toBeNull();
    expect(stored!.eventId).toBeUndefined();

    await expect(
      ReviewService.submitServiceReview(String(biz._id), buyer, { rating: 4 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // A PENDING business is publicly visible (verification is only a badge), so
  // it must clear the visibility gate and fall through to the enquiry gate —
  // 403 "only customers who have enquired", not 404 "no such business".
  it('lets a pending business through the visibility gate to the enquiry gate', async () => {
    const buyer = await mkBuyer();
    const pending = await mkServicesBiz({ verificationStatus: VerificationStatus.PENDING });
    await expect(
      ReviewService.submitServiceReview(String(pending._id), buyer, { rating: 5 })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('404s for a business that is not a verified, active SERVICES vendor', async () => {
    const buyer = await mkBuyer();

    const eventsVendor = await mkServicesBiz({ operatorType: OperatorType.EVENTS, serviceCategory: undefined });
    await expect(
      ReviewService.submitServiceReview(String(eventsVendor._id), buyer, { rating: 5 })
    ).rejects.toMatchObject({ statusCode: 404 });

    for (const status of [VerificationStatus.REJECTED, VerificationStatus.SUSPENDED]) {
      const takenDown = await mkServicesBiz({ verificationStatus: status });
      await expect(
        ReviewService.submitServiceReview(String(takenDown._id), buyer, { rating: 5 })
      ).rejects.toMatchObject({ statusCode: 404 });
    }

    const inactive = await mkServicesBiz({ isActive: false });
    await expect(
      ReviewService.submitServiceReview(String(inactive._id), buyer, { rating: 5 })
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      ReviewService.submitServiceReview('aaaaaaaaaaaaaaaaaaaaaaaa', buyer, { rating: 5 })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('ReviewService.submitBusinessReviewAsOrganizer', () => {
  beforeAll(async () => {
    await connectTestDb();
    // The {vendorId, reviewerVendorId} partial-unique index must exist before
    // the duplicate-review (409) assertion, or it would pass for the wrong reason.
    await Review.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets an organizer review a business with NO enquiry gate, one review each (409 on a second)', async () => {
    const biz = await mkServicesBiz({ businessName: 'Luxe Decor' });
    const organizer = await mkServicesBiz({ businessName: 'Mbabane Live', operatorType: OperatorType.EVENTS, serviceCategory: undefined });

    // No prior enquiry needed — straight to a successful review.
    const review = await ReviewService.submitBusinessReviewAsOrganizer(
      String(biz._id),
      String(organizer._id),
      { rating: 5, text: 'Worked with them, top notch' }
    );
    expect(String(review.vendorId)).toBe(String(biz._id));
    expect(String(review.reviewerVendorId)).toBe(String(organizer._id));
    expect(review.buyerId).toBeUndefined();
    expect(review.eventId).toBeUndefined();
    expect(review.verified).toBe(true);

    await expect(
      ReviewService.submitBusinessReviewAsOrganizer(String(biz._id), String(organizer._id), { rating: 4 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('blocks a business reviewing ITSELF (400)', async () => {
    const biz = await mkServicesBiz();
    await expect(
      ReviewService.submitBusinessReviewAsOrganizer(String(biz._id), String(biz._id), { rating: 5 })
    ).rejects.toMatchObject({ statusCode: 400, message: 'You cannot review your own business' });
  });

  it('lets an organizer review a PENDING business (verification is a badge, not a gate)', async () => {
    const organizer = await mkServicesBiz({ businessName: 'Reviewer Co', operatorType: OperatorType.EVENTS, serviceCategory: undefined });
    const pending = await mkServicesBiz({ verificationStatus: VerificationStatus.PENDING });
    const review = await ReviewService.submitBusinessReviewAsOrganizer(String(pending._id), String(organizer._id), { rating: 5 });
    expect(String(review.vendorId)).toBe(String(pending._id));
  });

  it('404s for a REJECTED / SUSPENDED / inactive / non-services business', async () => {
    const organizer = await mkServicesBiz({ businessName: 'Reviewer Co', operatorType: OperatorType.EVENTS, serviceCategory: undefined });
    for (const status of [VerificationStatus.REJECTED, VerificationStatus.SUSPENDED]) {
      const takenDown = await mkServicesBiz({ verificationStatus: status });
      await expect(
        ReviewService.submitBusinessReviewAsOrganizer(String(takenDown._id), String(organizer._id), { rating: 5 })
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    const inactive = await mkServicesBiz({ isActive: false });
    await expect(
      ReviewService.submitBusinessReviewAsOrganizer(String(inactive._id), String(organizer._id), { rating: 5 })
    ).rejects.toMatchObject({ statusCode: 404 });
    const eventsVendor = await mkServicesBiz({ operatorType: OperatorType.EVENTS, serviceCategory: undefined });
    await expect(
      ReviewService.submitBusinessReviewAsOrganizer(String(eventsVendor._id), String(organizer._id), { rating: 5 })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('surfaces the organizer reviewer as a business in listBusinessReviews', async () => {
    const biz = await mkServicesBiz({ businessName: 'Luxe Decor' });
    const organizer = await mkServicesBiz({ businessName: 'Mbabane Live', operatorType: OperatorType.EVENTS, serviceCategory: undefined });
    await ReviewService.submitBusinessReviewAsOrganizer(String(biz._id), String(organizer._id), { rating: 4, text: 'Solid partner' });

    const list = await ReviewService.listBusinessReviews(String(biz._id));
    expect(list).toHaveLength(1);
    expect(list[0]!.reviewer.isBusiness).toBe(true);
    expect(list[0]!.reviewer.name).toBe('Mbabane Live');
    expect(list[0]!.reviewer.id).toBe(String(organizer._id));
  });
});

describe('ReviewService.listBusinessReviews', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns only event-less reviews for the given vendor, newest first, with a hydrated reviewer', async () => {
    const biz = await mkServicesBiz();
    const buyer = await mkBuyer({ username: 'decor_fan' });
    await EnquiryService.create(String(biz._id), buyer, { message: 'Interested!' });
    const review = await ReviewService.submitServiceReview(String(biz._id), buyer, { rating: 5, text: 'Loved it' });

    // An unrelated event review on the SAME vendor must never leak into the
    // services list — listBusinessReviews filters eventId: { $exists: false }.
    await Review.create({
      eventId: '507f1f77bcf86cd799439011',
      vendorId: biz._id,
      buyerId: buyer._id,
      rating: 3,
      verified: true,
    });

    const list = await ReviewService.listBusinessReviews(String(biz._id));
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(String(review._id));
    expect(list[0]!.rating).toBe(5);
    expect(list[0]!.text).toBe('Loved it');
    expect(list[0]!.reviewer.username).toBe('decor_fan');
  });

  it('returns an empty list for a business with no service reviews', async () => {
    const biz = await mkServicesBiz();
    expect(await ReviewService.listBusinessReviews(String(biz._id))).toEqual([]);
  });
});
