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
import { Vendor } from '@models/vendor.model';

const PHONE = '+26878422613';

let ownerSeq = 0;
async function seedOwnedCommunity() {
  // A REAL Vendor doc (not a bare ObjectId) so senderVendorId populates and a
  // brand-authored message renders with organizer identity.
  const vendor = await Vendor.create({
    businessName: `Owner Brand ${++ownerSeq}`,
    email: `owner${ownerSeq}@example.com`,
    password: 'secret123',
  });
  const seeded = await seedPublishedEvent({ vendorId: vendor._id });
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

  it("lets a non-managing brand view a community it can join (true parity — no longer 403)", async () => {
    const { eventId } = await seedOwnedCommunity();
    const otherVendorId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .get(`/api/community/${eventId}`)
      .set('Authorization', `Bearer ${signVendorToken(otherVendorId)}`)
      .expect(200);

    // Not the owner peek and not yet a member: a plain "can join" view.
    expect(res.body.data.membership).toBeNull();
    expect(res.body.data.viewerRole).toBeUndefined();
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

  it('requires a brand to JOIN before posting (403 until it does), then lets it post as the brand', async () => {
    const { eventId, vendorId } = await seedOwnedCommunity();
    const community = await Community.findOne({ eventId });
    const general = await Channel.findOne({ communityId: community!._id, slug: 'general' });
    const token = `Bearer ${signVendorToken(vendorId)}`;

    // Not a member yet → 403 "Join the community first" (no longer a blanket 401).
    await request(app)
      .post(`/api/community/channels/${general!._id}/messages`)
      .set('Authorization', token)
      .send({ body: 'before joining' })
      .expect(403);

    // Join, then post — the message is attributed to the brand (organizer).
    await request(app).post(`/api/community/${eventId}/join`).set('Authorization', token).expect(200);
    const posted = await request(app)
      .post(`/api/community/channels/${general!._id}/messages`)
      .set('Authorization', token)
      .send({ body: 'hello from the brand' })
      .expect(201);
    expect(posted.body.data.senderType).toBe('organizer');
    expect(posted.body.data.body).toBe('hello from the brand');
  });

  it('lets a brand JOIN the community (true parity) — the managing brand joins as an organizer-role member', async () => {
    const { eventId, vendorId } = await seedOwnedCommunity();

    const res = await request(app)
      .post(`/api/community/${eventId}/join`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(200);

    // The owner joins as 'organizer' (every channel unlocked, may post in
    // organizer-only channels).
    expect(res.body.data.membership).not.toBeNull();
    expect(res.body.data.membership.role).toBe('organizer');
  });
});
