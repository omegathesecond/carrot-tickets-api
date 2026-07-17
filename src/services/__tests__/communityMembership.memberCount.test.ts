import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { CommunityMembershipService } from '@services/communityMembership.service';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Buyer } from '@models/buyer.model';

describe('CommunityView.memberCount', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedBuyer(phone: string) {
    return Buyer.create({ phone, password: 'secret1', username: `u${phone.replace(/\+/g, '')}` });
  }

  it('counts members, excluding banned ones', async () => {
    const eventId = new mongoose.Types.ObjectId().toString();
    const community = await Community.create({ eventId, vendorId: new mongoose.Types.ObjectId() });

    const me = await seedBuyer('+26800000001');
    const other = await seedBuyer('+26800000002');
    const banned = await seedBuyer('+26800000003');

    await Membership.create({ buyerId: me._id, communityId: community._id });
    await Membership.create({ buyerId: other._id, communityId: community._id });
    await Membership.create({ buyerId: banned._id, communityId: community._id, bannedAt: new Date() });

    const view = await CommunityMembershipService.getView(eventId, me as any);

    // 3 memberships exist; the banned one must not be counted.
    expect(view.memberCount).toBe(2);
  });

  it('does not count members of a different community', async () => {
    const eventId = new mongoose.Types.ObjectId().toString();
    const community = await Community.create({ eventId, vendorId: new mongoose.Types.ObjectId() });
    const otherCommunity = await Community.create({
      eventId: new mongoose.Types.ObjectId().toString(),
      vendorId: new mongoose.Types.ObjectId(),
    });

    const me = await seedBuyer('+26800000001');
    const stranger = await seedBuyer('+26800000002');
    await Membership.create({ buyerId: me._id, communityId: community._id });
    await Membership.create({ buyerId: stranger._id, communityId: otherCommunity._id });

    const view = await CommunityMembershipService.getView(eventId, me as any);
    expect(view.memberCount).toBe(1);
  });
});
