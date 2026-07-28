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

  it('creates a PENDING_APPROVAL event owned by the buyer, with an uploaded poster', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Lister' });
    const req = request(app)
      .post('/api/public/events/submit')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`);
    Object.entries(fields()).forEach(([k, v]) => req.field(k, v));
    req.attach('poster', Buffer.from('fake-jpeg'), { filename: 'poster.jpg', contentType: 'image/jpeg' });
    req.attach('media', Buffer.from('fake-jpeg-2'), { filename: 'crowd.jpg', contentType: 'image/jpeg' });

    const res = await req.expect(201);
    expect(res.body.data.status).toBe(EventStatus.PENDING_APPROVAL);
    expect(res.body.data.submittedByBuyerId).toBe(String(buyer._id));
    expect(res.body.data.vendorId).toBeFalsy();
    expect(res.body.data.posterUrl).toContain('/poster/');
    expect(res.body.data.galleryImages).toHaveLength(1);
    expect(R2Service.uploadEventMedia).toHaveBeenCalledTimes(2); // poster + 1 media

    // Pending → hidden from the public listing (which filters status=PUBLISHED).
    const list = await request(app).get('/api/public/events').expect(200);
    const ids = (list.body.data.events as any[]).map((e) => e._id);
    expect(ids).not.toContain(String(res.body.data._id));
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
