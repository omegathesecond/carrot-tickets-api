import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventReaction } from '@models/eventReaction.model';
import { SavedContentService } from '@services/savedContent.service';

describe('SavedContentService.savedEventIds', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const buyerId = () => new mongoose.Types.ObjectId().toString();

  it('returns events the buyer saved (type:save), not events they only liked', async () => {
    const buyer = buyerId();
    const savedEvent = new mongoose.Types.ObjectId();
    const likedOnlyEvent = new mongoose.Types.ObjectId();

    await EventReaction.create({ eventId: savedEvent, buyerId: buyer, actorType: 'buyer', type: 'save' });
    await EventReaction.create({ eventId: likedOnlyEvent, buyerId: buyer, actorType: 'buyer', type: 'like' });

    const ids = await SavedContentService.savedEventIds(buyer);
    expect(ids).toEqual([String(savedEvent)]);
  });

  it('returns both saved events even when one of them is ALSO liked by the same buyer', async () => {
    const buyer = buyerId();
    const firstSaved = new mongoose.Types.ObjectId();
    const secondSaved = new mongoose.Types.ObjectId();

    await EventReaction.create({ eventId: firstSaved, buyerId: buyer, actorType: 'buyer', type: 'save' });
    await EventReaction.create({ eventId: secondSaved, buyerId: buyer, actorType: 'buyer', type: 'save' });
    await EventReaction.create({ eventId: secondSaved, buyerId: buyer, actorType: 'buyer', type: 'like' });

    const ids = await SavedContentService.savedEventIds(buyer);
    expect(new Set(ids)).toEqual(new Set([String(firstSaved), String(secondSaved)]));
  });

  it('returns an empty list when the buyer has only liked events, never saved any', async () => {
    const buyer = buyerId();
    await EventReaction.create({ eventId: new mongoose.Types.ObjectId(), buyerId: buyer, actorType: 'buyer', type: 'like' });

    expect(await SavedContentService.savedEventIds(buyer)).toEqual([]);
  });
});
