import mongoose from 'mongoose';
import { OnboardingService } from '@services/onboarding.service';
import { Follow } from '@models/follow.model';
import { Update } from '@models/update.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

const actor = { type: 'vendor' as const, id: new mongoose.Types.ObjectId().toHexString() };
describe('independent onboarding permissions', () => {
  beforeEach(() => { jest.spyOn(Vendor, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({ logoUrl: 'logo' }) }) } as never); });
  afterEach(() => jest.restoreAllMocks());
  it.each([[0, 0, false, false], [10, 0, true, false], [9, 3, false, true], [10, 3, true, true], [12, 5, true, true]])(
    '%i follows, %i media', async (follows, media, browse, profiles) => {
      jest.spyOn(Follow, 'countDocuments').mockResolvedValue(follows as never);
      const aggregate = jest.spyOn(Update, 'aggregate').mockResolvedValue(media ? [{ count: media }] : []);
      const result = await OnboardingService.status(actor);
      expect(result).toMatchObject({ followingCount: follows, mediaCount: media, canBrowse: browse, canViewProfiles: profiles });
      expect(Follow.countDocuments).toHaveBeenCalledWith({ followerType: 'vendor', followerId: actor.id, targetType: 'buyer' });
      const pipeline = aggregate.mock.calls[0]![0]!;
      expect(pipeline).toContainEqual({ $unwind: '$media' });
      expect(pipeline[0]).toEqual({ $match: { authorType: 'vendor', authorId: new mongoose.Types.ObjectId(actor.id), status: 'active' } });
    },
  );
  it('checks existing buyers using the same thresholds', async () => {
    jest.spyOn(Follow, 'countDocuments').mockResolvedValue(10 as never);
    jest.spyOn(Update, 'aggregate').mockResolvedValue([{ count: 3 }]);
    jest.spyOn(Buyer, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({ username: 'existing' }) }) } as never);
    expect(await OnboardingService.status({ ...actor, type: 'buyer' })).toMatchObject({ username: 'existing', canBrowse: true, canViewProfiles: true });
  });
  it('propagates database errors', async () => {
    jest.spyOn(Follow, 'countDocuments').mockRejectedValue(new Error('database unavailable'));
    jest.spyOn(Update, 'aggregate').mockResolvedValue([]);
    await expect(OnboardingService.status(actor)).rejects.toThrow('database unavailable');
  });
});
