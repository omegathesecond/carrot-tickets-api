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
