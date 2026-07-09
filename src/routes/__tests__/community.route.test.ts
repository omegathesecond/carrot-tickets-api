import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { CommunityService } from '@services/community.service';

const PHONE = '+26878422613';

async function seedCommunityEvent() {
  const seeded = await seedPublishedEvent();
  await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
  return seeded;
}

async function seedBuyer(phone = PHONE) {
  return Buyer.create({ phone, password: 'secret1', name: 'Test Buyer' });
}

describe('community routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('rejects unauthenticated requests', async () => {
    const { eventId } = await seedCommunityEvent();
    await request(app).get(`/api/community/${eventId}`).expect(401);
  });

  it('join creates a membership, assigns a username, and lists channels with locked flags', async () => {
    const { eventId } = await seedCommunityEvent();
    await seedBuyer();

    const res = await request(app)
      .post(`/api/community/${eventId}/join`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const view = res.body.data;
    expect(view.eventId).toBe(eventId);
    expect(view.membership.role).toBe('member');
    expect(view.membership.ticketVerified).toBe(false);

    const slugs = view.channels.map((c: any) => c.slug).sort();
    expect(slugs).toEqual(['announcements', 'attendees', 'general']);
    const attendees = view.channels.find((c: any) => c.slug === 'attendees');
    expect(attendees.locked).toBe(true); // no ticket yet

    const buyer = await Buyer.findOne({ phone: PHONE });
    expect(buyer!.username).toBeTruthy(); // lazy backfill ran
  });

  it('join unlocks gated channels for a ticket holder', async () => {
    const { eventId, vendorId } = await seedCommunityEvent();
    await seedBuyer();
    await Ticket.create({
      eventId, vendorId, ticketType: 'General', price: 100,
      customerPhone: PHONE, status: TicketStatus.SOLD,
    });

    const res = await request(app)
      .post(`/api/community/${eventId}/join`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    expect(res.body.data.membership.ticketVerified).toBe(true);
    const attendees = res.body.data.channels.find((c: any) => c.slug === 'attendees');
    expect(attendees.locked).toBe(false);
  });

  it('verify-ticket upgrades a member after a later purchase', async () => {
    const { eventId, vendorId } = await seedCommunityEvent();
    await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    await request(app).post(`/api/community/${eventId}/join`).set('Authorization', auth).expect(200);

    await Ticket.create({
      eventId, vendorId, ticketType: 'General', price: 100,
      customerPhone: PHONE, status: TicketStatus.SOLD,
    });

    const res = await request(app)
      .post(`/api/community/${eventId}/verify-ticket`)
      .set('Authorization', auth)
      .expect(200);

    expect(res.body.data.membership.ticketVerified).toBe(true);
  });

  it('404s for an event without a community', async () => {
    await seedBuyer();
    const { eventId } = await seedPublishedEvent(); // NO ensureForEvent
    await request(app)
      .get(`/api/community/${eventId}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(404);
  });
});
