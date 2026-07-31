import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { R2Service } from '@utils/r2.service';

// Never hit real R2 — return a deterministic URL per upload.
jest.mock('@utils/r2.service', () => ({
  R2Service: {
    uploadEventMedia: jest.fn(async (eventId: string, type: string, name: string) => ({
      key: `events/${eventId}/${type}/${name}`,
      url: `https://cdn.test/${eventId}/${type}/${name}`,
    })),
  },
}));

const PHONE = '+26878422613';

// eventDate must be in the future (createEventSchema enforces .min('now')).
function futureIso(daysAhead: number, hour = 18): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function fields(over: Record<string, string> = {}): Record<string, string> {
  return {
    name: 'Community Rooftop Jam',
    venue: 'The Roof, Mbabane',
    eventDate: futureIso(10),
    startTime: futureIso(10, 18),
    endTime: futureIso(10, 23),
    category: 'Music',
    ticketing: 'external',
    externalTicketUrl: 'https://tickets.example.com/jam',
    description: 'A community-listed rooftop session.',
    ...over,
  };
}

describe('POST /api/public/events/submit (community self-listing)', () => {
  beforeAll(connectTestDb);
  afterEach(async () => { await clearTestDb(); jest.clearAllMocks(); });
  afterAll(disconnectTestDb);

  it('rejects an anonymous submit', async () => {
    await request(app).post('/api/public/events/submit').field(fields()).expect(401);
  });

  it('publishes the event immediately (no admin review) with an uploaded poster', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Lister' });
    const req = request(app)
      .post('/api/public/events/submit')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`);
    Object.entries(fields()).forEach(([k, v]) => req.field(k, v));
    req.attach('poster', Buffer.from('fake-jpeg'), { filename: 'poster.jpg', contentType: 'image/jpeg' });
    req.attach('media', Buffer.from('fake-jpeg-2'), { filename: 'crowd.jpg', contentType: 'image/jpeg' });

    const res = await req.expect(201);
    expect(res.body.data.status).toBe(EventStatus.PUBLISHED);
    expect(res.body.data.submittedByBuyerId).toBe(String(buyer._id));
    expect(res.body.data.vendorId).toBeFalsy();
    expect(res.body.data.posterUrl).toContain('/poster/');
    expect(res.body.data.galleryImages).toHaveLength(1);
    expect(R2Service.uploadEventMedia).toHaveBeenCalledTimes(2); // poster + 1 media

    // Live on the public listing right away — no approval step, and a
    // vendor-less event must survive the organizer hydration there.
    const list = await request(app).get('/api/public/events').expect(200);
    const listed = (list.body.data.events as any[]).find((e) => e._id === String(res.body.data._id));
    expect(listed).toBeTruthy();
    expect(listed.posterUrl).toContain('/poster/');
    expect(listed.organizer ?? null).toBeNull();
  });

  // The poster upload happens AFTER the row is created; publishing before it
  // lands would put a posterless event on the feed and leave it there when the
  // upload fails. It must stay an invisible draft instead.
  it('leaves nothing published when the poster upload fails', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Lister' });
    (R2Service.uploadEventMedia as jest.Mock).mockRejectedValueOnce(new Error('R2 down'));
    const req = request(app)
      .post('/api/public/events/submit')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`);
    Object.entries(fields()).forEach(([k, v]) => req.field(k, v));
    req.attach('poster', Buffer.from('fake-jpeg'), { filename: 'poster.jpg', contentType: 'image/jpeg' });

    await req.expect(500);
    expect(await Event.countDocuments({ status: EventStatus.PUBLISHED })).toBe(0);
  });

  it('refuses to create sellable ticket types (selling is dashboard-only)', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Lister' });
    const req = request(app)
      .post('/api/public/events/submit')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`);
    const withTiers = fields({
      ticketing: 'carrot',
      ticketTypes: JSON.stringify([{ name: 'General Admission', price: 100, quantity: 50 }]),
    });
    delete withTiers.externalTicketUrl;
    Object.entries(withTiers).forEach(([k, v]) => req.field(k, v));
    req.attach('poster', Buffer.from('fake-jpeg'), { filename: 'poster.jpg', contentType: 'image/jpeg' });

    const res = await req.expect(400);
    expect(res.body.message).toMatch(/organizer dashboard/i);
    expect(await Event.countDocuments({})).toBe(0);
  });

  it('lists a ticketless event (calendar/feed only) with no ticket types', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Lister' });
    const req = request(app)
      .post('/api/public/events/submit')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`);
    const noTickets = fields({ ticketing: 'carrot' });
    delete noTickets.externalTicketUrl;
    Object.entries(noTickets).forEach(([k, v]) => req.field(k, v));
    req.attach('poster', Buffer.from('fake-jpeg'), { filename: 'poster.jpg', contentType: 'image/jpeg' });

    const res = await req.expect(201);
    expect(res.body.data.ticketTypes).toHaveLength(0);
  });

  // Communities used to be created only by the superadmin publish path, which
  // a self-listing skips — leaving the event page's Community tab, its roster
  // and "Going" all 404, so the event could never reach anyone's calendar.
  it('creates the community so the roster and Going work on a listing', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Lister' });
    const req = request(app)
      .post('/api/public/events/submit')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`);
    const noTickets = fields({ ticketing: 'carrot' });
    delete noTickets.externalTicketUrl;
    Object.entries(noTickets).forEach(([k, v]) => req.field(k, v));
    req.attach('poster', Buffer.from('fake-jpeg'), { filename: 'poster.jpg', contentType: 'image/jpeg' });
    const eventId = (await req.expect(201)).body.data._id;

    // Public who's-going view resolves (no organizer behind it).
    await request(app).get(`/api/community/${eventId}`).expect(200);

    // And a buyer with no ticket can say they're going — a listing sells
    // nothing, so ticket verification must not gate the join.
    const other = '+26878000099';
    await Buyer.create({ phone: other, password: 'secret1', name: 'Attendee' });
    await request(app)
      .post(`/api/community/${eventId}/join`)
      .set('Authorization', `Bearer ${signBuyerToken(other)}`)
      .expect(200);

    const roster = await request(app).get(`/api/community/${eventId}/members`).expect(200);
    expect(roster.body.data).toHaveLength(1);
  });

  it('requires a poster image', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Lister' });
    const req = request(app)
      .post('/api/public/events/submit')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`);
    Object.entries(fields()).forEach(([k, v]) => req.field(k, v));
    await req.expect(400); // no poster attached
    expect(await Event.countDocuments({})).toBe(0);
  });
});
