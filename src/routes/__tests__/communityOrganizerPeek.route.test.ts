import mongoose from 'mongoose';
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { CommunityService } from '@services/community.service';
import { Channel } from '@models/channel.model';
import { Community } from '@models/community.model';
import { Message } from '@models/message.model';
import { Buyer } from '@models/buyer.model';

const PHONE = '+26878422613';

async function seedOwnedCommunity() {
  const vendorId = new mongoose.Types.ObjectId();
  const seeded = await seedPublishedEvent({ vendorId });
  await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
  return seeded; // vendorId === the community owner
}

describe('community organizer read-only peek', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets the managing organizer view the community read-only (viewerRole=organizer, no membership, all channels unlocked)', async () => {
    const { eventId, vendorId } = await seedOwnedCommunity();

    const res = await request(app)
      .get(`/api/community/${eventId}`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(200);

    const view = res.body.data;
    expect(view.viewerRole).toBe('organizer');
    expect(view.membership).toBeNull();
    // The organizer owns the event, so even the gated 'attendees' channel is
    // visible/unlocked — no ticket required.
    const slugs = view.channels.map((c: any) => c.slug).sort();
    expect(slugs).toEqual(['announcements', 'attendees', 'general']);
    expect(view.channels.every((c: any) => c.locked === false)).toBe(true);
  });

  it("403s when a vendor peeks an event they don't manage", async () => {
    const { eventId } = await seedOwnedCommunity();
    const otherVendorId = new mongoose.Types.ObjectId().toString();

    await request(app)
      .get(`/api/community/${eventId}`)
      .set('Authorization', `Bearer ${signVendorToken(otherVendorId)}`)
      .expect(403);
  });

  it('lets the managing organizer list members without a membership of their own', async () => {
    const { eventId, vendorId } = await seedOwnedCommunity();

    // A buyer joins so there's someone to list.
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Test Buyer' });
    await request(app)
      .post(`/api/community/${eventId}/join`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const res = await request(app)
      .get(`/api/community/${eventId}/members`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
  });

  it('lets the managing organizer read a channel message history', async () => {
    const { eventId, vendorId } = await seedOwnedCommunity();
    const community = await Community.findOne({ eventId });
    const general = await Channel.findOne({ communityId: community!._id, slug: 'general' });
    await Message.create({ channelId: general!._id, communityId: community!._id, senderVendorId: vendorId, body: 'Welcome all' });

    const res = await request(app)
      .get(`/api/community/channels/${general!._id}/messages`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(200);

    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].body).toBe('Welcome all');
  });

  it('still refuses organizer WRITES — posting a message is buyer-only (401)', async () => {
    const { eventId, vendorId } = await seedOwnedCommunity();
    const community = await Community.findOne({ eventId });
    const general = await Channel.findOne({ communityId: community!._id, slug: 'general' });

    await request(app)
      .post(`/api/community/channels/${general!._id}/messages`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .send({ body: 'organizers cannot post here' })
      .expect(401);
  });

  it('still refuses organizer join — a vendor cannot become a member (401)', async () => {
    const { eventId, vendorId } = await seedOwnedCommunity();

    await request(app)
      .post(`/api/community/${eventId}/join`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(401);
  });
});
