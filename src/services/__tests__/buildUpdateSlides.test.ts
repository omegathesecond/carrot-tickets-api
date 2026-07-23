import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Update } from '@models/update.model';
import { UpdateService } from '@services/update.service';

describe('UpdateService.buildUpdateSlides', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('hydrates buyer author + defaults viewer flags when no actor', async () => {
    const author = await Buyer.create({ phone: '+26878000001', password: 'secret1', name: 'Sipho', username: 'sipho' });
    const u = await Update.create({ authorType: 'buyer', authorId: author._id, kind: 'image', caption: 'hi', media: { rawKey: 'k', status: 'ready', image: { url: 'https://cdn/i.jpg', width: 1, height: 1 } } });
    const [slide] = await UpdateService.buildUpdateSlides([u], null);
    expect(slide.type).toBe('update');
    expect(slide.author).toMatchObject({ type: 'buyer', name: 'Sipho', username: 'sipho' });
    expect(slide.viewerReactions).toEqual({ liked: false, saved: false });
    expect(slide.viewerIsAuthor).toBe(false);
  });
});
