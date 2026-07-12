import { spawn } from 'child_process';

export function buildRenditionArgs(input: string, output: string, targetHeight: number): string[] {
  return [
    '-y', '-i', input,
    '-vf', `scale=-2:${targetHeight}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    output,
  ];
}

export function buildPosterArgs(input: string, output: string): string[] {
  return ['-y', '-ss', '0', '-i', input, '-frames:v', '1', '-q:v', '3', output];
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))));
    p.on('error', reject);
  });
}

export function buildProbeArgs(input: string): string[] {
  return ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', input];
}

export function runProbe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-500)}`))));
    p.on('error', reject);
  });
}

export function parseProbe(json: string): { width: number; height: number; durationSec: number } {
  const parsed = JSON.parse(json);
  const stream = (parsed.streams && parsed.streams[0]) || {};
  const duration = parsed.format && parsed.format.duration ? Number(parsed.format.duration) : 0;
  return {
    width: stream.width,
    height: stream.height,
    durationSec: Math.round(duration || 0),
  };
}
