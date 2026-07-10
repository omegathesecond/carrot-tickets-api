import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Event } from '@models/event.model';
import { Membership } from '@models/membership.model';
import { Channel } from '@models/channel.model';
import { CommunityService } from '@services/community.service';
import { MessageService } from '@services/message.service';
import { DmThreadService } from '@services/dmThread.service';
import { ReviewService } from '@services/review.service';
import { FollowService } from '@services/follow.service';
import { CommunityMembershipService } from '@services/communityMembership.service';
import { resetBuckets } from '@utils/rateLimit.util';

const SUSPENDED = 'Your community access is suspended';

async function suspendedBuyer(phone: string): Promise<IBuyer> {
  return Buyer.create({ phone, password: 'secret1', name: 'Suspended One', socialSuspendedAt: new Date() });
}

describe('platform social suspension — enforcement', () => {
  beforeAll(connectTestDb);
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('WRITE paths reject a suspended buyer with 403', () => {
    it('channel message send', async () => {
      const buyer = await suspendedBuyer('+26878100001');
      const seeded = await seedPublishedEvent();
      const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
      const general = (await Channel.findOne({ communityId: community._id, slug: 'general' }))!;
      await Membership.create({ buyerId: buyer._id, communityId: community._id });

      await expect(
        MessageService.sendMessage(String(general._id), buyer, { body: 'hi' })
      ).rejects.toMatchObject({ statusCode: 403, message: SUSPENDED });
    });

    it('DM message send', async () => {
      const buyer = await suspendedBuyer('+26878100002');
      const other = await Buyer.create({ phone: '+26878100003', password: 'secret1', name: 'Other' });
      const thread = await mongoose.model('DmThread').create({
        participants: [buyer._id, other._id],
        isGroup: false,
        createdBy: other._id,
        pairKey: DmThreadService.pairKeyFor(String(buyer._id), String(other._id)),
      });

      await expect(
        MessageService.sendDmMessage(String(thread._id), buyer, { body: 'hi' })
      ).rejects.toMatchObject({ statusCode: 403, message: SUSPENDED });
    });

    it('DM thread create', async () => {
      const buyer = await suspendedBuyer('+26878100004');
      const other = await Buyer.create({ phone: '+26878100005', password: 'secret1', name: 'Other' });

      await expect(
        DmThreadService.openThread(buyer, [String(other._id)])
      ).rejects.toMatchObject({ statusCode: 403, message: SUSPENDED });
    });

    it('review create', async () => {
      const buyer = await suspendedBuyer('+26878100006');
      const seeded = await seedPublishedEvent();
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await Event.updateOne({ _id: seeded.eventId }, { eventDate: past, startTime: past, endTime: past });
      await Ticket.create({
        eventId: seeded.eventId, vendorId: seeded.vendorId, ticketType: 'General',
        price: 100, customerPhone: '+26878100006', status: TicketStatus.CHECKED_IN,
      });

      await expect(
        ReviewService.submitReview(seeded.eventId, buyer, { rating: 5 })
      ).rejects.toMatchObject({ statusCode: 403, message: SUSPENDED });
    });

    it('follow create', async () => {
      const buyer = await suspendedBuyer('+26878100007');
      const other = await Buyer.create({ phone: '+26878100008', password: 'secret1', name: 'Other' });

      await expect(
        FollowService.follow(buyer, 'buyer', String(other._id))
      ).rejects.toMatchObject({ statusCode: 403, message: SUSPENDED });
    });

    it('community join', async () => {
      const buyer = await suspendedBuyer('+26878100009');
      const seeded = await seedPublishedEvent();

      await expect(
        CommunityMembershipService.join(seeded.eventId, buyer)
      ).rejects.toMatchObject({ statusCode: 403, message: SUSPENDED });
    });
  });

  describe('untouched paths — suspension is NOT enforced', () => {
    it('a suspended buyer can still hit the My-Tickets lookup (GET /api/public/my-tickets)', async () => {
      const PHONE = '+26878100010';
      await suspendedBuyer(PHONE);
      const seeded = await seedPublishedEvent();
      await Ticket.create({
        eventId: seeded.eventId, vendorId: seeded.vendorId, ticketType: 'General',
        price: 100, customerPhone: PHONE, status: TicketStatus.SOLD,
      });

      const res = await request(app)
        .get('/api/public/my-tickets')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(res.body.data).toHaveLength(1);
    });
  });
});
