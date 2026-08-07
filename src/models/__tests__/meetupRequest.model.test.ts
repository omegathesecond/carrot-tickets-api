import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { MeetupRequest } from '@models/meetupRequest.model';
import { Types } from 'mongoose';

describe('MeetupRequest model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await MeetupRequest.init(); // build indexes so the unique constraint is enforced
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('defaults status to pending and stores the directed pair', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    const row = await MeetupRequest.create({ requesterId: a, targetId: b });
    expect(row.status).toBe('pending');
    expect(row.respondedAt).toBeUndefined();
    expect(String(row.requesterId)).toBe(String(a));
  });

  it('enforces one row per (requester, target) direction', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    await MeetupRequest.create({ requesterId: a, targetId: b });
    await expect(MeetupRequest.create({ requesterId: a, targetId: b })).rejects.toMatchObject({ code: 11000 });
    // reverse direction is a different edge and allowed
    await expect(MeetupRequest.create({ requesterId: b, targetId: a })).resolves.toBeTruthy();
  });
});
