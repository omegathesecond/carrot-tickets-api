import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { CommunityService } from '@services/community.service';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Channel } from '@models/channel.model';
import { Community } from '@models/community.model';

/**
 * True membership parity: an organizer brand that does NOT own the event can
 * still join its community, post as the brand, and appear in the roster — the
 * same as a buyer, but rendered with organizer identity.
 */
describe('vendor community membership (non-owner brand)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  let seq = 0;
  async function makeBrand(name: string) {
    return Vendor.create({ businessName: name, email: `brand${++seq}@example.com`, password: 'secret123' });
  }

  async function seedForeignCommunity() {
    const owner = await makeBrand('Host Co');
    const seeded = await seedPublishedEvent({ vendorId: owner._id });
    await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
    return seeded.eventId;
  }

  it('a non-owner brand joins as a plain member and can post as the brand', async () => {
    const eventId = await seedForeignCommunity();
    const guest = await makeBrand('Guest Brand');
    const token = `Bearer ${signVendorToken(String(guest._id))}`;

    const joined = await request(app).post(`/api/community/${eventId}/join`).set('Authorization', token).expect(200);
    expect(joined.body.data.membership.role).toBe('member');

    const community = await Community.findOne({ eventId });
    const general = await Channel.findOne({ communityId: community!._id, slug: 'general' });
    const posted = await request(app)
      .post(`/api/community/channels/${general!._id}/messages`)
      .set('Authorization', token)
      .send({ body: 'excited to be here!' })
      .expect(201);
    expect(posted.body.data.senderType).toBe('organizer');
    expect(posted.body.data.sender.name).toBe('Guest Brand');
  });

  it('the brand member shows up in the roster as an organizer row alongside buyers', async () => {
    const eventId = await seedForeignCommunity();
    const guest = await makeBrand('Roster Brand');
    await Buyer.create({ phone: '+26878422613', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'A Buyer', username: 'a_buyer' });

    await request(app).post(`/api/community/${eventId}/join`).set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    await request(app).post(`/api/community/${eventId}/join`).set('Authorization', `Bearer ${signVendorToken(String(guest._id))}`).expect(200);

    const res = await request(app).get(`/api/community/${eventId}/members`).expect(200);
    const rows = res.body.data;
    const brandRow = rows.find((r: any) => r.type === 'organizer');
    const buyerRow = rows.find((r: any) => r.type === 'buyer');
    expect(brandRow).toBeTruthy();
    expect(brandRow.id).toBe(String(guest._id));
    expect(brandRow.name).toBe('Roster Brand');
    expect(brandRow.username).toBeNull();
    expect(buyerRow).toBeTruthy();
    expect(buyerRow.username).toBe('a_buyer');
  });

  it('a non-owner brand cannot post in a gated (ticket-holder) channel', async () => {
    const eventId = await seedForeignCommunity();
    const guest = await makeBrand('Gate Brand');
    const token = `Bearer ${signVendorToken(String(guest._id))}`;
    await request(app).post(`/api/community/${eventId}/join`).set('Authorization', token).expect(200);

    const community = await Community.findOne({ eventId });
    const gated = await Channel.findOne({ communityId: community!._id, gated: true });
    await request(app)
      .post(`/api/community/channels/${gated!._id}/messages`)
      .set('Authorization', token)
      .send({ body: 'sneaking into ticket-holders' })
      .expect(403);
  });

  it('the brand member reads channel history via the member path (not the owner peek)', async () => {
    const eventId = await seedForeignCommunity();
    const guest = await makeBrand('Reader Brand');
    const token = `Bearer ${signVendorToken(String(guest._id))}`;
    await request(app).post(`/api/community/${eventId}/join`).set('Authorization', token).expect(200);

    const community = await Community.findOne({ eventId });
    const general = await Channel.findOne({ communityId: community!._id, slug: 'general' });
    await request(app).post(`/api/community/channels/${general!._id}/messages`).set('Authorization', token).send({ body: 'first post' }).expect(201);

    const res = await request(app).get(`/api/community/channels/${general!._id}/messages`).set('Authorization', token).expect(200);
    expect(res.body.data.map((m: any) => m.body)).toContain('first post');
  });
});
