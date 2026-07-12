import { buildRenditionArgs } from '../ffmpeg';

describe('buildRenditionArgs', () => {
  it('builds 720p H.264 faststart args', () => {
    const args = buildRenditionArgs('/tmp/in.mov', '/tmp/720.mp4', 1280);
    expect(args).toEqual(expect.arrayContaining(['-i', '/tmp/in.mov', '-vf', 'scale=-2:1280', '-c:v', 'libx264', '-movflags', '+faststart', '/tmp/720.mp4']));
  });
});
