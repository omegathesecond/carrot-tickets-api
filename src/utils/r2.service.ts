import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let r2Client: S3Client | null = null;

/**
 * Initialize R2 client lazily
 * R2 is Cloudflare's S3-compatible object storage
 */
/**
 * Resolve the R2 S3-compatible endpoint.
 *
 * Cloud Run wires the account id (R2_ACCOUNT_ID) rather than a full endpoint,
 * so derive the canonical `https://<account>.r2.cloudflarestorage.com` URL when
 * R2_ENDPOINT is absent. A literal R2_ENDPOINT (if ever set) still wins. Without
 * this, getR2Client() threw "Missing required R2 environment variables:
 * R2_ENDPOINT" on every upload — i.e. R2 was non-functional in production.
 */
function resolveR2Endpoint(): string | undefined {
  const explicit = process.env['R2_ENDPOINT'];
  if (explicit) return explicit;
  const accountId = process.env['R2_ACCOUNT_ID'];
  if (accountId) return `https://${accountId}.r2.cloudflarestorage.com`;
  return undefined;
}

function getR2Client(): S3Client {
  if (!r2Client) {
    // R2_ENDPOINT or R2_ACCOUNT_ID satisfies the endpoint requirement.
    const endpoint = resolveR2Endpoint();
    const requiredEnvVars = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (!endpoint) missingVars.unshift('R2_ENDPOINT (or R2_ACCOUNT_ID)');

    if (missingVars.length > 0) {
      throw new Error(`Missing required R2 environment variables: ${missingVars.join(', ')}`);
    }

    r2Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: process.env['R2_ACCESS_KEY_ID']!,
        secretAccessKey: process.env['R2_SECRET_ACCESS_KEY']!,
      },
    });
  }
  return r2Client;
}

/**
 * R2Service - Cloudflare R2 storage service for Keshless Tickets media
 *
 * Handles upload, delete, and management of event media files:
 * - Event posters
 * - Event thumbnails
 * - Gallery images
 * - QR codes
 *
 * Folder structure: events/{eventId}/{mediaType}/{filename}
 * Example: events/EVT-123/poster/1234567890-concert-poster.jpg
 */
export class R2Service {
  /**
   * Generate a unique media key for R2 storage
   * Adds timestamp prefix and sanitizes filename
   */
  static generateMediaKey(folder: string, fileName: string): string {
    const timestamp = Date.now();
    const sanitizedFileName = `${timestamp}-${fileName.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    return `${folder}/${sanitizedFileName}`;
  }

  /**
   * Generate a presigned URL for direct client-side upload
   * Useful for large files or progress tracking
   */
  static async generatePresignedUrl(folder: string, fileName: string, contentType: string): Promise<{ key: string; url: string }> {
    const key = this.generateMediaKey(folder, fileName);
    const command = new PutObjectCommand({
      Bucket: process.env['R2_BUCKET_NAME']!,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(getR2Client(), command, { expiresIn: 3600 });
    return { key, url };
  }

  /**
   * Upload a buffer directly to R2
   * Used for server-side uploads (e.g., via Multer)
   */
  static async uploadBufferToR2(key: string, buffer: Buffer, contentType: string, abortSignal?: AbortSignal): Promise<any> {
    const command = new PutObjectCommand({
      Bucket: process.env['R2_BUCKET_NAME']!,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    });
    const response = await getR2Client().send(command, abortSignal ? { abortSignal } : undefined);
    return response;
  }

  /**
   * List all media files in a folder
   * Useful for getting all images for an event
   */
  static async listMedia(folder: string): Promise<any[]> {
    const command = new ListObjectsV2Command({
      Bucket: process.env['R2_BUCKET_NAME']!,
      Prefix: `${folder}/`,
    });
    const data = await getR2Client().send(command);
    return data.Contents || [];
  }

  /**
   * Delete a media file from R2
   */
  static async deleteMedia(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: process.env['R2_BUCKET_NAME']!,
      Key: key,
    });
    await getR2Client().send(command);
  }

  /**
   * Get the public URL for a media file
   * This URL can be accessed directly by clients
   * If R2_PUBLIC_URL is not configured, returns the key path
   */
  static getPublicUrl(key: string): string {
    const publicUrl = process.env['R2_PUBLIC_URL'];
    if (!publicUrl) {
      console.warn('R2_PUBLIC_URL not configured, returning key path only');
      return key; // Return just the key, URL can be updated later
    }
    return `${publicUrl}/${key}`;
  }

  /**
   * Generate event-specific folder path
   * @param eventId - Event ID
   * @param mediaType - Type of media (poster, thumbnail, gallery, qrcode)
   */
  static getEventMediaFolder(eventId: string, mediaType: 'poster' | 'thumbnail' | 'gallery' | 'qrcode'): string {
    return `events/${eventId}/${mediaType}`;
  }

  /**
   * Upload event media and return public URL
   * @param eventId - Event ID
   * @param mediaType - Type of media
   * @param fileName - Original filename
   * @param buffer - File buffer
   * @param contentType - MIME type
   */
  static async uploadEventMedia(
    eventId: string,
    mediaType: 'poster' | 'thumbnail' | 'gallery' | 'qrcode',
    fileName: string,
    buffer: Buffer,
    contentType: string
  ): Promise<{ key: string; url: string }> {
    const folder = this.getEventMediaFolder(eventId, mediaType);
    const key = this.generateMediaKey(folder, fileName);

    await this.uploadBufferToR2(key, buffer, contentType);
    const url = this.getPublicUrl(key);

    return { key, url };
  }

  /**
   * Upload an arbitrary buffer to a given folder and return its public URL.
   * Generic counterpart to uploadEventMedia for non-event-media artifacts
   * (e.g. generated ticket PDFs). Key = {folder}/{timestamp}-{fileName}.
   */
  static async uploadFile(
    folder: string,
    fileName: string,
    buffer: Buffer,
    contentType: string
  ): Promise<{ key: string; url: string }> {
    const key = this.generateMediaKey(folder, fileName);
    await this.uploadBufferToR2(key, buffer, contentType);
    return { key, url: this.getPublicUrl(key) };
  }

  /**
   * Delete event media by URL
   * Extracts the key from the public URL and deletes it
   * If URL doesn't contain public domain, assumes it's already a key
   */
  static async deleteEventMediaByUrl(url: string): Promise<void> {
    const publicUrl = process.env['R2_PUBLIC_URL'];
    let key = url;

    // If public URL is configured and the url starts with it, extract the key
    if (publicUrl && url.startsWith(publicUrl)) {
      key = url.replace(`${publicUrl}/`, '');
    }

    await this.deleteMedia(key);
  }
}
