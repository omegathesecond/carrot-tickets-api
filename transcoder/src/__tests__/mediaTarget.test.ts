import { mediaPathPrefix, renditionKeyPrefix, readyUpdateOps, failedUpdateOps } from '../mediaTarget';

const video = { url: 'https://cdn/a/720.mp4', url480: 'https://cdn/a/480.mp4', poster: 'https://cdn/a/poster.jpg', width: 720, height: 1280, durationSec: 12 };

describe('mediaPathPrefix', () => {
  it('is media.0 for updates (Update.media is an array)', () => {
    expect(mediaPathPrefix('updates')).toBe('media.0');
  });
  it('is media for stories (Story.media is a single embedded doc)', () => {
    expect(mediaPathPrefix('stories')).toBe('media');
  });
});

describe('renditionKeyPrefix', () => {
  it('namespaces R2 keys by collection so updates/ and stories/ never collide', () => {
    expect(renditionKeyPrefix('updates', 'abc123')).toBe('updates/ready/abc123');
    expect(renditionKeyPrefix('stories', 'abc123')).toBe('stories/ready/abc123');
  });
});

describe('readyUpdateOps', () => {
  it('writes Update.media.0.status/video for the updates collection', () => {
    expect(readyUpdateOps('updates', video)).toEqual({ 'media.0.status': 'ready', 'media.0.video': video });
  });
  it('writes Story.media.status/video for the stories collection', () => {
    expect(readyUpdateOps('stories', video)).toEqual({ 'media.status': 'ready', 'media.video': video });
  });
});

describe('failedUpdateOps', () => {
  it('writes Update.media.0.status/error for the updates collection', () => {
    expect(failedUpdateOps('updates', 'boom')).toEqual({ 'media.0.status': 'failed', 'media.0.error': 'boom' });
  });
  it('writes Story.media.status/error for the stories collection', () => {
    expect(failedUpdateOps('stories', 'boom')).toEqual({ 'media.status': 'failed', 'media.error': 'boom' });
  });
});
