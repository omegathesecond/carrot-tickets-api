import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { BandBinding } from '@models/bandBinding.model';

const eventId = new mongoose.Types.ObjectId();
const walletId = new mongoose.Types.ObjectId();

describe('BandBinding model', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('records a live binding with boundAt set and unboundAt absent', async () => {
    const b = await BandBinding.create({ walletId, eventId, bandUid: 'AABBCC01' });
    expect(b.boundAt).toBeInstanceOf(Date);
    expect(b.unboundAt).toBeUndefined();
  });

  it('keeps history: the same UID may appear many times once unbound', async () => {
    await BandBinding.create({
      walletId, eventId, bandUid: 'AABBCC01',
      unboundAt: new Date(), unboundReason: 'lost',
    });
    await BandBinding.create({ walletId, eventId, bandUid: 'AABBCC01' });
    expect(await BandBinding.countDocuments({ bandUid: 'AABBCC01' })).toBe(2);
  });

  it('requires walletId, eventId and bandUid', async () => {
    await expect(BandBinding.create({ eventId, bandUid: 'X' })).rejects.toThrow(/walletId/);
  });
});
