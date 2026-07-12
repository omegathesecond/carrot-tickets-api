import { updatesR2 } from '@utils/updatesR2';

describe('updatesR2 helpers (pure)', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, UPDATES_R2_PUBLIC_URL: 'https://cdn.carrottickets.com' }; });
  afterEach(() => { process.env = OLD; });

  it('builds a public URL from a key', () => {
    expect(updatesR2.publicUrl('updates/ready/abc.mp4')).toBe('https://cdn.carrottickets.com/updates/ready/abc.mp4');
  });

  it('builds a raw key under updates/raw with the given extension', () => {
    const k = updatesR2.rawKey('mp4');
    expect(k).toMatch(/^updates\/raw\/\d+-[a-z0-9]+\.mp4$/);
  });
});
