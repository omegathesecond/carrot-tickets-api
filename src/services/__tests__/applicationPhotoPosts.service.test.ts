import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Update } from '@models/update.model';
import { publishApplicationPhotos } from '@services/applicationPhotoPosts.service';
import { postCandidates } from '@services/activityFeed/sources';
import { getFeed } from '@services/feed.service';
import { UpdateController } from '@controllers/update.controller';

describe('application photo posts', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);
  it('makes ordinary feed and profile posts, without duplicates or restoring removed posts', async () => {
    const buyer = await Buyer.create({ email: 'application-photo@example.com', password: 'secret6' });
    const photos = ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'];
    const date = new Date('2026-01-01');
    await publishApplicationPhotos('buyer', buyer._id, photos, date);
    await publishApplicationPhotos('buyer', buyer._id, photos, date);
    const posts = await Update.find({ authorId: buyer._id }).sort({ _id: 1 });
    expect(posts).toHaveLength(2);
    expect(posts.map(p => p.media[0]?.image?.url).sort()).toEqual(photos);
    const feed = await postCandidates({ limit: 20 });
    expect(feed.candidates.map(c => c.sourceId)).toEqual(expect.arrayContaining(posts.map(p => String(p._id))));
    const response: any = { req: { originalUrl: '/updates' }, status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await UpdateController.listByAuthor({ params: { authorType: 'buyer', authorId: String(buyer._id) }, query: {} } as any, response);
    expect(response.json.mock.calls[0][0].data.items).toHaveLength(2);
    await Update.updateOne({ _id: posts[0]!._id }, { $set: { status: 'removed' } });
    await publishApplicationPhotos('buyer', buyer._id, photos, date);
    expect((await Update.findById(posts[0]!._id))!.status).toBe('removed');
  });
  it('pages every photo from one application through the profile and Home feed', async () => {
    const buyer = await Buyer.create({ email: 'pagination@example.com', password: 'secret6' });
    const photos = Array.from({ length: 30 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    await publishApplicationPhotos('buyer', buyer._id, photos, new Date('2026-01-01'));
    const expected = (await Update.find({ authorId: buyer._id })).map(p => String(p._id)).sort();
    const profileIds: string[] = [];
    let cursor: string | null = null;
    do {
      const response: any = { req: { originalUrl: '/updates' }, status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      await UpdateController.listByAuthor({ params: { authorType: 'buyer', authorId: String(buyer._id) }, query: cursor ? { cursor } : {} } as any, response);
      const data = response.json.mock.calls[0][0].data;
      profileIds.push(...data.items.map((item: any) => item.id));
      cursor = data.nextCursor;
    } while (cursor);
    expect(profileIds.sort()).toEqual(expected);

    const feedIds: string[] = [];
    cursor = null;
    do {
      const page = await getFeed({ tab: 'for-you', limit: 4, cursor: cursor ?? undefined });
      feedIds.push(...page.items.filter(item => item.type === 'update').map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(feedIds.sort()).toEqual(expected);
  });

});
