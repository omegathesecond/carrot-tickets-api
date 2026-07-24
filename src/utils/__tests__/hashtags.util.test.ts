import { extractHashtags } from '@utils/hashtags.util';

describe('extractHashtags', () => {
  it('extracts multiple hashtags from a caption', () => {
    expect(extractHashtags('Great show tonight #Music #Live')).toEqual(['music', 'live']);
  });

  it('lowercases each tag', () => {
    expect(extractHashtags('#EDM #HipHop')).toEqual(['edm', 'hiphop']);
  });

  it('dedupes tags preserving first-seen order', () => {
    expect(extractHashtags('#Music #music #MUSIC #art')).toEqual(['music', 'art']);
  });

  it('strips the leading # from stored tags', () => {
    const tags = extractHashtags('#party');
    expect(tags).toEqual(['party']);
    expect(tags[0]?.startsWith('#')).toBe(false);
  });

  it('caps at 10 tags', () => {
    const caption = Array.from({ length: 15 }, (_, i) => `#tag${i}`).join(' ');
    expect(extractHashtags(caption)).toHaveLength(10);
    expect(extractHashtags(caption)).toEqual(['tag0', 'tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6', 'tag7', 'tag8', 'tag9']);
  });

  it('returns [] for an empty caption', () => {
    expect(extractHashtags('')).toEqual([]);
  });

  it('returns [] for a null/undefined caption', () => {
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags(undefined)).toEqual([]);
  });

  it('ignores a tag longer than 50 chars', () => {
    const longTag = '#' + 'a'.repeat(60);
    expect(extractHashtags(`${longTag} #short`)).toEqual(['short']);
  });

  it('returns [] when caption has no hashtags', () => {
    expect(extractHashtags('just a normal caption')).toEqual([]);
  });
});
