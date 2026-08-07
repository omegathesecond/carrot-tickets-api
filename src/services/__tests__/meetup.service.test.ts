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

  it('listIncoming returns hydrated requester rows by status; cancel removes a pending row', async () => {
    const me = (await mk('+26878422613', 'me_one')) as IBuyer;
    const target = (await mk('+26878000001', 'target_a')) as IBuyer;
    const { id } = await MeetupService.request(me, String(target._id));
    const pending = await MeetupService.listIncoming(target, 'pending');
    expect(pending).toHaveLength(1);
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
});
