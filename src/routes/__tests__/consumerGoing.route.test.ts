import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';

const PHONE = '+26878422613';

describe('GET /api/social/me/going', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns joined events and events with a live ticket, de-duped', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });

    const joined = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'Joined', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });
    const c = await Community.create({ eventId: joined._id, vendorId: joined.vendorId });
    await Membership.create({ buyerId: buyer._id, communityId: c._id, role: 'member' });

    const ticketed = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'Ticketed', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });
    await Ticket.create({ eventId: ticketed._id, vendorId: ticketed.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.SOLD });

    const res = await request(app).get('/api/social/me/going').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const names = res.body.data.events.map((e: any) => e.name);
    expect(names).toContain('Joined');
    expect(names).toContain('Ticketed');
    expect(names).toHaveLength(2);
  });

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/me/going').expect(401);
  });
});
