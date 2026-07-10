import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { NotificationService } from '@services/notification.service';

const PHONE = '+26878422613';

describe('notification inbox', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seed() {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', username: 'inbox_user' });
    return { buyer, auth: `Bearer ${signBuyerToken(PHONE)}` };
  }

  it('lists newest first with unreadCount; marks selected and all read', async () => {
    const { buyer, auth } = await seed();
    // non-null: this path never hits the event_reminder dedupe branch, so create() always returns a doc here.
    const first = (await NotificationService.create(String(buyer._id), 'dm', 'Alpha', 'sent you a message', { threadId: 'x' }))!;
    await NotificationService.create(String(buyer._id), 'friend', 'Beta', 'you are now friends', { buyerId: 'y' });
    await NotificationService.create(String(buyer._id), 'announcement', 'Gates', 'open 18:00', { eventId: 'z' });

    let res = await request(app).get('/api/social/notifications').set('Authorization', auth).expect(200);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.items.map((n: any) => n.type)).toEqual(['announcement', 'friend', 'dm']);
    expect(res.body.data.unreadCount).toBe(3);
    expect(res.body.data.items[2].read).toBe(false);

    await request(app).post('/api/social/notifications/read').set('Authorization', auth)
      .send({ ids: [String(first._id)] }).expect(200);
    res = await request(app).get('/api/social/notifications').set('Authorization', auth).expect(200);
    expect(res.body.data.unreadCount).toBe(2);
    expect(res.body.data.items.find((n: any) => n.id === String(first._id)).read).toBe(true);

    await request(app).post('/api/social/notifications/read').set('Authorization', auth).send({}).expect(200);
    res = await request(app).get('/api/social/notifications').set('Authorization', auth).expect(200);
    expect(res.body.data.unreadCount).toBe(0);
  });

  it('cursor pagination + isolation between buyers + auth required', async () => {
    const { buyer, auth } = await seed();
    for (let i = 0; i < 3; i++) {
      await NotificationService.create(String(buyer._id), 'dm', `T${i}`, 'b', {});
    }
    const other = await Buyer.create({ phone: '+26878000042', password: 'secret1' });
    await NotificationService.create(String(other._id), 'dm', 'not-yours', 'b', {});

    const page1 = await request(app).get('/api/social/notifications?limit=2').set('Authorization', auth).expect(200);
    expect(page1.body.data.items).toHaveLength(2);
    const page2 = await request(app)
      .get(`/api/social/notifications?limit=2&before=${page1.body.data.items[1].id}`)
      .set('Authorization', auth).expect(200);
    expect(page2.body.data.items).toHaveLength(1);
    expect(page2.body.data.items[0].title).toBe('T0');

    await request(app).get('/api/social/notifications?before=nope').set('Authorization', auth).expect(400);
    await request(app).get('/api/social/notifications').expect(401);

    // marking the other buyer's notification must be a no-op for me
    const theirs = await NotificationService.list(other as any, {});
    await request(app).post('/api/social/notifications/read').set('Authorization', auth)
      .send({ ids: [theirs.items[0]!.id] }).expect(200);
    expect((await NotificationService.list(other as any, {})).unreadCount).toBe(1);
  });

  it('empty ids array is a no-op; malformed ids are 400', async () => {
    const { buyer, auth } = await seed();
    await NotificationService.create(String(buyer._id), 'dm', 'T', 'b', {});

    await request(app).post('/api/social/notifications/read').set('Authorization', auth)
      .send({ ids: [] }).expect(200);
    const res = await request(app).get('/api/social/notifications').set('Authorization', auth).expect(200);
    expect(res.body.data.unreadCount).toBe(1); // untouched

    await request(app).post('/api/social/notifications/read').set('Authorization', auth)
      .send({ ids: ['not-hex'] }).expect(400);
    await request(app).post('/api/social/notifications/read').set('Authorization', auth)
      .send({ ids: 'nope' }).expect(400);
  });
});
