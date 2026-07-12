import { buildRenditionArgs, buildProbeArgs, parseProbe } from '../ffmpeg';

describe('buildRenditionArgs', () => {
  it('builds 720p H.264 faststart args', () => {
    const args = buildRenditionArgs('/tmp/in.mov', '/tmp/720.mp4', 1280);
    expect(args).toEqual(expect.arrayContaining(['-i', '/tmp/in.mov', '-vf', 'scale=-2:1280', '-c:v', 'libx264', '-movflags', '+faststart', '/tmp/720.mp4']));
  });
});

describe('buildProbeArgs', () => {
  it('builds ffprobe args requesting width/height/duration as json', () => {
    const args = buildProbeArgs('/tmp/720.mp4');
    expect(args).toEqual([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-show_entries', 'format=duration',
      '-of', 'json',
      '/tmp/720.mp4',
    ]);
  });
});

describe('parseProbe', () => {
  it('parses ffprobe json output into width/height/durationSec', () => {
    const json = JSON.stringify({ streams: [{ width: 720, height: 1280 }], format: { duration: '12.5' } });
    expect(parseProbe(json)).toEqual({ width: 720, height: 1280, durationSec: 13 });
  });

  it('defaults durationSec to 0 when format.duration is absent', () => {
    const json = JSON.stringify({ streams: [{ width: 480, height: 854 }], format: {} });
    expect(parseProbe(json)).toEqual({ width: 480, height: 854, durationSec: 0 });
  });
});
