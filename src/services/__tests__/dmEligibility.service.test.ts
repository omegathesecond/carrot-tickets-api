import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { MeetupRequest } from '@models/meetupRequest.model';
import { BlockService } from '@services/block.service';
import { DmEligibilityService } from '@services/dmEligibility.service';

const seed = (phone: string) => Buyer.create({ phone, password: 'secret1', name: `B${phone.slice(-4)}` });
const befriend = async (a: IBuyer, b: IBuyer) => {
  await Follow.create({ followerType: 'buyer', followerId: a._id, targetType: 'buyer', targetId: b._id });
  await Follow.create({ followerType: 'buyer', followerId: b._id, targetType: 'buyer', targetId: a._id });
};
const acceptMeetup = (a: IBuyer, b: IBuyer) =>
  MeetupRequest.create({ requesterId: a._id, targetId: b._id, status: 'accepted' });

describe('DmEligibilityService', () => {
  beforeAll(async () => {
    await connectTestDb();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('a stranger is NOT eligible', async () => {
    const a = await seed('+26878020001');
    const b = await seed('+26878020002');
    expect(await DmEligibilityService.canDm(String(a._id), String(b._id))).toBe(false);
  });
  it('a mutual-follow friend is eligible', async () => {
    const a = await seed('+26878020003');
    const b = await seed('+26878020004');
    await befriend(a, b);
    expect(await DmEligibilityService.canDm(String(a._id), String(b._id))).toBe(true);
  });
  it('an accepted meetup (either direction) is eligible', async () => {
    const a = await seed('+26878020005');
    const b = await seed('+26878020006');
    await acceptMeetup(b, a); // b requested a
    expect(await DmEligibilityService.canDm(String(a._id), String(b._id))).toBe(true);
  });
  it('a block beats an accepted meetup', async () => {
    const a = await seed('+26878020007');
    const b = await seed('+26878020008');
    await acceptMeetup(a, b);
    await BlockService.block(a, String(b._id));
    expect(await DmEligibilityService.canDm(String(a._id), String(b._id))).toBe(false);
    expect(await DmEligibilityService.canDm(String(b._id), String(a._id))).toBe(false);
  });
  it('canDmMap returns only eligible, non-blocked ids', async () => {
    const me = await seed('+26878020009');
    const friend = await seed('+26878020010');
    await befriend(me, friend);
    const met = await seed('+26878020011');
    await acceptMeetup(me, met);
    const stranger = await seed('+26878020012');
    const blocked = await seed('+26878020013');
    await acceptMeetup(me, blocked);
    await BlockService.block(me, String(blocked._id));
    const ids = [friend, met, stranger, blocked].map((b) => String(b._id));
    const set = await DmEligibilityService.canDmMap(String(me._id), ids);
    expect(set.has(String(friend._id))).toBe(true);
    expect(set.has(String(met._id))).toBe(true);
    expect(set.has(String(stranger._id))).toBe(false);
    expect(set.has(String(blocked._id))).toBe(false);
  });
});
