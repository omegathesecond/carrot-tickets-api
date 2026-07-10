import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Review } from '@models/review.model';
import { ReviewService } from '@services/review.service';

const PHONE = '+26878422613';

async function seedEndedEventWithTicket(phone = PHONE) {
  const seeded = await seedPublishedEvent();
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await Event.updateOne({ _id: seeded.eventId }, { eventDate: past, startTime: past, endTime: past });
  await Ticket.create({
    eventId: seeded.eventId, vendorId: seeded.vendorId, ticketType: 'General',
    price: 100, customerPhone: phone, status: TicketStatus.CHECKED_IN,
  });
  return seeded;
}

describe('ReviewService', () => {
  let buyer: IBuyer;

  beforeAll(async () => {
    await connectTestDb();
    await Review.init(); // unique (eventId, buyerId) index must exist before duplicate tests
  });
  beforeEach(async () => {
    buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Reviewer', username: 'reviewer_one' });
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('verified ticket-holder reviews an ended event; duplicates 409', async () => {
    const seeded = await seedEndedEventWithTicket();
    const review = await ReviewService.submitReview(seeded.eventId, buyer, { rating: 5, text: 'Unreal night' });
    expect(review.verified).toBe(true);

    await expect(
      ReviewService.submitReview(seeded.eventId, buyer, { rating: 4 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects before the event ends (403) and without a ticket (403)', async () => {
    const live = await seedPublishedEvent(); // future event
    await expect(ReviewService.submitReview(live.eventId, buyer, { rating: 5 }))
      .rejects.toMatchObject({ statusCode: 403, message: 'Reviews open after the event ends' });

    const ended = await seedPublishedEvent();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Event.updateOne({ _id: ended.eventId }, { eventDate: past, startTime: past, endTime: past });
    await expect(ReviewService.submitReview(ended.eventId, buyer, { rating: 5 }))
      .rejects.toMatchObject({ statusCode: 403, message: 'Only ticket holders can review this event' });
  });

  it('aggregates average (1dp) and count; null when empty', async () => {
    const seeded = await seedEndedEventWithTicket();
    const other = await Buyer.create({ phone: '+26878000042', password: 'secret1', username: 'other_rev' });
    await Ticket.create({
      eventId: seeded.eventId, vendorId: seeded.vendorId, ticketType: 'General',
      price: 100, customerPhone: '+26878000042', status: TicketStatus.CHECKED_IN,
    });
    await ReviewService.submitReview(seeded.eventId, buyer, { rating: 5 });
    await ReviewService.submitReview(seeded.eventId, other, { rating: 4 });

    expect(await ReviewService.eventAggregate(seeded.eventId)).toEqual({ average: 4.5, count: 2 });
    expect(await ReviewService.vendorAggregate(seeded.vendorId)).toEqual({ average: 4.5, count: 2 });
    expect(await ReviewService.eventAggregate(String(seeded.eventId).replace(/./g, 'a').slice(0, 24)))
      .toEqual({ average: null, count: 0 });
  });

  it('organizer replies exactly once, own events only; reviewer summary has no phone', async () => {
    const seeded = await seedEndedEventWithTicket();
    const review = await ReviewService.submitReview(seeded.eventId, buyer, { rating: 3, text: 'Sound was late' });

    await expect(
      ReviewService.replyToReview(String(review._id), 'aaaaaaaaaaaaaaaaaaaaaaaa', false, 'Sorry!')
    ).rejects.toMatchObject({ statusCode: 403 });

    const replied = await ReviewService.replyToReview(String(review._id), seeded.vendorId, false, 'Fixed for next time');
    expect(replied.organizerReply!.text).toBe('Fixed for next time');
    expect(JSON.stringify(replied)).not.toContain(PHONE);

    await expect(
      ReviewService.replyToReview(String(review._id), seeded.vendorId, false, 'Again')
    ).rejects.toMatchObject({ statusCode: 409 });

    const list = await ReviewService.listEventReviews(seeded.eventId);
    expect(list[0]!.reviewer.username).toBe('reviewer_one');
    expect(list[0]!.organizerReply!.text).toBe('Fixed for next time');
  });
});
