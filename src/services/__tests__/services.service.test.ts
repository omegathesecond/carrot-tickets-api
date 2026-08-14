import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ServicesService } from '@services/services.service';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function mkBiz(over: any = {}) {
  return Vendor.create({
    businessName: over.businessName ?? 'Luxe Decor', phoneNumber: over.phoneNumber ?? '+2687650' + Math.floor(Math.random()*100000),
    password: 'secret1', operatorType: OperatorType.SERVICES, serviceCategory: over.serviceCategory ?? 'furniture_decor',
    verificationStatus: over.verificationStatus ?? VerificationStatus.VERIFIED, bio: over.bio ?? 'Elegant furniture & styling',
    address: over.address, startingPrice: over.startingPrice,
  });
}

describe('ServicesService.listDirectory', () => {
  it('lists only verified active services vendors', async () => {
    await mkBiz({ businessName: 'Verified Co' });
    await mkBiz({ businessName: 'Pending Co', verificationStatus: VerificationStatus.PENDING });
    await Vendor.create({ businessName: 'Event Org', phoneNumber: '+26876999001', password: 'secret1', operatorType: OperatorType.EVENTS, verificationStatus: VerificationStatus.VERIFIED });
    const cards = await ServicesService.listDirectory({});
    const names = cards.map((c) => c.businessName);
    expect(names).toContain('Verified Co');
    expect(names).not.toContain('Pending Co');
    expect(names).not.toContain('Event Org');
  });

  it('filters by category and searches by name', async () => {
    await mkBiz({ businessName: 'SoundWave', serviceCategory: 'sound_hire' });
    await mkBiz({ businessName: 'FoodFest', serviceCategory: 'food_stalls' });
    expect((await ServicesService.listDirectory({ category: 'sound_hire' })).map((c) => c.businessName)).toEqual(['SoundWave']);
    expect((await ServicesService.listDirectory({ search: 'food' })).map((c) => c.businessName)).toEqual(['FoodFest']);
  });

  it('does not throw on a regex-metacharacter search term, and matches it literally', async () => {
    await mkBiz({ businessName: 'A(B) Events' });
    const cards = await ServicesService.listDirectory({ search: 'a(' });
    expect(cards.map((c) => c.businessName)).toEqual(['A(B) Events']);
  });
});

describe('ServicesService.getBusinessProfile', () => {
  it('returns the profile for a verified services vendor', async () => {
    const v = await mkBiz({ startingPrice: { amountCents: 18000, unit: 'day' }, address: { city: 'Manzini', region: 'Manzini' } });
    const p = await ServicesService.getBusinessProfile(String(v._id));
    expect(p.businessName).toBe('Luxe Decor');
    expect(p.serviceCategory).toBe('furniture_decor');
    expect(p.startingPrice?.amountCents).toBe(18000);
    expect(p.city).toBe('Manzini');
    expect(p.verified).toBe(true);
  });

  it('404s for an events vendor', async () => {
    const v = await Vendor.create({ businessName: 'Org', phoneNumber: '+26876999002', password: 'secret1', operatorType: OperatorType.EVENTS, verificationStatus: VerificationStatus.VERIFIED });
    await expect(ServicesService.getBusinessProfile(String(v._id))).rejects.toMatchObject({ statusCode: 404 });
  });
});
