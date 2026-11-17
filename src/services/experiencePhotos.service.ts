import { MarketProfile } from '../marketplace/models';

export async function getExperiencePhotos(ownerId: string) {
  const profiles = await MarketProfile.find({ ownerId, 'experiencePhotos.0': { $exists: true } })
    .select('businessName experiencePhotos').lean();
  return profiles.map(p => ({ businessName: p.businessName || '', photos: p.experiencePhotos || [] }));
}
