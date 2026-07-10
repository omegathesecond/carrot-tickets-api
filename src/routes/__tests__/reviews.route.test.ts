import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Review } from '@models/review.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const PHONE = '+26878422613';

function signVendorToken(vendorId: string, permissions: string[] = [TicketsPermission.EDIT_EVENT]): string {
  return jwt.sign(
    { app: 'tickets', vendorId, userType: 'vendor', isSuperAdmin: false, role: 'owner', permissions },
    JWT_SECRET
  );
}

async function seedEndedWithTicket() {
  const seeded = await seedPublishedEvent();
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await Event.updateOne({ _id: seeded.eventId }, { eventDate: past, startTime: past, endTime: past });
  await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Reviewer', username: 'reviewer_one' });
  await Ticket.create({
    eventId: seeded.eventId, vendorId: seeded.vendorId, ticketType: 'General',
    price: 100, customerPhone: PHONE, status: TicketStatus.CHECKED_IN,
  });
  return seeded;
}

describe('review routes', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Review.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('buyer posts, public reads with aggregate, vendor replies', async () => {
    const seeded = await seedEndedWithTicket();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    const posted = await request(app)
      .post(`/api/public/events/${seeded.eventId}/reviews`)
      .set('Authorization', auth)
      .send({ rating: 5, text: 'Unreal night' })
      .expect(201);
    expect(posted.body.data.reviewer.username).toBe('reviewer_one');

    // public read, NO auth header
    const pub = await request(app).get(`/api/public/events/${seeded.eventId}/reviews`).expect(200);
    expect(pub.body.data.aggregate).toEqual({ average: 5, count: 1 });
    expect(pub.body.data.reviews).toHaveLength(1);
    expect(JSON.stringify(pub.body.data)).not.toContain(PHONE);

    await request(app)
      .post(`/api/tickets/reviews/${posted.body.data.id}/reply`)
      .set('Authorization', `Bearer ${signVendorToken(seeded.vendorId)}`)
      .send({ text: 'Thank you!' })
      .expect(200);

    const after = await request(app).get(`/api/public/events/${seeded.eventId}/reviews`).expect(200);
    expect(after.body.data.reviews[0].organizerReply.text).toBe('Thank you!');
  });

  it('write requires auth (401), bad rating 400, double review 409, wrong vendor reply 403', async () => {
    const seeded = await seedEndedWithTicket();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    await request(app).post(`/api/public/events/${seeded.eventId}/reviews`).send({ rating: 5 }).expect(401);
    await request(app).post(`/api/public/events/${seeded.eventId}/reviews`).set('Authorization', auth)
      .send({ rating: 6 }).expect(400);

    const first = await request(app).post(`/api/public/events/${seeded.eventId}/reviews`).set('Authorization', auth)
      .send({ rating: 4 }).expect(201);
    await request(app).post(`/api/public/events/${seeded.eventId}/reviews`).set('Authorization', auth)
      .send({ rating: 4 }).expect(409);

    await request(app)
      .post(`/api/tickets/reviews/${first.body.data.id}/reply`)
      .set('Authorization', `Bearer ${signVendorToken('aaaaaaaaaaaaaaaaaaaaaaaa')}`)
      .send({ text: 'not mine' })
      .expect(403);
  });

  it('malformed ids are clean 400s, never 500s', async () => {
    await request(app).get('/api/public/events/not-an-id/reviews').expect(400);

    const seeded = await seedEndedWithTicket();
    await request(app)
      .post('/api/tickets/reviews/not-an-id/reply')
      .set('Authorization', `Bearer ${signVendorToken(seeded.vendorId)}`)
      .send({ text: 'hi' })
      .expect(400);

    const buyerAuth = `Bearer ${signBuyerToken(PHONE)}`;
    await Buyer.create({ phone: PHONE, password: 'secret1' }).catch(() => null);
    await request(app)
      .post('/api/public/events/not-an-id/reviews')
      .set('Authorization', buyerAuth)
      .send({ rating: 5 })
      .expect(400);

    await request(app)
      .get('/api/public/events/aaaaaaaaaaaaaaaaaaaaaaaa/reviews?after=aaaaaaaaaaaaaaaaaaaaaaaa')
      .expect(400);
  });
});
