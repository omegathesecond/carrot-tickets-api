import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { MeetupRequest } from '@models/meetupRequest.model';
import { BlockService } from '@services/block.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { MeetupService } from '@services/meetup.service';

const mk = (phone: string, username: string) =>
  Buyer.create({ phone, password: 'secret1', name: username, username });

describe('MeetupService', () => {
  beforeAll(async () => {
    await connectTestDb();
    await MeetupRequest.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('request creates a pending row and is idempotent while pending', async () => {
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    const target = (await mk('+26878000001', 'target_a')) as IBuyer;
    const first = await MeetupService.request(me, String(target._id));
    expect(first.status).toBe('pending');
    const again = await MeetupService.request(me, String(target._id));
    expect(again.id).toBe(first.id); // same row, no duplicate
    expect(await MeetupRequest.countDocuments({})).toBe(1);
  });

  it('rejects self-request, missing target, and blocked pairs', async () => {
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    await expect(MeetupService.request(me, String(me._id))).rejects.toMatchObject({ statusCode: 400 });
    await expect(MeetupService.request(me, '5f'.repeat(12))).rejects.toMatchObject({ statusCode: 404 });
    const blocker = (await mk('+26878000002', 'blocker_a')) as IBuyer;
    await BlockService.block(blocker, String(me._id)); // blocker blocked me
    await expect(MeetupService.request(me, String(blocker._id))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('accept sets accepted+respondedAt; only the target may accept', async () => {
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    const target = (await mk('+26878000001', 'target_a')) as IBuyer;
    const { id } = await MeetupService.request(me, String(target._id));
    await expect(MeetupService.accept(me, id)).rejects.toMatchObject({ statusCode: 403 }); // requester can't accept
    await MeetupService.accept(target, id);
    const row = await MeetupRequest.findById(id);
    expect(row!.status).toBe('accepted');
    expect(row!.respondedAt).toBeInstanceOf(Date);
  });

  it('re-request after decline flips the same row back to pending', async () => {
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    const target = (await mk('+26878000001', 'target_a')) as IBuyer;
    const { id } = await MeetupService.request(me, String(target._id));
    await MeetupService.decline(target, id);
    const reReq = await MeetupService.request(me, String(target._id));
    expect(reReq.id).toBe(id);
    expect(reReq.status).toBe('pending');
    expect(await MeetupRequest.countDocuments({})).toBe(1);
  });

  it('a pending request appears as an incoming row for the target; cancel removes it', async () => {
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    const target = (await mk('+26878000001', 'target_a')) as IBuyer;
    const { id } = await MeetupService.request(me, String(target._id));
    const pending = await MeetupService.listByStatus(target, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.direction).toBe('incoming');
    expect(pending[0]!.user.username).toBe('me_one');
    await expect(MeetupService.cancel(target, id)).rejects.toMatchObject({ statusCode: 403 }); // only requester cancels
    await MeetupService.cancel(me, id);
    expect(await MeetupRequest.countDocuments({})).toBe(0);
  });

  it('outgoingStatusMap maps target ids to the viewer request status', async () => {
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    const t1 = (await mk('+26878000001', 'target_a')) as IBuyer;
    const t2 = (await mk('+26878000002', 'target_b')) as IBuyer;
    await MeetupService.request(me, String(t1._id));
    const map = await MeetupService.outgoingStatusMap(String(me._id), [String(t1._id), String(t2._id)]);
    expect(map.get(String(t1._id))?.status).toBe('pending');
    expect(map.has(String(t2._id))).toBe(false);
  });

  it('decline sends no notification', async () => {
    const spy = jest.spyOn(NotificationDispatcher, 'dispatchAsync');
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    const target = (await mk('+26878000001', 'target_a')) as IBuyer;
    const { id } = await MeetupService.request(me, String(target._id));
    spy.mockClear(); // drop the meetup_request call from request()
    await MeetupService.decline(target, id);
    const acceptedCalls = spy.mock.calls.filter((call) => call[1] === 'meetup_accepted');
    expect(acceptedCalls).toHaveLength(0);
    spy.mockRestore();
  });

  it('rejects terminal-state transitions with 409', async () => {
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    const declinedTarget = (await mk('+26878000001', 'target_a')) as IBuyer;
    const { id: declinedId } = await MeetupService.request(me, String(declinedTarget._id));
    await MeetupService.decline(declinedTarget, declinedId);
    await expect(MeetupService.accept(declinedTarget, declinedId)).rejects.toMatchObject({ statusCode: 409 });

    const acceptedTarget = (await mk('+26878000002', 'target_b')) as IBuyer;
    const { id: acceptedId } = await MeetupService.request(me, String(acceptedTarget._id));
    await MeetupService.accept(acceptedTarget, acceptedId);
    await expect(MeetupService.decline(acceptedTarget, acceptedId)).rejects.toMatchObject({ statusCode: 409 });
    await expect(MeetupService.cancel(me, acceptedId)).rejects.toMatchObject({ statusCode: 409 });
  });

  describe('MeetupService.listByStatus (both directions)', () => {
    it('pending: returns incoming AND outgoing rows, tagged with direction and mapped to the OTHER party', async () => {
      const me = (await mk('+26878422613', 'me_one')) as IBuyer;
      const out = (await mk('+26878000001', 'target_out')) as IBuyer; // I requested them → outgoing
      const inc = (await mk('+26878000002', 'user_inc')) as IBuyer; // they requested me → incoming
      await MeetupService.request(me, String(out._id));
      await MeetupService.request(inc, String(me._id));

      const rows = await MeetupService.listByStatus(me, 'pending');
      expect(rows).toHaveLength(2);
      const byUser = new Map(rows.map((r) => [r.user.id, r]));
      expect(byUser.get(String(out._id))!.direction).toBe('outgoing');
      expect(byUser.get(String(inc._id))!.direction).toBe('incoming');
      expect(byUser.get(String(inc._id))!.user.username).toBe('user_inc');
    });

    it('declined: surfaces outgoing-declined so the requester can see who denied them', async () => {
      const me = (await mk('+26878422613', 'me_one')) as IBuyer;
      const target = (await mk('+26878000001', 'target_out')) as IBuyer;
      const { id } = await MeetupService.request(me, String(target._id));
      await MeetupService.decline(target, id); // target denies my outgoing request

      const rows = await MeetupService.listByStatus(me, 'declined');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.direction).toBe('outgoing');
      expect(rows[0]!.user.id).toBe(String(target._id));
    });

    it('accepted: returns both directions, each mapped to the OTHER party', async () => {
      const me = (await mk('+26878422613', 'me_one')) as IBuyer;
      const out = (await mk('+26878000001', 'out_l')) as IBuyer;
      const inc = (await mk('+26878000002', 'inc_l')) as IBuyer;
      const r1 = await MeetupService.request(me, String(out._id));
      await MeetupService.accept(out, r1.id);
      const r2 = await MeetupService.request(inc, String(me._id));
      await MeetupService.accept(me, r2.id);

      const rows = await MeetupService.listByStatus(me, 'accepted');
      expect(rows.map((r) => r.user.id).sort()).toEqual([String(out._id), String(inc._id)].sort());
      expect(rows.every((r) => r.status === 'accepted' && r.direction)).toBe(true);
    });
  });

  describe('MeetupService acceptance lookups', () => {
    it('areMeetupAccepted is true for an accepted row in either direction', async () => {
      const a = await Buyer.create({ phone: '+26878010001', password: 'secret1', name: 'A', username: 'a_user' });
      const b = await Buyer.create({ phone: '+26878010002', password: 'secret1', name: 'B', username: 'b_user' });
      await MeetupRequest.create({ requesterId: a._id, targetId: b._id, status: 'accepted' });
      expect(await MeetupService.areMeetupAccepted(String(a._id), String(b._id))).toBe(true);
      expect(await MeetupService.areMeetupAccepted(String(b._id), String(a._id))).toBe(true); // other direction
    });

    it('areMeetupAccepted is false for pending / declined / none', async () => {
      const a = await Buyer.create({ phone: '+26878010003', password: 'secret1', name: 'A', username: 'a_pend' });
      const b = await Buyer.create({ phone: '+26878010004', password: 'secret1', name: 'B', username: 'b_pend' });
      await MeetupRequest.create({ requesterId: a._id, targetId: b._id, status: 'pending' });
      expect(await MeetupService.areMeetupAccepted(String(a._id), String(b._id))).toBe(false);
      await MeetupRequest.updateOne({ requesterId: a._id, targetId: b._id }, { status: 'declined' });
      expect(await MeetupService.areMeetupAccepted(String(a._id), String(b._id))).toBe(false);
      const c = await Buyer.create({ phone: '+26878010005', password: 'secret1', name: 'C', username: 'c_none' });
      expect(await MeetupService.areMeetupAccepted(String(a._id), String(c._id))).toBe(false);
    });

    it('acceptedPartnerIds returns only accepted partners from the given set, both directions', async () => {
      const me = await Buyer.create({ phone: '+26878010006', password: 'secret1', name: 'Me', username: 'me_u' });
      const out = await Buyer.create({ phone: '+26878010007', password: 'secret1', name: 'O', username: 'out_u' }); // I requested them
      const inc = await Buyer.create({ phone: '+26878010008', password: 'secret1', name: 'I', username: 'inc_u' }); // they requested me
      const pen = await Buyer.create({ phone: '+26878010009', password: 'secret1', name: 'P', username: 'pen_u' }); // pending
      await MeetupRequest.create({ requesterId: me._id, targetId: out._id, status: 'accepted' });
      await MeetupRequest.create({ requesterId: inc._id, targetId: me._id, status: 'accepted' });
      await MeetupRequest.create({ requesterId: me._id, targetId: pen._id, status: 'pending' });
      const set = await MeetupService.acceptedPartnerIds(String(me._id), [String(out._id), String(inc._id), String(pen._id)]);
      expect(set.has(String(out._id))).toBe(true);
      expect(set.has(String(inc._id))).toBe(true);
      expect(set.has(String(pen._id))).toBe(false);
    });
  });
});
