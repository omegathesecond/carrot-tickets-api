// identical env contract to the API's updatesR2
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: 'auto', endpoint: process.env.UPDATES_R2_ENDPOINT,
  credentials: { accessKeyId: process.env.UPDATES_R2_ACCESS_KEY_ID!, secretAccessKey: process.env.UPDATES_R2_SECRET_ACCESS_KEY! },
});
const bucket = process.env.UPDATES_R2_BUCKET_NAME!;

export async function getObject(key: string): Promise<Buffer> {
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Buffer[] = []; for await (const c of r.Body as any) chunks.push(Buffer.from(c)); return Buffer.concat(chunks);
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export function publicUrl(key: string): string { return `${process.env.UPDATES_R2_PUBLIC_URL}/${key}`; }
