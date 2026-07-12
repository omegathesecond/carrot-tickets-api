import express from 'express';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getObject, putObject, publicUrl } from './r2';
import { buildRenditionArgs, buildPosterArgs, runFfmpeg } from './ffmpeg';
import { connect, Update } from './db';

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.post('/transcode', async (req, res) => {
  if (req.header('x-transcoder-secret') !== process.env.TRANSCODER_SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { updateId, rawKey } = req.body || {};
  if (!updateId || !rawKey) return res.status(400).json({ error: 'updateId and rawKey required' });
  res.status(202).json({ accepted: true });          // ack immediately; work continues async
  process.nextTick(() => transcode(updateId, rawKey).catch((e) => console.error('transcode job failed:', e?.message)));
});

async function transcode(updateId: string, rawKey: string): Promise<void> {
  await connect();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-'));
  const input = path.join(dir, 'in');
  try {
    await fs.writeFile(input, await getObject(rawKey));
    const p720 = path.join(dir, '720.mp4'); const p480 = path.join(dir, '480.mp4'); const pj = path.join(dir, 'poster.jpg');
    await runFfmpeg(buildRenditionArgs(input, p720, 1280));
    await runFfmpeg(buildRenditionArgs(input, p480, 854));
    await runFfmpeg(buildPosterArgs(input, pj));
    const k720 = `updates/ready/${updateId}/720.mp4`, k480 = `updates/ready/${updateId}/480.mp4`, kp = `updates/ready/${updateId}/poster.jpg`;
    await putObject(k720, await fs.readFile(p720), 'video/mp4');
    await putObject(k480, await fs.readFile(p480), 'video/mp4');
    await putObject(kp, await fs.readFile(pj), 'image/jpeg');
    await Update.updateOne({ _id: updateId }, { $set: {
      'media.status': 'ready',
      'media.video': { url: publicUrl(k720), url480: publicUrl(k480), poster: publicUrl(kp), width: 720, height: 1280, durationSec: 0 },
    } });
  } catch (err: any) {
    await Update.updateOne({ _id: updateId }, { $set: { 'media.status': 'failed', 'media.error': err?.message?.slice(0, 400) || 'transcode failed' } });
    throw err;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`transcoder on :${port}`));
