import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

let client: S3Client | null = null;
function getClient(): S3Client {
  if (client) return client;
  const required = ['UPDATES_R2_ENDPOINT', 'UPDATES_R2_ACCESS_KEY_ID', 'UPDATES_R2_SECRET_ACCESS_KEY', 'UPDATES_R2_BUCKET_NAME'];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length) throw new Error(`Missing required updates-R2 env vars: ${missing.join(', ')}`);
  client = new S3Client({
    region: 'auto',
    endpoint: process.env['UPDATES_R2_ENDPOINT']!,
    credentials: {
      accessKeyId: process.env['UPDATES_R2_ACCESS_KEY_ID']!,
      secretAccessKey: process.env['UPDATES_R2_SECRET_ACCESS_KEY']!,
    },
  });
  return client;
}
function bucket(): string { return process.env['UPDATES_R2_BUCKET_NAME']!; }

export const updatesR2 = {
  rawKey(ext: string): string {
    const clean = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    return `updates/raw/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${clean}`;
  },
  readyKey(id: string, name: string): string { return `updates/ready/${id}/${name}`; },
  async presignPut(key: string, contentType: string): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType });
    return getSignedUrl(getClient(), cmd, { expiresIn: 3600 });
  },
  publicUrl(key: string): string {
    const base = process.env['UPDATES_R2_PUBLIC_URL'];
    if (!base) throw new Error('UPDATES_R2_PUBLIC_URL not configured');
    return `${base}/${key}`;
  },
  async putBuffer(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await getClient().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buffer, ContentType: contentType }));
  },
  async getObjectBuffer(key: string): Promise<Buffer> {
    const res = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const chunks: Buffer[] = [];
    for await (const c of res.Body as any) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  },
};
